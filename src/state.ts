import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonRpcTransport, ServerRequest } from "./json-rpc.js";
import { HttpError } from "./errors.js";

/** Current on-disk continuation-store schema. */
const SCHEMA_VERSION = 1;

/** Context that must remain identical over a Codex thread's lifetime. */
export interface ThreadBinding {
  model: string;
  cwd: string;
  toolsHash: string;
  policyHash: string;
}

/** One opaque response-to-thread record persisted by the proxy. */
export interface ResponseRecord extends ThreadBinding {
  responseId: string;
  threadId: string;
  state: "ready" | "pending_tool" | "expired" | "superseded" | "corrupt";
  createdAt: number;
  expiresAt: number;
  callIds?: string[];
}

/** Legacy schema migrated in place when first opened by the current proxy. */
interface LegacyStateFile {
  version: 0;
  mappings: ResponseRecord[];
}

/** Canonicalizes JSON values so equivalent tool definitions hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Returns a stable SHA-256 binding for a JSON-compatible value. */
export function bindingHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
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
    this.#path = join(directory, "continuations.json");
    this.#load();
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
          : parsed.version === 0 && Array.isArray(parsed.mappings)
            ? (input as LegacyStateFile).mappings
            : undefined;
      // Unknown future schemas are left untouched and treated as untrusted.
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
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({
        version: SCHEMA_VERSION,
        records: [...this.#records.values()],
      }),
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    renameSync(temporary, this.#path);
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

  /** Routes one dynamic-tool callback to the sole owner of its thread. */
  readonly #routeToolRequest = (request: ServerRequest): void => {
    if (request.method !== "item/tool/call") return;
    if (this.#disposed) {
      try {
        this.rpc.respondError(request.id, {
          code: -32000,
          message: "App-server transport is being replaced",
        });
      } catch {
        // A concurrently closed transport has already failed the request.
      }
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
      for (const call of entry.calls) {
        try {
          this.rpc.respondError(call.request.id, {
            code: -32000,
            message: "App-server transport is being replaced",
          });
        } catch {
          // A concurrent close has already failed the suspended request.
        }
      }
      this.store.update(responseId, { state: "expired" });
    }
    this.#pending.clear();
  }
}

/** Narrows an unknown value to a non-null object record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Validates every persisted field before a record can influence continuation. */
function isResponseRecord(value: unknown): value is ResponseRecord {
  const record = asRecord(value);
  if (!record) return false;
  const validStates = new Set([
    "ready",
    "pending_tool",
    "expired",
    "superseded",
    "corrupt",
  ]);
  return (
    typeof record.responseId === "string" &&
    typeof record.threadId === "string" &&
    typeof record.model === "string" &&
    typeof record.cwd === "string" &&
    typeof record.toolsHash === "string" &&
    typeof record.policyHash === "string" &&
    typeof record.state === "string" &&
    validStates.has(record.state) &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt) &&
    typeof record.expiresAt === "number" &&
    Number.isFinite(record.expiresAt) &&
    (record.callIds === undefined ||
      (Array.isArray(record.callIds) &&
        record.callIds.every((id) => typeof id === "string")))
  );
}

/** Builds an OpenAI-shaped failure for implicit tool-call correlation. */
function toolLookupFailure(status: number, code: string): HttpError {
  return new HttpError(
    status,
    "The tool result could not be correlated to one pending call.",
    status === 409 ? "conflict_error" : "invalid_request_error",
    code,
    "tool_call_id",
  );
}
