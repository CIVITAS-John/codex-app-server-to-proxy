import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type {
  JsonRpcTransport,
  ServerRequest,
} from "../app-server/json-rpc.js";
import {
  toolCorrelationErrorForStatus,
  type HttpError,
} from "../http/errors.js";
import {
  bindingHash,
  canonicalJson,
  record as asRecord,
} from "../core/canonical.js";
import {
  tokenUsageCounters,
  type TokenUsageCounters,
} from "../core/token-usage.js";

export { bindingHash, canonicalJson };

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
  /** Marks records written after reasoning effort became an exact binding. */
  reasoningEffortBound?: true;
  responseId: string;
  threadId: string;
  // `corrupt` is a fail-closed persisted sentinel retained for compatibility and
  // future corruption marking even though current writes do not assign it.
  state: "ready" | "pending_tool" | "expired" | "superseded" | "corrupt";
  createdAt: number;
  expiresAt: number;
  callIds?: string[];
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
    private readonly temporaryPath: (
      statePath: string,
    ) => string = defaultTemporaryPath,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    hardenStatePath(directory, "directory");
    this.#path = join(directory, "continuations.json");
    hardenExistingStateFile(this.#path);
    this.#sweepStaleTemporaries(directory);
    this.#load();
  }

  /** Removes temporaries stranded by a crash between write and atomic rename. */
  #sweepStaleTemporaries(directory: string): void {
    const prefix = `${basename(this.#path)}.`;
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) continue;
      try {
        unlinkSync(join(directory, entry));
      } catch {
        // A concurrent writer may still hold this temporary; leave it in place.
      }
    }
  }

  /** Retrieves a record after applying expiry and newest-response rules. */
  get(responseId: string): ResponseRecord | undefined {
    const record = this.#records.get(responseId);
    if (
      record &&
      record.expiresAt <= Date.now() &&
      record.state !== "expired"
    ) {
      this.#mutateAndSave(() => {
        record.state = "expired";
      });
    }
    return record;
  }

  /** Inserts a record and supersedes the prior completed response for its thread. */
  put(record: Omit<ResponseRecord, "createdAt" | "expiresAt">): ResponseRecord {
    const now = Date.now();
    const stored = {
      ...record,
      // Absence identifies ambiguous records written by pre-upgrade releases.
      reasoningEffortBound: true as const,
      createdAt: now,
      expiresAt: now + this.retentionMs,
    };
    this.#mutateAndSave(() => {
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
    });
    return stored;
  }

  /** Changes an existing record without exposing partial disk writes. */
  update(
    responseId: string,
    patch: Partial<ResponseRecord>,
  ): ResponseRecord | undefined {
    const current = this.#records.get(responseId);
    if (!current) return undefined;
    const updated = {
      ...current,
      ...patch,
      responseId: current.responseId,
      threadId: current.threadId,
    };
    this.#mutateAndSave(() => {
      this.#records.set(responseId, updated);
    });
    return updated;
  }

  /** Finds durable records containing every requested dynamic-tool call ID. */
  findByCallIds(callIds: readonly string[]): ResponseRecord[] {
    const requested = new Set(callIds);
    return [...this.#records.values()].filter(
      (record) =>
        record.callIds !== undefined &&
        [...requested].every((id) => record.callIds!.includes(id)),
    );
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
      // Legacy pending records predate persisted call metadata and relied on a
      // process-local responder, so only their safe tombstone can survive.
      // Records carrying pendingCalls are fully durable and load unchanged.
      for (const record of this.#records.values())
        if (record.state === "pending_tool" && !record.pendingCalls?.length)
          record.state = "expired";
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
    const temporary = this.temporaryPath(this.#path);
    try {
      writeFileSync(
        temporary,
        JSON.stringify({
          version: SCHEMA_VERSION,
          records: [...this.#records.values()],
        }),
        {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        },
      );
      renameSync(temporary, this.#path);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // The write may have failed before creating its private temporary file.
      }
      throw error;
    }
  }

  /** Commits a mutation durably or restores the exact prior in-memory view. */
  #mutateAndSave(mutate: () => void): void {
    const snapshot = new Map(
      [...this.#records].map(([id, record]) => [id, { ...record }]),
    );
    try {
      mutate();
      this.#save();
    } catch (error) {
      this.#records.clear();
      for (const [id, record] of snapshot) this.#records.set(id, record);
      throw error;
    }
  }
}

/** Creates an unpredictable same-directory path for one atomic state write. */
function defaultTemporaryPath(statePath: string): string {
  return `${statePath}.${process.pid}.${randomUUID()}.tmp`;
}

/** Tightens and validates the state directory on platforms with POSIX modes. */
function hardenStatePath(path: string, kind: "directory" | "file"): void {
  const before = lstatSync(path);
  if (
    before.isSymbolicLink() ||
    (kind === "directory" ? !before.isDirectory() : !before.isFile())
  )
    throw new Error(`Continuation state ${kind} must be a regular ${kind}.`);
  if (process.platform === "win32") return;
  chmodSync(path, kind === "directory" ? 0o700 : 0o600);
  const after = lstatSync(path);
  const unsafe = kind === "directory" ? 0o077 : 0o177;
  if ((after.mode & unsafe) !== 0)
    throw new Error(`Continuation state ${kind} permissions are too broad.`);
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
    const owner = this.#toolOwners.get(params.threadId);
    if (!owner) {
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
   * Atomically claims a thread and installs its sole dynamic-tool callback
   * owner. The returned lease is the only authority that can release both.
   */
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
        // Disposal may have already cleared both structures. Otherwise only
        // the lease's exact callback can release this ownership generation.
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
      callIds,
      pendingCalls: calls,
    });
  }

  /**
   * Persists the exact cumulative boundary the continuation must subtract from.
   * A tool-call response that observed no usage persists the boundary it
   * started from, so the model requests behind the tool calls are attributed
   * by the continuation instead of being lost. The pending mapping itself is
   * already durable, so this best-effort update never reports failure: a
   * disposed generation or a mapping that already left `pending_tool` simply
   * forgoes the boundary.
   */
  recordPendingUsage(
    responseId: string,
    usageTotal: TokenUsageCounters | undefined,
  ): void {
    // An all-zero boundary is a legal, meaningful value — a fresh thread that
    // parked before app-server attributed anything. Only the absent object
    // may be skipped; never test a counter's value for truthiness here.
    if (this.#disposed || !usageTotal) return;
    this.#updateBestEffort(responseId, "pending_tool", { usageTotal });
  }

  /**
   * Durably makes a pending batch non-replayable before injection. Losing the
   * result to a crash between this write and injection is safer than allowing
   * an unknowable or completed injection to be repeated.
   */
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
  }
}

