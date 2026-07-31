import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  JsonRpcTransport,
  ServerRequest,
} from "../app-server/json-rpc.js";
import {
  toolCorrelationErrorForStatus,
  type HttpError,
} from "../http/errors.js";
import { record as asRecord } from "../core/canonical.js";
import {
  tokenUsageCounters,
  type TokenUsageCounters,
} from "../core/token-usage.js";

/** Current on-disk continuation-store schema for the unreleased format. */
const SCHEMA_VERSION = 0;

/** Context that must remain identical over a Codex thread's lifetime. */
export interface ThreadBinding {
  model: string;
  reasoningEffort?: string;
  cwd: string;
  toolsHash: string;
  policyHash: string;
}

/** Durable metadata for one dynamic tool call awaiting its client result. */
export interface StoredToolCall {
  callId: string;
  name: string;
  /** JSON-stringified arguments, byte-identical to what the response emitted. */
  arguments: string;
}

/** One opaque response-to-thread record persisted by the proxy. */
export interface ResponseRecord extends ThreadBinding {
  responseId: string;
  threadId: string;
  state: "ready" | "pending_tool" | "expired" | "superseded";
  createdAt: number;
  expiresAt: number;
  /**
   * Full call metadata for a `pending_tool` record. The continuation rebuilds
   * the `function_call`/`function_call_output` pairs it injects from this, so
   * a pending record survives proxy restarts with nothing process-local.
   */
  pendingCalls?: StoredToolCall[];
  /** Latest exact cumulative app-server total at this response boundary. */
  usageTotal?: TokenUsageCounters;
}

/** Durable atomic response mapping store with bounded retention. */
export class ResponseStore {
  readonly #path: string;
  readonly #records = new Map<string, ResponseRecord>();

  constructor(
    directory: string,
    private readonly retentionMs = 30 * 24 * 60 * 60_000,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    hardenStatePath(directory, "directory");
    this.#path = join(directory, "continuations.json");
    hardenExistingStateFile(this.#path);
    this.#load();
  }

  /** Retrieves a record with retention expiry applied to the returned view. */
  get(responseId: string): ResponseRecord | undefined {
    const record = this.#records.get(responseId);
    // Retention expiry is derived, so a read never writes. The persisted
    // `expired` state remains the durable pre-injection replay tombstone.
    if (record && record.state !== "expired" && record.expiresAt <= Date.now())
      return { ...record, state: "expired" };
    return record;
  }

  /** Inserts a record and supersedes the prior completed response for its thread. */
  put(record: Omit<ResponseRecord, "createdAt" | "expiresAt">): ResponseRecord {
    const now = Date.now();
    const stored = {
      ...record,
      createdAt: now,
      expiresAt: now + this.retentionMs,
    };
    // Superseding pending_tool here is defense in depth behind the durable
    // pre-injection replay guard: no completed continuation may leave an
    // older pending record selectable for the same thread.
    for (const prior of this.#records.values()) {
      if (
        prior.threadId === record.threadId &&
        (prior.state === "ready" || prior.state === "pending_tool")
      )
        prior.state = "superseded";
    }
    this.#records.set(stored.responseId, stored);
    this.#prune(now);
    this.#save();
    return stored;
  }

  /** Changes an existing record without exposing partial disk writes. */
  update(
    responseId: string,
    patch: Partial<ResponseRecord>,
  ): ResponseRecord | undefined {
    const current = this.#records.get(responseId);
    if (!current) return undefined;
    const updated = { ...current, ...patch };
    this.#records.set(responseId, updated);
    this.#save();
    return updated;
  }

  /** Reports whether a live pending-tool batch is recorded for one thread. */
  hasPendingToolForThread(threadId: string): boolean {
    for (const record of this.#records.values())
      if (record.threadId === threadId && record.state === "pending_tool")
        return true;
    return false;
  }

  /** Finds durable records containing every requested dynamic-tool call ID. */
  findByCallIds(callIds: readonly string[]): ResponseRecord[] {
    const requested = new Set(callIds);
    return [...this.#records.values()].filter((record) => {
      const stored = record.pendingCalls?.map((call) => call.callId);
      return (
        stored !== undefined &&
        [...requested].every((id) => stored.includes(id))
      );
    });
  }

  /** Loads valid records and quarantines an unreadable store logically as empty. */
  #load(): void {
    try {
      const input = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
      const parsed = asRecord(input);
      if (!parsed) return;
      const records =
        parsed.version === SCHEMA_VERSION && Array.isArray(parsed.records)
          ? parsed.records
          : undefined;
      // Other schemas are left untouched and treated as untrusted. There is no
      // compatibility path because this on-disk format has not been released.
      if (!records) return;
      for (const record of records)
        if (isResponseRecord(record))
          this.#records.set(record.responseId, { ...record });
      this.#prune(Date.now());
      this.#save();
    } catch {
      // Missing or corrupt state cannot be trusted for continuation.
    }
  }

