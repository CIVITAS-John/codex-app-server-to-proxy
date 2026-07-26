import type { JsonRpcTransport } from "../app-server/json-rpc.js";
import { record } from "../core/canonical.js";
import type { Logger } from "../core/logger.js";
import {
  policyBindingHash,
  type EffectivePolicy,
  type PolicyRequirements,
} from "../core/policy.js";
import {
  ZERO_TOKEN_USAGE,
  type TokenUsageCounters,
} from "../core/token-usage.js";
import {
  bindingHash,
  type ContinuationCoordinator,
  type PendingToolCall,
  type StoredToolCall,
  type ThreadBinding,
  type ThreadLease,
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
  toFunctionCallItem,
  toFunctionCallOutputItem,
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

  /** Reports whether any retained event is a notification. */
  get hasNotification(): boolean {
    return this.#ingress.some(({ event }) => event.type === "notification");
  }

  /**
   * Reports a terminal failure without throwing, for callers that must stop
   * consuming ingress rather than fail the work already completed.
   */
  get failing(): boolean {
    return Boolean(this.#transportError ?? this.#queueError);
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

  /** Consumes retained notifications, leaving dynamic requests for cleanup. */
  drainNotifications(): Array<Extract<IngressEvent, { type: "notification" }>> {
    const drained: Array<Extract<IngressEvent, { type: "notification" }>> = [];
    const retained: QueuedIngress[] = [];
    for (const queued of this.#ingress.splice(0)) {
      if (queued.event.type === "notification") drained.push(queued.event);
      else retained.push(queued);
    }
    this.#ingress.push(...retained);
    this.#ingressBytes = retained.reduce(
      (sum, queued) => sum + queued.bytes,
      0,
    );
    return drained;
  }

  /**
   * Waits until retained ingress, terminal failure, or abort can advance the
   * consumer. `ready` selects which retained events count as progress, and
   * `timeoutMs` bounds the wait; the result reports whether progress is
   * possible rather than that the timeout elapsed.
   */
  async wait(
    signal: AbortSignal,
    {
      ready = (): boolean => this.#ingress.length > 0,
      timeoutMs,
    }: {
      ready?: () => boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<boolean> {
    if (timeoutMs !== undefined && timeoutMs <= 0) return false;
    return await new Promise<boolean>((resolve) => {
      // Held in a cell because the timer is created after `finish` closes over it.
      const pending: { timer?: NodeJS.Timeout } = {};
      const settled = (): boolean =>
        ready() ||
        Boolean(this.#queueError ?? this.#transportError) ||
        signal.aborted;
      const finish = (progressed: boolean): void => {
        // Only clear the shared wake slot if this waiter still owns it.
        if (this.#wake === wake) this.#wake = undefined;
        if (pending.timer) clearTimeout(pending.timer);
        resolve(progressed);
      };
      const wake = (): void => {
        if (settled()) finish(true);
      };
      this.#wake = wake;
      if (settled()) {
        finish(true);
        return;
      }
      if (timeoutMs === undefined) return;
      pending.timer = setTimeout(() => finish(false), timeoutMs);
      pending.timer.unref();
    });
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
  lease?: ThreadLease;
}

/** Setup output shared by ready and pending-tool continuation paths. */
interface ContinuationSetup {
  results: Array<{ call: StoredToolCall; content: string }>;
  usageBaseline: TokenUsageCounters | undefined;
}

/**
 * Upper bound on waiting for the terminal usage flush after a turn's last
 * frame. Every turn now ends — completed naturally or interrupted at its tool
 * calls — and app-server flushes usage at turn end within milliseconds, so
 * this cap exists only as a hang backstop, not as an expected wait.
 */
const TERMINAL_USAGE_WAIT_MS = 2_000;

/** Runs or resumes a Codex thread and yields its normalized event stream. */
export async function execute(
  request: ChatRequest,
  options: ChatHandlerOptions,
  responseId: string,
): Promise<ExecutionSession> {
  const queue = new IngressQueue((call) => rejectDynamicCall(options, call));
  const handle: TurnHandle = { terminal: false };
  const onNotification = (method: string, params: unknown): void => {
    const behavior = notificationBehavior(method);
    if (behavior === "diagnose") {
      diagnoseUnexposedNotification(method, params, options.rpc, options.log);
      return;
    }
    if (behavior === "ignore") return;
    if (behavior === "lifecycle") {
      // Thread lifecycle transitions describe the thread, not one turn, so they
      // are correlated by thread alone and must bypass the turn-id filter below.
      if (handle.threadId && record(params)?.threadId !== handle.threadId)
        return;
      queue.enqueue({ type: "notification", method, params });
      return;
    }
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
  let continuationResults: Array<{ call: StoredToolCall; content: string }> =
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
    if (handle.threadId) {
      // The thread is never held across responses: a tool-call turn was
      // interrupted at its batch, so nothing app-server-side stays pending.
      handle.lease?.release();
    }
    queue.rejectQueuedDynamicCalls();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  let usageBaseline: TokenUsageCounters | undefined;
  try {
    if (request.previousResponseId) {
      const continuation = await resumeContinuation(
        request,
        options,
        binding,
        handle,
        onToolRequest,
      );
      continuationResults = continuation.results;
      usageBaseline = continuation.usageBaseline;
    } else {
      await startFreshThread(request, options, handle, onToolRequest);
      // A thread this request created has provably consumed nothing yet.
      usageBaseline = ZERO_TOKEN_USAGE;
    }
  } catch (error) {
    // Setup failures occur before HTTP headers, but still must release any
    // ownership acquired by an earlier setup step.
    await cleanup();
    throw error;
  }
  // Constructed only once the attribution boundary is known, so no notification
  // can be normalized against a baseline this response did not begin from.
  const normalizer = new EventNormalizer(usageBaseline);

  const events =
    (async function* streamExecution(): AsyncGenerator<NormalizedEvent> {
      let failed = false;
      let pendingFinishReason: NormalizedEvent["finishReason"];
      let pendingUsage: Usage | undefined;
      // Set once this response hands off a dynamic-tool batch; selects the
      // pending-tool persistence path over the ready mapping after the loop.
      let toolBatch: StoredToolCall[] | undefined;
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
          if (queue.empty) await queue.wait(options.signal);
          queue.assertHealthy();
          if (queue.peek()?.type === "dynamic_tool") {
            // Let parallel app-server requests arriving in this event-loop turn
            // join the batch before the synchronous persistence handoff.
            await new Promise<void>((resolve) => setImmediate(resolve));
            const { captured, calls, stored } = captureToolBatch(
              queue,
              options,
              responseId,
              binding,
              handle,
            );
            toolBatch = stored;
            // Interrupt deliberately ignores the request signal: ending the
            // turn is protocol hygiene owed even to a disconnecting client,
            // and it is what flushes this turn's exact token usage.
            try {
              await options.rpc.request("turn/interrupt", {
                threadId: handle.threadId,
                turnId: handle.turnId,
              });
            } catch {
              // A tool_calls response promises a usable continuation. Make the
              // durable batch non-replayable before failing instead of exposing
              // calls whose original turn may still be active.
              options.continuations.protectPendingFromReplay(responseId);
              throw new HttpError(
                502,
                "The app-server could not end the dynamic tool turn.",
                "server_error",
                "tool_turn_interrupt_failed",
              );
            }
            // The acknowledged interrupt already cancelled these requests, so
            // answering them is local JSON-RPC hygiene.
            for (const call of calls)
              try {
                options.rpc.respondError(call.request.id, {
                  code: -32003,
                  message: "Tool results are delivered via continuation",
                });
              } catch {
                // A closed transport has already made the request unanswerable.
              }
            for (const event of emitCapturedBatch(
              captured,
              normalizer,
              handle,
            )) {
              // Usage for the model request that produced this batch belongs
              // after the terminal frame, exactly as a completed turn reports
              // it. A finish reason captured with the batch — a client abort
              // racing the widening window — must not precede the
              // authoritative tool_calls frame.
              if (event.usage) pendingUsage = event.usage;
              else if (event.finishReason) continue;
              else yield event;
            }
            pendingFinishReason = "tool_calls";
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
        // Every turn ends at its thread's idle transition — completed turns
        // naturally, tool-call turns through the interrupt above — and the
        // terminal usage flush precedes or accompanies it.
        if (!failed) {
          const late = await collectTerminalUsage(
            queue,
            normalizer,
            handle,
            options.signal,
          );
          if (late) pendingUsage = late;
        }
        // Usage is optional output. Persisting the boundary for the next
        // response is best-effort and must never fail a tool handoff that is
        // already durable.
        if (toolBatch && !failed)
          options.continuations.recordPendingUsage(
            responseId,
            normalizer.usageBoundary(),
          );
        if (
          !toolBatch &&
          !failed &&
          handle.threadId &&
          !options.continuations.recordReady(
            responseId,
            handle.threadId,
            binding,
            normalizer.usageBoundary(),
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

/**
 * Consumes notifications that follow the turn's terminal event through the
 * thread's idle boundary, a fixed hang backstop, or abort. The turn already
 * succeeded here, so every terminal condition — including transport failure and
 * ingress overflow — merely stops collection. Usage is optional output and must
 * never retract a completed turn's frames or its continuation mapping.
 */
async function collectTerminalUsage(
  queue: IngressQueue,
  normalizer: EventNormalizer,
  handle: TurnHandle,
  signal: AbortSignal,
): Promise<Usage | undefined> {
  let usage: Usage | undefined;
  let idle = false;
  const deadline = Date.now() + TERMINAL_USAGE_WAIT_MS;
  const reached = (): boolean => idle;
  while (!signal.aborted && !queue.failing) {
    for (const event of queue.drainNotifications()) {
      if (
        notificationBehavior(event.method) === "lifecycle" &&
        isIdleThreadStatus(event.params, handle.threadId)
      ) {
        idle = true;
        continue;
      }
      if (!matchesTurn(event.params, handle.threadId, handle.turnId)) continue;
      for (const normalized of normalizer.normalize(event.method, event.params))
        // Only usage is recovered here. Every other late event would have to
        // follow the terminal frame this response has already committed to.
        if (normalized.usage) usage = normalized.usage;
    }
    if (reached()) break;
    const ready = (): boolean => queue.hasNotification;
    if (
      !(await queue.wait(signal, { ready, timeoutMs: deadline - Date.now() }))
    )
      break;
  }
  return usage;
}

/** Recognizes the authoritative idle boundary for one completed thread. */
function isIdleThreadStatus(
  value: unknown,
  threadId: string | undefined,
): boolean {
  const params = record(value);
  return Boolean(
    params &&
    params.threadId === threadId &&
    record(params.status)?.type === "idle",
  );
}

/** Converts one in-flight call to its durable, injectable representation. */
function toStoredToolCall(call: PendingToolCall): StoredToolCall {
  return {
    callId: call.callId,
    name: call.name,
    // Stringified exactly once here, so the persisted arguments are
    // byte-identical to what the response emits and what a continuation's
    // replayed assistant message must repeat.
    arguments: JSON.stringify(call.arguments ?? {}),
  };
}

/** Captures and durably records the current dynamic-tool batch synchronously. */
function captureToolBatch(
  queue: IngressQueue,
  options: ChatHandlerOptions,
  responseId: string,
  binding: ThreadBinding,
  handle: TurnHandle,
): {
  captured: IngressEvent[];
  calls: PendingToolCall[];
  stored: StoredToolCall[];
} {
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
  const stored = calls.map(toStoredToolCall);
  if (new Set(stored.map((call) => call.callId)).size !== stored.length) {
    for (const call of calls)
      try {
        options.rpc.respondError(call.request.id, {
          code: -32602,
          message: "Dynamic tool call IDs must be unique",
        });
      } catch {
        // A closed transport has already made the request unanswerable.
      }
    throw new HttpError(
      502,
      "The app-server returned duplicate dynamic tool call IDs.",
      "server_error",
      "invalid_dynamic_tool_batch",
    );
  }
  try {
    options.continuations.recordPendingTool(
      responseId,
      handle.threadId!,
      binding,
      stored,
    );
  } catch (error) {
    // Captured calls are no longer in ingress, so this handoff owns rejecting
    // every responder if durable persistence fails.
    for (const call of calls) rejectDynamicCall(options, call);
    throw error;
  }
  return { captured, calls, stored };
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
    yield normalizer.dynamicToolCall(toStoredToolCall(event.call));
  }
}

/** Resumes and validates one durable continuation on the shared turn handle. */
async function resumeContinuation(
  request: ChatRequest,
  options: ChatHandlerOptions,
  binding: ThreadBinding,
  handle: TurnHandle,
  onToolRequest: (toolRequest: PendingToolCall) => void,
): Promise<ContinuationSetup> {
  const stored = options.continuations.store.get(request.previousResponseId!);
  if (!stored) continuationFailure(404, "unknown_previous_response_id");
  if (stored.model !== binding.model)
    continuationFailure(409, "continuation_model_mismatch");
  // Schema-version-0 records written before reasoning effort became binding
  // data have neither field. Grandfather that ambiguous first continuation;
  // every newly written record carries reasoningEffortBound for exact checks.
  if (
    (stored.reasoningEffortBound === true ||
      stored.reasoningEffort !== undefined) &&
    stored.reasoningEffort !== binding.reasoningEffort
  )
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
    if (!request.messages.some((message) => message.role === "tool"))
      continuationFailure(409, "tool_results_required");
    const pending = stored.pendingCalls;
    // Belt and braces: the loader tombstones metadata-less pending records,
    // so a live one without calls can only mean on-disk tampering.
    if (!pending?.length) continuationFailure(410, "expired_tool_continuation");
    const results = validateToolResults(request.messages, pending);
    // Nothing awaited since the record was read, so selection plus claim is
    // atomic within this event-loop task: of two concurrent continuations,
    // the loser observes thread_busy before any thread-mutating RPC.
    acquireThread(handle, options, onToolRequest);
    await resumeIdleThread(request, options, handle);
    const items = pending.flatMap((call) => [
      // Always the complete pair: the interrupted turn never persisted its
      // own function_call item, and an unpaired output is silently ignored.
      toFunctionCallItem(call),
      toFunctionCallOutputItem(call.callId, results.get(call.callId)!),
    ]);
    // Establish the durable fail-closed boundary before the injection RPC. A
    // failed state write leaves the still-unmodified thread safe to retry.
    options.continuations.protectPendingFromReplay(request.previousResponseId!);
    try {
      await options.rpc.request(
        "thread/inject_items",
        { threadId: handle.threadId, items },
        options.signal,
      );
    } catch (error) {
      // The durable tombstone already prevents a retry if the injection
      // reached an unknowable state.
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        502,
        "The app-server could not accept the tool results.",
        "server_error",
        "tool_result_injection_failed",
      );
    }
    // Superseded is more descriptive after success, but this bookkeeping is
    // best-effort because the durable expired state already prevents replay.
    options.continuations.recordPendingConsumed(request.previousResponseId!);
    await startTurn(request, options, handle);
    return {
      results: pending.map((call) => ({
        call,
        content: results.get(call.callId)!,
      })),
      usageBaseline: stored.usageTotal,
    };
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
  await resumeIdleThread(request, options, handle);
  await startTurn(request, options, handle);
  return { results: [], usageBaseline: stored.usageTotal };
}

/** Gates on a resumable thread status and resumes it under this request's policy. */
async function resumeIdleThread(
  request: ChatRequest,
  options: ChatHandlerOptions,
  handle: TurnHandle,
): Promise<void> {
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
        ...environmentParams(request.policy),
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
  const prior = request.messages
    .slice(0, -1)
    .map(toHistoryItem)
    .filter((item): item is Record<string, unknown> => item !== undefined);
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
  const lease = options.continuations.acquireThread(
    handle.threadId!,
    onToolRequest,
  );
  if (!lease) continuationFailure(409, "thread_busy");
  handle.lease = lease;
}

/** Starts the next turn and records its validated identifier in place. */
async function startTurn(
  request: ChatRequest,
  options: ChatHandlerOptions,
  handle: TurnHandle,
): Promise<void> {
  const last = request.messages.at(-1)!;
  // A continuation whose final message is a tool result carries no new user
  // input: the injected function_call_output pairs already in thread history
  // are the model-visible input, and app-server accepts an empty input list.
  const input =
    last.role === "tool"
      ? []
      : [{ type: "text", text: last.content!, text_elements: [] }];
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
        input,
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
      message: "Active turn ended before the dynamic tool batch was captured",
    });
  } catch {
    // A closed transport has already made the request unanswerable.
  }
}

/** Builds native thread settings shared by thread start and resume. */
function threadPolicyParams(policy: EffectivePolicy): Record<string, unknown> {
  return {
    cwd: policy.cwd,
    sandbox: policy.threadSandbox,
    approvalPolicy: policy.approvalPolicy,
    ...(policy.approvalsReviewer
      ? { approvalsReviewer: policy.approvalsReviewer }
      : {}),
    config: { web_search: policy.webSearch },
  };
}

/**
 * Builds the no-environment override realizing the public `disabled` sandbox.
 * `environments: []` removes the execution environment entirely; thread/resume
 * has no such field in the pinned protocol, so thread/start sets it sticky and
 * every turn/start reapplies it to protect resumed disabled threads.
 */
function environmentParams(policy: EffectivePolicy): Record<string, unknown> {
  return policy.sandbox === "disabled" ? { environments: [] } : {};
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
    ...environmentParams(policy),
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
