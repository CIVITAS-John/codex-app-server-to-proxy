import type { JsonRpcTransport } from "../app-server/json-rpc.js";
import { record } from "../core/canonical.js";
import type { Logger } from "../core/logger.js";
import {
  policyBindingHash,
  type EffectivePolicy,
  type PolicyRequirements,
} from "../core/policy.js";
import {
  bindingHash,
  type ContinuationCoordinator,
  type PendingToolCall,
  type ThreadBinding,
} from "../continuation/state.js";
import {
  diagnoseUnexposedNotification,
  EventNormalizer,
  isEstablishedUnrelatedNotification,
  matchesTurn,
  notificationBehavior,
  type NormalizedEvent,
  type Usage,
} from "./chat-normalize.js";
import {
  toHistoryItem,
  validateToolResults,
  type ChatRequest,
} from "./chat-validate.js";
import { HttpError } from "./errors.js";

/** Maximum buffered app-server activity retained for one HTTP response. */
const MAX_INGRESS_EVENTS = 1_024;

/** Maximum approximate JSON bytes retained in one response's ingress queue. */
const MAX_INGRESS_BYTES = 8 * 1024 * 1024;

/** One arrival-ordered app-server notification or dynamic tool request. */
type IngressEvent =
  | { type: "notification"; method: string; params: unknown }
  | { type: "dynamic_tool"; call: PendingToolCall };

/** One queued ingress event with the retained byte size computed at enqueue. */
interface QueuedIngress {
  event: IngressEvent;
  bytes: number;
}

/** Owns bounded request ingress and its wake and failure state. */
class IngressQueue {
  readonly #ingress: QueuedIngress[] = [];
  #ingressBytes = 0;
  #wake: (() => void) | undefined;
  #queueError: Error | undefined;
  #transportError: Error | undefined;
  readonly #rejectDynamicCall: (call: PendingToolCall) => void;

  constructor(rejectDynamicCall: (call: PendingToolCall) => void) {
    this.#rejectDynamicCall = rejectDynamicCall;
  }

  /** Reports whether no retained event is ready for consumption. */
  get empty(): boolean {
    return this.#ingress.length === 0;
  }

  /** Returns the next retained event without consuming it. */
  peek(): IngressEvent | undefined {
    return this.#ingress[0]?.event;
  }

  /** Retains one event within the count and approximate-byte limits. */
  enqueue(event: IngressEvent): void {
    if (this.#queueError) {
      if (event.type === "dynamic_tool") this.#rejectDynamicCall(event.call);
      return;
    }
    const eventBytes = approximateJsonBytes(event);
    if (
      this.#ingress.length >= MAX_INGRESS_EVENTS ||
      this.#ingressBytes + eventBytes > MAX_INGRESS_BYTES
    ) {
      this.#queueError = new Error("App-server activity queue overflowed.");
      if (event.type === "dynamic_tool") this.#rejectDynamicCall(event.call);
      this.notify();
      return;
    }
    this.#ingress.push({ event, bytes: eventBytes });
    this.#ingressBytes += eventBytes;
    this.notify();
  }

  /** Records a terminal transport failure and wakes the consumer. */
  failTransport(error: Error): void {
    this.#transportError = error;
    this.notify();
  }

  /** Wakes a consumer currently waiting for ingress or terminal state. */
  notify(): void {
    this.#wake?.();
  }

