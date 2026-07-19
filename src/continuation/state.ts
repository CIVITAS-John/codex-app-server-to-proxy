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
      for (const prior of this.#records.values()) {
        if (prior.threadId === record.threadId && prior.state === "ready")
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
      // A responder cannot survive process restart; retain only its safe tombstone.
      for (const record of this.#records.values())
        if (record.state === "pending_tool") record.state = "expired";
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

/** In-memory responder for one suspended app-server dynamic tool call. */
export interface PendingToolCall {
  request: ServerRequest;
  callId: string;
  name: string;
  arguments: unknown;
  threadId: string;
  turnId: string;
}

/** Coordinates durable mappings, thread ownership, and ephemeral tool responders. */
export class ContinuationCoordinator {
  readonly #pending = new Map<
    string,
    { calls: PendingToolCall[]; timer: NodeJS.Timeout }
  >();
  readonly #busy = new Set<string>();
  readonly #toolOwners = new Map<string, (request: PendingToolCall) => void>();
  #disposed = false;

  constructor(
    readonly store: ResponseStore,
    private readonly rpc: JsonRpcTransport,
    private readonly toolTimeoutMs: number,
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

  /** Installs the sole dynamic-tool callback owner for a claimed thread. */
  setToolOwner(
    threadId: string,
    owner: (request: PendingToolCall) => void,
  ): boolean {
    if (this.#disposed)
      throw new Error("Continuation coordinator is disposed.");
    if (this.#toolOwners.has(threadId)) return false;
    this.#toolOwners.set(threadId, owner);
    return true;
  }

  /** Removes a dynamic-tool callback owner if it is still the expected owner. */
  clearToolOwner(
    threadId: string,
    owner: (request: PendingToolCall) => void,
  ): void {
    if (this.#toolOwners.get(threadId) === owner)
      this.#toolOwners.delete(threadId);
  }

  /** Claims exclusive use of a thread, returning false rather than queueing. */
  claim(threadId: string): boolean {
    if (this.#busy.has(threadId)) return false;
    this.#busy.add(threadId);
    return true;
  }

  /** Releases exclusive use unless a suspended tool call still owns the thread. */
  release(threadId: string): void {
    if (
      ![...this.#pending.values()].some(
        (entry) => entry.calls[0]?.threadId === threadId,
      )
    )
      this.#busy.delete(threadId);
  }

  /** Persists and keeps the responder for a dynamic-tool suspension. */
  suspend(
    responseId: string,
    binding: ThreadBinding,
    calls: PendingToolCall[],
  ): void {
    if (this.#disposed)
      throw new Error("Continuation coordinator is disposed.");
    const threadId = calls[0]!.threadId;
    this.#toolOwners.delete(threadId);
    this.store.put({
      responseId,
      threadId,
      state: "pending_tool",
      ...binding,
      callIds: calls.map((call) => call.callId),
    });
    const timer = setTimeout(() => {
      for (const call of calls) {
        try {
          this.rpc.respondError(call.request.id, {
            code: -32002,
            message: "Dynamic tool result timed out",
          });
        } catch {
          // Transport failure must not escape a timer callback.
        }
      }
      this.#pending.delete(responseId);
      this.#busy.delete(threadId);
      this.store.update(responseId, { state: "expired" });
    }, this.toolTimeoutMs);
    timer.unref();
    this.#pending.set(responseId, { calls, timer });
  }

  /** Returns the live suspension, distinguishing restart tombstones from unknown IDs. */
  pending(responseId: string): PendingToolCall[] | undefined {
    return this.#pending.get(responseId)?.calls;
  }

  /** Restarts the deadline for one live suspension selected by a request. */
  refreshPending(responseId: string): boolean {
    const entry = this.#pending.get(responseId);
    if (!entry) return false;
    entry.timer.refresh();
    return true;
  }

  /** Resolves live pending tool IDs to exactly one suspended response. */
  findPendingResponse(callIds: readonly string[]): string {
    const requested = new Set(callIds);
    if (requested.size !== callIds.length)
      throw toolLookupFailure(400, "duplicate_tool_call_id");
    const matches = [...this.#pending.entries()].filter(([, entry]) =>
      [...requested].every((id) =>
        entry.calls.some((call) => call.callId === id),
      ),
    );
    if (matches.length === 0) {
      const tombstones = this.store
        .findByCallIds(callIds)
        .filter((record) => record.state === "expired");
      if (tombstones.length === 1)
        throw toolLookupFailure(410, "expired_tool_continuation");
      if (tombstones.length > 1)
        throw toolLookupFailure(409, "ambiguous_tool_call_id");
      throw toolLookupFailure(404, "unknown_tool_call_id");
    }
    if (matches.length > 1)
      throw toolLookupFailure(409, "ambiguous_tool_call_id");
    return matches[0]![0];
  }

  /** Answers pending calls in deterministic call order and consumes the suspension. */
  resolve(
    responseId: string,
    results: Map<string, string>,
  ): PendingToolCall[] | undefined {
    const entry = this.#pending.get(responseId);
    if (!entry) return undefined;
    const threadId = entry.calls[0]!.threadId;
    // Consume before writing any response so a partial transport failure cannot
    // leave a timerless suspension that may replay already-written results.
    this.#pending.delete(responseId);
    clearTimeout(entry.timer);
    try {
      for (const call of entry.calls) {
        this.rpc.respond(call.request.id, {
          contentItems: [
            { type: "inputText", text: results.get(call.callId)! },
          ],
          success: true,
        });
      }
    } catch (error) {
      // Some earlier responses may already be on the wire. Expire the whole
      // batch and release ownership; retrying it could duplicate those results.
      this.#busy.delete(threadId);
      this.store.update(responseId, { state: "expired" });
      throw error;
    }
    this.store.update(responseId, { state: "superseded" });
    return entry.calls;
  }

  /** Records a completed response only while this transport generation is current. */
  recordReady(
    responseId: string,
    threadId: string,
    binding: ThreadBinding,
  ): boolean {
    if (this.#disposed) return false;
    this.store.put({ responseId, threadId, state: "ready", ...binding });
    return true;
  }

  /** Cancels ephemeral responders and detaches routing before transport replacement. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // Keep the router installed in fail-closed mode until the transport closes.
    this.#toolOwners.clear();
    this.#busy.clear();
    for (const [responseId, entry] of this.#pending) {
      clearTimeout(entry.timer);
      for (const call of entry.calls)
        this.#failRequestReplaced(call.request.id);
      this.store.update(responseId, { state: "expired" });
    }
    this.#pending.clear();
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
  return (
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