  /** Drops records older than the configured retention horizon. */
  #prune(now: number): void {
    for (const [id, record] of this.#records)
      if (record.expiresAt + this.retentionMs < now) this.#records.delete(id);
  }

  /** Replaces the state file atomically so abrupt termination preserves the old file. */
  #save(): void {
    const temporary = `${this.#path}.tmp`;
    try {
      writeFileSync(
        temporary,
        JSON.stringify({
          version: SCHEMA_VERSION,
          records: [...this.#records.values()],
        }),
        { encoding: "utf8", mode: 0o600 },
      );
      renameSync(temporary, this.#path);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // The write may have failed before creating its temporary file.
      }
      throw error;
    }
  }
}

/** Tightens and validates the state directory on platforms with POSIX modes. */
function hardenStatePath(path: string, kind: "directory" | "file"): void {
  const stats = lstatSync(path);
  if (
    stats.isSymbolicLink() ||
    (kind === "directory" ? !stats.isDirectory() : !stats.isFile())
  )
    throw new Error(`Continuation state ${kind} must be a regular ${kind}.`);
  if (process.platform === "win32") return;
  chmodSync(path, kind === "directory" ? 0o700 : 0o600);
}

/** Secures an existing state file without creating an empty replacement. */
function hardenExistingStateFile(path: string): void {
  try {
    hardenStatePath(path, "file");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return;
    throw error;
  }
}

/** One in-flight app-server dynamic tool call within an active turn's batch. */
export interface PendingToolCall {
  request: ServerRequest;
  callId: string;
  name: string;
  arguments: unknown;
  threadId: string;
  turnId: string;
}

/** Exclusive ownership of one thread and its dynamic-tool callback route. */
export interface ThreadLease {
  readonly threadId: string;
  release(): void;
}

/** Coordinates durable mappings, thread ownership, and tool-call routing. */
export class ContinuationCoordinator {
  readonly #busy = new Set<string>();
  readonly #toolOwners = new Map<string, (request: PendingToolCall) => void>();
  readonly #interruptedToolTurns = new Set<string>();
  #disposed = false;

  constructor(
    readonly store: ResponseStore,
    private readonly rpc: JsonRpcTransport,
  ) {
    this.rpc.on("request", this.#routeToolRequest);
    this.rpc.once("close", this.#detachRouter);
  }

  /** Detaches the fail-closed router once no more frames can arrive. */
  readonly #detachRouter = (): void => {
    this.rpc.off("request", this.#routeToolRequest);
  };

  /** Rejects one request while allowing disposal to survive transport closure. */
  #failRequestReplaced(id: string | number): void {
    try {
      this.rpc.respondError(id, {
        code: -32000,
        message: "App-server transport is being replaced",
      });
    } catch {
      // A concurrently closed transport has already failed the request.
    }
  }

  /** Applies nonessential record bookkeeping without failing completed work. */
  #updateBestEffort(
    responseId: string,
    expectedState: ResponseRecord["state"],
    patch: Partial<ResponseRecord>,
  ): void {
    try {
      const record = this.store.get(responseId);
      if (!record || record.state !== expectedState) return;
      this.store.update(responseId, patch);
    } catch {
      // The caller has already completed the operation this bookkeeping describes.
    }
  }