/** Validates every persisted field before a record can influence continuation. */
function isResponseRecord(value: unknown): value is ResponseRecord {
  const record = asRecord(value);
  if (!record) return false;
  const allowedKeys = new Set([
    "responseId",
    "threadId",
    "state",
    "model",
    "reasoningEffort",
    "reasoningEffortBound",
    "cwd",
    "toolsHash",
    "policyHash",
    "createdAt",
    "expiresAt",
    "callIds",
    "pendingCalls",
    "usageTotal",
  ]);
  const validStates = new Set([
    "ready",
    "pending_tool",
    "expired",
    "superseded",
    "corrupt",
  ]);
  const validHash = (hash: unknown): hash is string =>
    typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash);
  const callIds = record.callIds;
  const pendingCalls = record.pendingCalls;
  const isStoredToolCall = (value: unknown): value is StoredToolCall => {
    const call = asRecord(value);
    return (
      call !== undefined &&
      Object.keys(call).every((key) =>
        ["callId", "name", "arguments"].includes(key),
      ) &&
      typeof call.callId === "string" &&
      call.callId.length > 0 &&
      typeof call.name === "string" &&
      call.name.length > 0 &&
      typeof call.arguments === "string"
    );
  };
  // pendingCalls must agree with callIds so the implicit call-ID lookup and
  // the injected pairs can never disagree about which calls are pending.
  const pendingCallsValid =
    pendingCalls === undefined ||
    (Array.isArray(pendingCalls) &&
      pendingCalls.length > 0 &&
      pendingCalls.every((call) => isStoredToolCall(call)) &&
      Array.isArray(callIds) &&
      pendingCalls.length === callIds.length &&
      new Set(pendingCalls.map((call) => (call as StoredToolCall).callId))
        .size === pendingCalls.length &&
      pendingCalls.every((call) =>
        (callIds as string[]).includes((call as StoredToolCall).callId),
      ));
  return (
    pendingCallsValid &&
    Object.keys(record).every((key) => allowedKeys.has(key)) &&
    typeof record.responseId === "string" &&
    record.responseId.length > 0 &&
    typeof record.threadId === "string" &&
    record.threadId.length > 0 &&
    typeof record.model === "string" &&
    record.model.length > 0 &&
    (record.reasoningEffort === undefined ||
      (typeof record.reasoningEffort === "string" &&
        record.reasoningEffort.length > 0)) &&
    (record.reasoningEffortBound === undefined ||
      record.reasoningEffortBound === true) &&
    (record.usageTotal === undefined ||
      tokenUsageCounters(record.usageTotal) !== undefined) &&
    typeof record.cwd === "string" &&
    record.cwd.length > 0 &&
    validHash(record.toolsHash) &&
    validHash(record.policyHash) &&
    typeof record.state === "string" &&
    validStates.has(record.state) &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt) &&
    typeof record.expiresAt === "number" &&
    Number.isFinite(record.expiresAt) &&
    (callIds === undefined ||
      (Array.isArray(callIds) &&
        callIds.every((id) => typeof id === "string") &&
        new Set(callIds).size === callIds.length))
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