  /** Throws terminal failures with transport failure taking precedence. */
  assertHealthy(): void {
    if (this.#transportError) throw this.#transportError;
    if (this.#queueError) throw this.#queueError;
  }

  /** Rechecks only overflow before the suspension queue is drained. */
  assertQueueHealthy(): void {
    if (this.#queueError) throw this.#queueError;
  }

  /** Consumes the next retained event and releases its byte budget. */
  shift(): IngressEvent | undefined {
    const next = this.#ingress.shift();
    if (!next) return undefined;
    this.#ingressBytes -= next.bytes;
    return next.event;
  }

  /** Drains all retained events in arrival order and resets byte accounting. */
  drainAll(): IngressEvent[] {
    const captured = this.#ingress.splice(0).map((queued) => queued.event);
    this.#ingressBytes = 0;
    return captured;
  }

  /** Waits until ingress, failure, or abort can advance the consumer. */
  async waitForActivity(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#wake = resolve;
      if (
        this.#ingress.length ||
        this.#queueError ||
        this.#transportError ||
        signal.aborted
      )
        resolve();
    });
    this.#wake = undefined;
  }

  /** Rejects every retained dynamic request during unsuspended cleanup. */
  rejectQueuedDynamicCalls(): void {
    for (const { event } of this.#ingress)
      if (event.type === "dynamic_tool") this.#rejectDynamicCall(event.call);
  }
}

/** Dependencies used by one Chat Completions request. */
export interface ChatHandlerOptions {
  rpc: JsonRpcTransport;
  log: Logger;
  requestId: string;
  signal: AbortSignal;
  continuations: ContinuationCoordinator;
  root: string;
  requirements: PolicyRequirements;
  implicitToolContinuation: boolean;
}

/** One eagerly prepared execution with cleanup independent of generator startup. */
export interface ExecutionSession {
  events: AsyncGenerator<NormalizedEvent>;
  dispose(): Promise<void>;
}

/** Shared mutable lifecycle state for one app-server turn. */
interface TurnHandle {
  threadId?: string;
  turnId?: string;
  terminal: boolean;
  suspended: boolean;
}

/** Runs or resumes a Codex thread and yields its normalized event stream. */
export async function execute(
  request: ChatRequest,
  options: ChatHandlerOptions,
  responseId: string,
): Promise<ExecutionSession> {
  const queue = new IngressQueue((call) => rejectDynamicCall(options, call));
  const handle: TurnHandle = { terminal: false, suspended: false };
  const onNotification = (method: string, params: unknown): void => {
    const behavior = notificationBehavior(method);
    if (behavior === "diagnose") {
      diagnoseUnexposedNotification(method, params, options.rpc, options.log);
      return;
    }
    if (behavior === "ignore") return;
    // Notifications can arrive while thread/start or turn/start is still
    // resolving. Once both identifiers are established, discard unrelated work
    // before it consumes this request's bounded ingress budget.
    if (
      isEstablishedUnrelatedNotification(params, handle.threadId, handle.turnId)
    )
      return;
    const item = record(record(params)?.item);
    if (
      (method === "item/started" || method === "item/completed") &&
      item?.type === "dynamicToolCall"
    ) {
      // The server request is authoritative and carries the responder ID; using
      // notification lifecycle messages would expose the same call twice.
      return;
    }
    queue.enqueue({ type: "notification", method, params });
  };
  const onToolRequest = (toolRequest: PendingToolCall): void => {
    queue.enqueue({ type: "dynamic_tool", call: toolRequest });
  };
  const onClose = (error: Error): void => {
    queue.failTransport(error);
  };
  options.rpc.on("notification", onNotification);
  options.rpc.once("close", onClose);
  let disposed = false;
  const normalizer = new EventNormalizer();
  let continuationResults: Array<{ call: PendingToolCall; content: string }> =
    [];
  const binding: ThreadBinding = {
    model: request.model,
    ...(request.reasoningEffort
      ? { reasoningEffort: request.reasoningEffort }
      : {}),
    cwd: request.policy.cwd,
    toolsHash: bindingHash(request.dynamicTools),
    policyHash: policyBindingHash(request.policy),
  };
  const abort = async (): Promise<void> => {
    if (handle.threadId && handle.turnId && !handle.terminal)
      await options.rpc
        .request("turn/interrupt", {
          threadId: handle.threadId,
          turnId: handle.turnId,
        })
        .catch(() => undefined);
  };
  const onAbort = (): void => {
    // Interrupt is best-effort, but waking the consumer is mandatory: a wedged
    // app-server may never emit the terminal event that previously released it.
    queue.notify();
    void abort();
  };
  const cleanup = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await abort();
    options.signal.removeEventListener("abort", onAbort);
    options.rpc.off("notification", onNotification);
    options.rpc.off("close", onClose);
    if (handle.threadId)
      options.continuations.clearToolOwner(handle.threadId, onToolRequest);
    if (handle.threadId && !handle.suspended)
      options.continuations.release(handle.threadId);
    if (!handle.suspended) queue.rejectQueuedDynamicCalls();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (request.previousResponseId) {
      continuationResults = await resumeContinuation(
        request,
        options,
        binding,
        handle,
        onToolRequest,
      );
    } else {
      await startFreshThread(request, options, handle, onToolRequest);
    }
  } catch (error) {
    // Setup failures occur before HTTP headers, but still must release any
    // ownership acquired by an earlier setup step.
    await cleanup();
    throw error;
  }

  const events =
    (async function* streamExecution(): AsyncGenerator<NormalizedEvent> {
      let failed = false;
      let pendingFinishReason: NormalizedEvent["finishReason"];
      let pendingUsage: Usage | undefined;
      try {
        for (const result of continuationResults)
          yield normalizer.dynamicToolResult(result.call, result.content);
        while (!handle.terminal) {
          queue.assertHealthy();
          // Preserve all already-arrived events. Once they are drained, abort is a
          // terminal wake source even if interrupt fails or the transport wedges.
          if (queue.empty && options.signal.aborted)
            throw new HttpError(
              408,
              "The request timed out or was disconnected.",
              "server_error",
              "request_timeout",
            );
          if (queue.empty) await queue.waitForActivity(options.signal);
          queue.assertHealthy();
          if (queue.peek()?.type === "dynamic_tool") {
            // Let parallel app-server requests arriving in this event-loop turn
            // join the batch before the synchronous suspension handoff.
            await new Promise<void>((resolve) => setImmediate(resolve));
            const captured = suspendCapturedBatch(
              queue,
              options,
              responseId,
              binding,
              handle,
            );
            handle.suspended = true;
            yield* emitCapturedBatch(captured, normalizer, handle);
            yield { finishReason: "tool_calls" };
            handle.terminal = true;
            continue;
          }
          const next = queue.shift();
          if (!next) continue;
          if (next.type === "dynamic_tool") continue;
          if (!matchesTurn(next.params, handle.threadId, handle.turnId))
            continue;
          for (const event of normalizer.normalize(next.method, next.params)) {
            if (event.error) {
              handle.terminal = true;
              failed = true;
              yield event;
            } else if (event.finishReason) {
              // Persistence is part of successful completion. Do not expose a
              // terminal success frame until the continuation can be recorded.
              handle.terminal = true;
              pendingFinishReason = event.finishReason;
            } else if (event.usage) {
              pendingUsage = event.usage;
            } else {
              yield event;
            }
          }
        }
        if (
          !handle.suspended &&
          !failed &&
          handle.threadId &&
          !options.continuations.recordReady(
            responseId,
            handle.threadId,
            binding,
          )
        )
          throw new Error(
            "App-server transport was replaced before completion.",
          );
        if (!failed) {
          if (pendingFinishReason) yield { finishReason: pendingFinishReason };
          if (pendingUsage) yield { usage: pendingUsage };
        }
      } catch (error) {
        // Failures must interrupt the app-server turn before ownership is released;
        // otherwise work could continue without an HTTP consumer.
        await abort();
        // The failed execution is terminal from the proxy's perspective. Mark it
        // before cleanup so the same best-effort interrupt is not sent twice.
        handle.terminal = true;
        throw error;
      } finally {
        await cleanup();
      }
    })();
  return { events, dispose: cleanup };
}

/** Captures and durably suspends the current dynamic-tool batch synchronously. */
function suspendCapturedBatch(
  queue: IngressQueue,
  options: ChatHandlerOptions,
  responseId: string,
  binding: ThreadBinding,
  handle: TurnHandle,
): IngressEvent[] {
  queue.assertQueueHealthy();
  const captured = queue.drainAll();
  const calls = captured
    .filter(
      (event): event is Extract<IngressEvent, { type: "dynamic_tool" }> =>
        event.type === "dynamic_tool",
    )
    .map((event) => event.call);
  if (
    calls.some(
      (call) =>
        call.threadId !== handle.threadId || call.turnId !== handle.turnId,
    )
  ) {
    for (const call of calls)
      options.rpc.respondError(call.request.id, {
        code: -32602,
        message: "Dynamic tool correlation mismatch",
      });
    throw new Error("Dynamic tool request did not match the active turn.");
  }
  try {
    options.continuations.suspend(responseId, binding, calls);
  } catch (error) {
    // Captured calls are no longer in ingress, so this handoff owns rejecting
    // every responder if durable suspension fails.
    for (const call of calls) rejectDynamicCall(options, call);
    throw error;
  }
  return captured;
}

/** Normalizes one captured batch synchronously with the shared normalizer. */
function* emitCapturedBatch(
  captured: IngressEvent[],
  normalizer: EventNormalizer,
  handle: TurnHandle,
): Generator<NormalizedEvent> {
  for (const event of captured) {
    if (event.type === "notification") {
      if (!matchesTurn(event.params, handle.threadId, handle.turnId)) continue;
      yield* normalizer.normalize(event.method, event.params);
      continue;
    }
    yield normalizer.dynamicToolCall(event.call);
  }
}

/** Resumes and validates one durable continuation on the shared turn handle. */
async function resumeContinuation(
  request: ChatRequest,
  options: ChatHandlerOptions,
  binding: ThreadBinding,
  handle: TurnHandle,
  onToolRequest: (toolRequest: PendingToolCall) => void,
): Promise<Array<{ call: PendingToolCall; content: string }>> {
  const stored = options.continuations.store.get(request.previousResponseId!);
  if (!stored) continuationFailure(404, "unknown_previous_response_id");
  if (stored.model !== binding.model)
    continuationFailure(409, "continuation_model_mismatch");
  if (stored.reasoningEffort !== binding.reasoningEffort)
    continuationFailure(409, "continuation_reasoning_effort_mismatch");
  if (stored.cwd !== binding.cwd)
    continuationFailure(409, "continuation_cwd_mismatch");
  if (stored.toolsHash !== binding.toolsHash)
    continuationFailure(409, "continuation_tools_mismatch");
  if (stored.policyHash !== binding.policyHash)
    continuationFailure(409, "continuation_policy_mismatch");

  // Assignment precedes state validation so cleanup retains the original
  // release behavior for every mid-setup continuation failure.
  handle.threadId = stored.threadId;
  if (
    stored.state === "expired" &&
    stored.callIds?.length &&
    request.messages.some((message) => message.role === "tool")
  )
    continuationFailure(410, "expired_tool_continuation");
  if (stored.state === "pending_tool") {
    // A pending response already owns the thread, so this path deliberately
    // installs only the responder and must never claim ownership again.
    if (!request.messages.some((message) => message.role === "tool"))
      continuationFailure(409, "tool_results_required");
    const pending = options.continuations.pending(request.previousResponseId!);
    if (!pending) continuationFailure(410, "expired_tool_continuation");
    const results = validateToolResults(request.messages, pending);
    handle.turnId = pending[0]!.turnId;
    if (!options.continuations.setToolOwner(handle.threadId, onToolRequest))
      continuationFailure(409, "thread_busy");
    const continuationResults = pending.map((call) => ({
      call,
      content: results.get(call.callId)!,
    }));
    options.continuations.resolve(request.previousResponseId!, results);
    return continuationResults;
  }

  if (stored.state === "expired")
    continuationFailure(410, "expired_previous_response_id");
  if (stored.state === "superseded")
    continuationFailure(409, "superseded_previous_response_id");
  if (stored.state !== "ready")
    continuationFailure(500, "corrupt_response_state");
  if (request.messages.at(-1)?.role === "tool")
    continuationFailure(409, "tool_results_without_pending_call");
  acquireThread(handle, options, onToolRequest);

  let resumed: Record<string, unknown>;
  try {
    const read = asRecord(
      await options.rpc.request(
        "thread/read",
        { threadId: handle.threadId, includeTurns: false },
        options.signal,
      ),
      "thread/read",
    );
    const readThread = asRecord(read.thread, "thread/read.thread");
    const status = record(readThread.status)?.type;
    if (status === "active") continuationFailure(409, "thread_busy");
    // Only protocol states that can safely enter thread/resume are accepted.
    // Missing, malformed, and future status values fail closed.
    if (status !== "idle" && status !== "notLoaded")
      continuationFailure(409, "thread_not_resumable");
    resumed = asRecord(
      await options.rpc.request(
        "thread/resume",
        {
          threadId: handle.threadId,
          excludeTurns: true,
          ...threadPolicyParams(request.policy),
        },
        options.signal,
      ),
      "thread/resume",
    );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    continuationFailure(409, "thread_not_resumable");
  }
  const resumedThreadId = requiredId(resumed.thread, "thread/resume.thread");
  // The durable mapping is authoritative. A mismatched resume result must
  // never transfer ownership to, or start work on, an unexpected thread.
  if (resumedThreadId !== handle.threadId)
    continuationFailure(409, "thread_not_resumable");
  await startTurn(request, options, handle);
  return [];
}

/** Starts one fresh durable thread and its initial turn. */
async function startFreshThread(
  request: ChatRequest,
  options: ChatHandlerOptions,
  handle: TurnHandle,
  onToolRequest: (toolRequest: PendingToolCall) => void,
): Promise<void> {
  const started = asRecord(
    await options.rpc.request(
      "thread/start",
      {
        model: request.model,
        ephemeral: false,
        ...threadPolicyParams(request.policy),
        ...(request.dynamicTools.length
          ? { dynamicTools: request.dynamicTools }
          : {}),
      },
      options.signal,
    ),
    "thread/start",
  );
  handle.threadId = requiredId(started.thread, "thread/start.thread");
  acquireThread(handle, options, onToolRequest);
  const prior = request.messages.slice(0, -1).map(toHistoryItem);
  if (prior.length)
    await options.rpc.request(
      "thread/inject_items",
      { threadId: handle.threadId, items: prior },
      options.signal,
    );
  await startTurn(request, options, handle);
}

/** Claims a known thread and installs its dynamic-tool responder. */
function acquireThread(
  handle: TurnHandle,
  options: ChatHandlerOptions,
  onToolRequest: (toolRequest: PendingToolCall) => void,
): void {
  if (!options.continuations.claim(handle.threadId!))
    continuationFailure(409, "thread_busy");
  if (!options.continuations.setToolOwner(handle.threadId!, onToolRequest))
    continuationFailure(409, "thread_busy");
}

/** Starts the next turn and records its validated identifier in place. */
async function startTurn(
  request: ChatRequest,
  options: ChatHandlerOptions,
  handle: TurnHandle,
): Promise<void> {
  const last = request.messages.at(-1)!;
  const turn = asRecord(
    await options.rpc.request(
      "turn/start",
      {
        threadId: handle.threadId,
        model: request.model,
        ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
        // App-server controls reasoning work and exposed summaries separately.
        // Expose detailed summaries by default, but honor an explicit request
        // for no reasoning by disabling its summary as well.
        summary: request.reasoningEffort === "none" ? "none" : "detailed",
        input: [{ type: "text", text: last.content, text_elements: [] }],
        ...turnPolicyParams(request.policy),
      },
      options.signal,
    ),
    "turn/start",
  );
  handle.turnId = requiredId(turn.turn, "turn/start.turn");
}

/** Rejects a dynamic request that cannot be safely retained or suspended. */
function rejectDynamicCall(
  options: ChatHandlerOptions,
  call: PendingToolCall,
): void {
  try {
    options.rpc.respondError(call.request.id, {
      code: -32000,
      message: "Active turn ended before dynamic tool suspension",
    });
  } catch {
    // A closed transport has already made the request unanswerable.
  }
}

/** Builds explicit thread start/resume settings for one effective policy. */
function threadPolicyParams(policy: EffectivePolicy): Record<string, unknown> {
  return {
    cwd: policy.cwd,
    sandbox: policy.sandbox,
    approvalPolicy: policy.approvalPolicy,
    ...(policy.approvalsReviewer
      ? { approvalsReviewer: policy.approvalsReviewer }
      : {}),
    config: { web_search: policy.webSearch },
  };
}

/** Builds sticky turn overrides so prior thread state is never inherited. */
function turnPolicyParams(policy: EffectivePolicy): Record<string, unknown> {
  return {
    cwd: policy.cwd,
    approvalPolicy: policy.approvalPolicy,
    ...(policy.approvalsReviewer
      ? { approvalsReviewer: policy.approvalsReviewer }
      : {}),
    sandboxPolicy: policy.sandboxPolicy,
  };
}

/** Estimates retained ingress size using its JSON representation. */
function approximateJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null");
  } catch {
    return MAX_INGRESS_BYTES + 1;
  }
}

/** Throws the stable OpenAI-shaped error for continuation failures. */
function continuationFailure(status: number, code: string): never {
  throw new HttpError(
    status,
    "The previous response cannot be continued.",
    status >= 500
      ? "server_error"
      : status === 409
        ? "conflict_error"
        : "invalid_request_error",
    code,
    "previous_response_id",
  );
}

/** Requires an app-server response object. */
function asRecord(value: unknown, location: string): Record<string, unknown> {
  const result = record(value);
  if (!result) throw new Error(`Invalid ${location} response.`);
  return result;
}

/** Requires an object with a string identifier in an app-server response. */
function requiredId(value: unknown, location: string): string {
  const result = asRecord(value, location);
  if (typeof result.id !== "string") throw new Error("Invalid app-server id.");
  return result.id;
}