  /** Routes one dynamic-tool callback to the sole owner of its thread. */
  readonly #routeToolRequest = (request: ServerRequest): void => {
    if (request.method !== "item/tool/call") return;
    if (this.#disposed) {
      this.#failRequestReplaced(request.id);
      return;
    }
    const params = asRecord(request.params);
    if (
      !params ||
      typeof params.threadId !== "string" ||
      typeof params.turnId !== "string" ||
      typeof params.callId !== "string" ||
      typeof params.tool !== "string" ||
      (params.namespace !== undefined && params.namespace !== null)
    ) {
      this.rpc.respondError(request.id, {
        code: -32602,
        message: "Invalid dynamic tool request",
      });
      return;
    }
    if (
      this.#interruptedToolTurns.has(
        interruptedToolTurnKey(params.threadId, params.turnId),
      )
    )
      return;
    const owner = this.#toolOwners.get(params.threadId);
    if (!owner) {
      // A late call from an interrupted thread belongs to its pending batch:
      // app-server already cancelled it, so answering would only be logged
      // there as an error. Anything else is a real correlation failure that
      // app-server is still waiting on.
      if (!this.store.hasPendingToolForThread(params.threadId))
        this.rpc.respondError(request.id, {
          code: -32602,
          message: "Dynamic tool correlation mismatch",
        });
      return;
    }
    owner({
      request,
      callId: params.callId,
      name: params.tool,
      arguments: params.arguments,
      threadId: params.threadId,
      turnId: params.turnId,
    });
  };

  /**
   * Remembers a cancelled turn so its late dynamic callbacks stay unanswered.
   * This relies on app-server never reusing a turn identifier within one
   * thread and transport generation: a repeated identifier would silently
   * discard the live calls of the turn that reused it. The set is cleared on
   * every transport replacement, and each entry costs one interrupted tool
   * turn to create, so it needs no eviction bound.
   */
  markTurnInterrupted(threadId: string, turnId: string): void {
    if (this.#disposed) return;
    this.#interruptedToolTurns.add(interruptedToolTurnKey(threadId, turnId));
  }

  /** Atomically claims a thread and installs its dynamic-tool owner. */
  acquireThread(
    threadId: string,
    owner: (request: PendingToolCall) => void,
  ): ThreadLease | undefined {
    if (this.#disposed)
      throw new Error("Continuation coordinator is disposed.");
    if (this.#busy.has(threadId) || this.#toolOwners.has(threadId))
      return undefined;
    this.#busy.add(threadId);
    this.#toolOwners.set(threadId, owner);
    let released = false;
    return {
      threadId,
      release: (): void => {
        if (released) return;
        released = true;
        // Only this lease may release the current ownership generation.
        if (this.#toolOwners.get(threadId) !== owner) return;
        this.#toolOwners.delete(threadId);
        this.#busy.delete(threadId);
      },
    };
  }

  /** Durably records an interrupted turn's tool batch awaiting client results. */
  recordPendingTool(
    responseId: string,
    threadId: string,
    binding: ThreadBinding,
    calls: StoredToolCall[],
  ): void {
    if (this.#disposed)
      throw new Error("Continuation coordinator is disposed.");
    const callIds = calls.map((call) => call.callId);
    if (calls.length === 0 || new Set(callIds).size !== callIds.length)
      throw new Error(
        "Pending dynamic tool call IDs must be nonempty and unique.",
      );
    this.store.put({
      responseId,
      threadId,
      state: "pending_tool",
      ...binding,
      pendingCalls: calls,
    });
  }

  /** Persists the best-effort usage boundary for a pending batch. */
  recordPendingUsage(
    responseId: string,
    usageTotal: TokenUsageCounters | undefined,
  ): void {
    // Zero is valid; only an absent boundary skips the update.
    if (this.#disposed || !usageTotal) return;
    this.#updateBestEffort(responseId, "pending_tool", { usageTotal });
  }

  /** Tombstones a pending batch before injection to prevent replay. */
  protectPendingFromReplay(responseId: string): void {
    const record = this.store.get(responseId);
    if (!record || record.state !== "pending_tool")
      throw new Error(
        "Pending dynamic tool continuation is no longer available.",
      );
    if (!this.store.update(responseId, { state: "expired" }))
      throw new Error(
        "Pending dynamic tool continuation could not be protected.",
      );
  }

  /** Records successful injection without weakening the durable replay guard. */
  recordPendingConsumed(responseId: string): void {
    this.#updateBestEffort(responseId, "expired", { state: "superseded" });
  }

  /** Resolves stored pending tool IDs to exactly one unexpired response. */
  findPendingResponse(callIds: readonly string[]): string {
    const requested = new Set(callIds);
    if (requested.size !== callIds.length)
      throw toolLookupFailure(400, "duplicate_tool_call_id");
    // findByCallIds does not apply expiry; check expiresAt explicitly so a
    // stale record surfaces as the 410 tombstone rather than a live match.
    const now = Date.now();
    const candidates = this.store.findByCallIds(callIds);
    const matches = candidates.filter(
      (record) => record.state === "pending_tool" && record.expiresAt > now,
    );
    if (matches.length === 0) {
      const tombstones = candidates.filter(
        (record) =>
          record.state === "expired" ||
          (record.state === "pending_tool" && record.expiresAt <= now),
      );
      if (tombstones.length === 1)
        throw toolLookupFailure(410, "expired_tool_continuation");
      if (tombstones.length > 1)
        throw toolLookupFailure(409, "ambiguous_tool_call_id");
      throw toolLookupFailure(404, "unknown_tool_call_id");
    }
    if (matches.length > 1)
      throw toolLookupFailure(409, "ambiguous_tool_call_id");
    return matches[0]!.responseId;
  }

  /** Records a completed response only while this transport generation is current. */
  recordReady(
    responseId: string,
    threadId: string,
    binding: ThreadBinding,
    usageTotal?: TokenUsageCounters,
  ): boolean {
    if (this.#disposed) return false;
    this.store.put({
      responseId,
      threadId,
      state: "ready",
      ...binding,
      // Object truthiness only: an all-zero boundary must persist like any
      // other, or the next response would lose the requests behind it.
      ...(usageTotal ? { usageTotal } : {}),
    });
    return true;
  }

  /** Detaches routing and ownership before transport replacement. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // Keep the router installed in fail-closed mode until the transport closes.
    // Pending tool records are durable and need no per-responder cleanup.
    this.#toolOwners.clear();
    this.#busy.clear();
    this.#interruptedToolTurns.clear();
  }
}

/** Builds an unambiguous process-local key for one interrupted Codex turn. */
function interruptedToolTurnKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId]);
}

/** Persisted lifecycle states a loaded record may declare. */
const VALID_RECORD_STATES = new Set([
  "ready",
  "pending_tool",
  "expired",
  "superseded",
]);

/**
 * Checks the shape of one loaded record. This process is the file's only
 * writer, so the check is deliberately shallow: it confirms the fields
 * continuation actually reads, and validates `usageTotal` and `pendingCalls`
 * because those feed token arithmetic and injected thread history. Unknown
 * fields are preserved rather than rejected so a record written by a newer
 * version stays loadable.
 */
function isResponseRecord(value: unknown): value is ResponseRecord {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record.responseId === "string" &&
    record.responseId.length > 0 &&
    typeof record.threadId === "string" &&
    record.threadId.length > 0 &&
    typeof record.model === "string" &&
    typeof record.cwd === "string" &&
    typeof record.toolsHash === "string" &&
    typeof record.policyHash === "string" &&
    typeof record.state === "string" &&
    VALID_RECORD_STATES.has(record.state) &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt) &&
    typeof record.expiresAt === "number" &&
    Number.isFinite(record.expiresAt) &&
    (record.usageTotal === undefined ||
      tokenUsageCounters(record.usageTotal) !== undefined) &&
    (record.pendingCalls === undefined ||
      (Array.isArray(record.pendingCalls) &&
        record.pendingCalls.length > 0 &&
        record.pendingCalls.every(isStoredToolCall) &&
        new Set(record.pendingCalls.map((call) => call.callId)).size ===
          record.pendingCalls.length)) &&
    (record.state !== "pending_tool" || record.pendingCalls !== undefined)
  );
}

/** Checks one persisted dynamic call, which a continuation injects verbatim. */
function isStoredToolCall(value: unknown): value is StoredToolCall {
  const call = asRecord(value);
  return (
    call !== undefined &&
    typeof call.callId === "string" &&
    call.callId.length > 0 &&
    typeof call.name === "string" &&
    typeof call.arguments === "string"
  );
}

/** Builds an OpenAI-shaped failure for implicit tool-call correlation. */
function toolLookupFailure(status: number, code: string): HttpError {
  return toolCorrelationErrorForStatus(
    status,
    "The tool result could not be correlated to one pending call.",
    code,
    "tool_call_id",
  );
}
