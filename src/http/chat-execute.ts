import type { JsonRpcTransport } from "../app-server/json-rpc.js";
import { bindingHash, record } from "../core/canonical.js";
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
  toHistoryItems,
  validateToolResults,
  type ChatRequest,
} from "./chat-validate.js";
import { HttpError, toolCorrelationErrorForStatus } from "./errors.js";
import {
  usageLimitErrorResolver,
  type UsageLimitErrorResolver,
} from "./quota.js";

/** Maximum buffered app-server activity retained for one HTTP response. */
const MAX_INGRESS_EVENTS = 1_024;

/** Proxy-created thread subscriptions with raw boundaries on each transport. */
const RAW_RESPONSE_THREADS = new WeakMap<JsonRpcTransport, Set<string>>();

/** One arrival-ordered app-server notification or dynamic tool request. */
type IngressEvent =
  | { type: "notification"; method: string; params: unknown }
  | { type: "dynamic_tool"; call: PendingToolCall }
  | {
      type: "raw_dynamic_tool";
      call: StoredToolCall;
      params: unknown;
    };

/** Owns bounded request ingress and its wake and failure state. */
class IngressQueue {
  readonly #ingress: IngressEvent[] = [];
  #wake: (() => void) | undefined;
  #queueError: Error | undefined;
  #transportError: Error | undefined;
  #dynamicCallsCancelled = false;
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
    return this.#ingress.some((event) => event.type === "notification");
  }

  /** Reports why terminal collection must stop without throwing. */
  get failureReason(): "transport_failed" | "queue_overflowed" | undefined {
    if (this.#transportError) return "transport_failed";
    if (this.#queueError) return "queue_overflowed";
    return undefined;
  }

  /** Returns the next retained event without consuming it. */
  peek(): IngressEvent | undefined {
    return this.#ingress[0];
  }

  /** Retains one event within the bounded event count. */
  enqueue(event: IngressEvent): void {
    if (event.type === "dynamic_tool" && this.#dynamicCallsCancelled) return;
    if (this.#queueError) {
      if (event.type === "dynamic_tool") this.#rejectDynamicCall(event.call);
      return;
    }
    if (this.#ingress.length >= MAX_INGRESS_EVENTS) {
      this.#queueError = new Error("App-server activity queue overflowed.");
      if (event.type === "dynamic_tool") this.#rejectDynamicCall(event.call);
      this.notify();
      return;
    }
    this.#ingress.push(event);
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

  /** Consumes the next retained event. */
  shift(): IngressEvent | undefined {
    return this.#ingress.shift();
  }

  /** Drains all retained events in arrival order. */
  drainAll(): IngressEvent[] {
    return this.#ingress.splice(0);
  }

  /** Consumes retained notifications, leaving dynamic requests for cleanup. */
  drainNotifications(): Array<Extract<IngressEvent, { type: "notification" }>> {
    const drained: Array<Extract<IngressEvent, { type: "notification" }>> = [];
    const retained: IngressEvent[] = [];
    for (const event of this.#ingress.splice(0)) {
      if (event.type === "notification") drained.push(event);
      else retained.push(event);
    }
    this.#ingress.push(...retained);
    return drained;
  }

  /** Drops current and future tool requests after their turn is interrupted. */
  markDynamicCallsCancelled(): void {
    this.#dynamicCallsCancelled = true;
    const retained = this.#ingress.filter(
      (event) => event.type === "notification",
    );
    this.#ingress.splice(0, this.#ingress.length, ...retained);
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

  /** Waits for the raw completion that closes one upstream tool-call batch. */
  async waitForDynamicToolBatch(
    signal: AbortSignal,
    threadId: string,
    turnId: string,
  ): Promise<boolean> {
    const hasBoundary = (): boolean =>
      this.#ingress.some(
        (event) =>
          event.type === "notification" &&
          event.method === "rawResponse/completed" &&
          matchesTurn(event.params, threadId, turnId),
      );
    await this.wait(signal, { ready: hasBoundary });
    this.assertHealthy();
    return hasBoundary();
  }

  /** Rejects every retained dynamic request during unsuspended cleanup. */
  rejectQueuedDynamicCalls(): void {
    for (const event of this.#ingress)
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
  instructionSources: string[];
  dispose(): Promise<void>;
}

/** Shared mutable lifecycle state for one app-server turn. */
interface TurnHandle {
  threadId?: string;
  turnId?: string;
  rawResponseBoundaries: boolean;
  terminal: boolean;
  lease?: ThreadLease;
}

/** Setup output shared by ready and pending-tool continuation paths. */
interface ContinuationSetup {
  usageBaseline: TokenUsageCounters | undefined;
  instructionSources: string[];
}

/**
 * Absolute deadline for terminal usage collection, normally a backstop for a
 * missing idle boundary. A request-timeout abort can end collection sooner.
 */
const TERMINAL_USAGE_WAIT_MS = 10_000;

/** Maximum trailing-usage grace after idle when no usage has been observed. */
const IDLE_USAGE_GRACE_MS = 1000;

/** Runs or resumes a Codex thread and yields its normalized event stream. */
export async function execute(
  request: ChatRequest,
  options: ChatHandlerOptions,
  responseId: string,
): Promise<ExecutionSession> {
  const queue = new IngressQueue((call) => rejectDynamicCall(options, call));
  const dynamicToolNames = new Set(
    request.dynamicTools
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === "string"),
  );
  const historicalToolCallIds = new Set(
    request.messages.flatMap((message) => [
      ...(message.toolCalls ?? []).map((call) => call.id),
      ...(message.internalToolCallIds ?? []),
    ]),
  );
  const handle: TurnHandle = {
    rawResponseBoundaries: false,
    terminal: false,
  };
  const onNotification = (method: string, params: unknown): void => {
    if (method === "rawResponseItem/completed") {
      if (
        isEstablishedUnrelatedNotification(
          params,
          handle.threadId,
          handle.turnId,
        )
      )
        return;
      const call = rawDynamicToolCall(
        params,
        dynamicToolNames,
        historicalToolCallIds,
      );
      if (call) queue.enqueue({ type: "raw_dynamic_tool", call, params });
      return;
    }
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
    if (handle.threadId && handle.turnId && !handle.terminal) {
      // Tombstone before the round trip: a lost or timed-out interrupt response
      // does not prove the turn survived, and this execution is being torn down
      // either way, so its remaining callbacks are stale whatever the outcome.
      options.continuations.markTurnInterrupted(handle.threadId, handle.turnId);
      try {
        await options.rpc.request("turn/interrupt", {
          threadId: handle.threadId,
          turnId: handle.turnId,
        });
      } catch {
        // Cancellation is best-effort during request cleanup.
      }
    }
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
  let instructionSources: string[];
  try {
    if (request.previousResponseId) {
      const continuation = await resumeContinuation(
        request,
        options,
        binding,
        handle,
        onToolRequest,
      );
      usageBaseline = continuation.usageBaseline;
      instructionSources = continuation.instructionSources;
    } else {
      instructionSources = await startFreshThread(
        request,
        options,
        handle,
        onToolRequest,
      );
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
  const normalizer = new EventNormalizer(usageBaseline, {
    log: options.log,
    requestId: options.requestId,
  });
  const events =
    (async function* streamExecution(): AsyncGenerator<NormalizedEvent> {
      let failed = false;
      // Constructed only when a turn actually fails; memoized across duplicate
      // terminal events so one response performs at most one account read.
      let quotaResolver: UsageLimitErrorResolver | undefined;
      let pendingFinishReason: NormalizedEvent["finishReason"];
      let pendingUsage: Usage | undefined;
      // Tracks whether this response persisted a pending tool batch.
      let toolBatch: StoredToolCall[] | undefined;
      try {
        while (!handle.terminal) {
          queue.assertHealthy();
          // Drain arrived events before treating abort as terminal.
          if (queue.empty && options.signal.aborted)
            throw new HttpError(
              408,
              "The request timed out or was disconnected.",
              "server_error",
              "request_timeout",
            );
          if (queue.empty) await queue.wait(options.signal);
          queue.assertHealthy();
          const head = queue.peek();
          if (
            head?.type === "raw_dynamic_tool" &&
            !matchesTurn(head.params, handle.threadId, handle.turnId)
          ) {
            queue.shift();
            continue;
          }
          if (
            head?.type === "dynamic_tool" ||
            head?.type === "raw_dynamic_tool"
          ) {
            if (!handle.rawResponseBoundaries)
              throw new HttpError(
                502,
                "The resumed app-server thread cannot expose a dynamic tool batch boundary.",
                "server_error",
                "dynamic_tool_batch_boundary_unavailable",
              );
            const batchCompleted = await queue.waitForDynamicToolBatch(
              options.signal,
              handle.threadId!,
              handle.turnId!,
            );
            if (!batchCompleted)
              throw new HttpError(
                408,
                "The request timed out or was disconnected.",
                "server_error",
                "request_timeout",
              );
            const { captured, stored } = captureToolBatch(
              queue,
              options,
              responseId,
              binding,
              handle,
            );
            toolBatch = stored;
            // End the turn and flush usage even after client abort. The
            // tombstone precedes the round trip because a lost interrupt
            // response does not prove the turn survived, and this response
            // fails either way, so its remaining callbacks are stale whatever
            // the outcome.
            options.continuations.markTurnInterrupted(
              handle.threadId!,
              handle.turnId!,
            );
            try {
              await options.rpc.request("turn/interrupt", {
                threadId: handle.threadId,
                turnId: handle.turnId,
              });
              queue.markDynamicCallsCancelled();
            } catch {
              // Expire the batch unless interruption guarantees continuation.
              options.continuations.protectPendingFromReplay(responseId);
              throw new HttpError(
                502,
                "The app-server could not end the dynamic tool turn.",
                "server_error",
                "tool_turn_interrupt_failed",
              );
            }
            // The interrupt already cancelled the captured requests app-server
            // side, so they are deliberately left unanswered. Results are
            // delivered by continuation, and a late response would only be
            // logged there as an error for a request it no longer tracks.
            for (const event of emitCapturedBatch(
              captured,
              normalizer,
              handle,
            )) {
              // Emit usage after the authoritative tool_calls frame.
              if (event.usage) pendingUsage = event.usage;
              else if (event.finishReason) continue;
              else yield event;
            }
            pendingFinishReason = "tool_calls";
            handle.terminal = true;
            continue;
          }
          // `peek` above already routed every dynamic event, and no await
          // intervenes, so the head can only be a notification here.
          const next = queue.shift();
          if (next?.type !== "notification") continue;
          if (!matchesTurn(next.params, handle.threadId, handle.turnId))
            continue;
          for (const event of normalizer.normalize(next.method, next.params)) {
            if (event.terminalError) {
              handle.terminal = true;
              failed = true;
              // This is the sole terminal lifecycle boundary. Resolving quota
              // metadata here means an error notification and failed completion
              // cannot trigger duplicate account reads or terminal frames.
              quotaResolver ??= usageLimitErrorResolver(
                options.rpc,
                options.signal,
              );
              yield {
                ...event,
                terminalError: await quotaResolver.resolve(event.terminalError),
              };
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
        // Completed and interrupted turns normally reach idle. Known usage lets
        // that boundary end collection immediately; otherwise idle opens a
        // 1000 ms grace window for one trailsing usage flush.
        if (!failed) {
          const collected = await collectTerminalUsage(
            queue,
            normalizer,
            handle,
            options.signal,
            pendingUsage !== undefined,
          );
          if (collected.usage) pendingUsage = collected.usage;
          if (!pendingUsage)
            options.log("warn", "usage_unreported", {
              request_id: options.requestId,
              reason: collected.exitReason,
              pending_tool_batch: Boolean(toolBatch),
            });
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
  return { events, instructionSources, dispose: cleanup };
}

/**
 * Consumes notifications that follow the turn's terminal event through the
 * thread's idle boundary, trailing-usage grace, fixed hang backstop, or abort.
 * The turn already succeeded here, so every terminal condition merely stops
 * collection and reports its reason without retracting completed work.
 */
async function collectTerminalUsage(
  queue: IngressQueue,
  normalizer: EventNormalizer,
  handle: TurnHandle,
  signal: AbortSignal,
  hasUsage: boolean,
): Promise<{
  usage: Usage | undefined;
  exitReason:
    | "idle"
    | "idle_grace_expired"
    | "backstop_expired"
    | "aborted"
    | "transport_failed"
    | "queue_overflowed";
}> {
  let usage: Usage | undefined;
  let idleAt: number | undefined;
  const deadline = Date.now() + TERMINAL_USAGE_WAIT_MS;
  const usageKnown = (): boolean => hasUsage || usage !== undefined;
  while (true) {
    if (signal.aborted) return { usage, exitReason: "aborted" };
    const failureReason = queue.failureReason;
    if (failureReason) return { usage, exitReason: failureReason };
    for (const event of queue.drainNotifications()) {
      if (
        notificationBehavior(event.method) === "lifecycle" &&
        isIdleThreadStatus(event.params, handle.threadId)
      ) {
        idleAt ??= Date.now();
        continue;
      }
      if (!matchesTurn(event.params, handle.threadId, handle.turnId)) continue;
      for (const normalized of normalizer.normalize(event.method, event.params))
        // Only usage is recovered here. Every other late event would have to
        // follow the terminal frame this response has already committed to.
        if (normalized.usage) usage = normalized.usage;
    }
    const now = Date.now();
    if (idleAt !== undefined && usageKnown())
      return { usage, exitReason: "idle" };
    if (idleAt !== undefined && now >= idleAt + IDLE_USAGE_GRACE_MS)
      return { usage, exitReason: "idle_grace_expired" };
    if (now >= deadline) return { usage, exitReason: "backstop_expired" };
    const ready = (): boolean => queue.hasNotification;
    const waitUntil = Math.min(
      deadline,
      idleAt === undefined ? deadline : idleAt + IDLE_USAGE_GRACE_MS,
    );
    await queue.wait(signal, { ready, timeoutMs: waitUntil - now });
  }
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

/** Extracts one declared direct function call from an opted-in raw item. */
function rawDynamicToolCall(
  value: unknown,
  dynamicToolNames: ReadonlySet<string>,
  historicalToolCallIds: ReadonlySet<string>,
): StoredToolCall | undefined {
  const item = record(record(value)?.item);
  if (
    item?.type !== "function_call" ||
    typeof item.call_id !== "string" ||
    typeof item.name !== "string" ||
    typeof item.arguments !== "string" ||
    !dynamicToolNames.has(item.name) ||
    historicalToolCallIds.has(item.call_id)
  )
    return undefined;
  return {
    callId: item.call_id,
    name: item.name,
    arguments: item.arguments,
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
  stored: StoredToolCall[];
} {
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
  const stored: StoredToolCall[] = [];
  const seen = new Set<string>();
  for (const event of captured) {
    const call =
      event.type === "raw_dynamic_tool"
        ? event.call
        : event.type === "dynamic_tool"
          ? toStoredToolCall(event.call)
          : undefined;
    if (!call || seen.has(call.callId)) continue;
    seen.add(call.callId);
    stored.push(call);
  }
  try {
    options.continuations.recordPendingTool(
      responseId,
      handle.threadId!,
      binding,
      stored,
    );
  } catch (error) {
    // Reject captured responders if durable persistence fails.
    for (const call of calls) rejectDynamicCall(options, call);
    throw error;
  }
  return { captured, stored };
}

/** Normalizes one captured batch synchronously with the shared normalizer. */
function* emitCapturedBatch(
  captured: IngressEvent[],
  normalizer: EventNormalizer,
  handle: TurnHandle,
): Generator<NormalizedEvent> {
  const emittedCalls = new Set<string>();
  for (const event of captured) {
    if (event.type === "notification") {
      if (!matchesTurn(event.params, handle.threadId, handle.turnId)) continue;
      yield* normalizer.normalize(event.method, event.params);
      continue;
    }
    if (
      event.type === "raw_dynamic_tool" &&
      !matchesTurn(event.params, handle.threadId, handle.turnId)
    )
      continue;
    const call =
      event.type === "raw_dynamic_tool"
        ? event.call
        : toStoredToolCall(event.call);
    if (emittedCalls.has(call.callId)) continue;
    emittedCalls.add(call.callId);
    yield normalizer.dynamicToolCall(call);
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
  if (stored.reasoningEffort !== binding.reasoningEffort)
    continuationFailure(409, "continuation_reasoning_effort_mismatch");
  if (stored.cwd !== binding.cwd)
    continuationFailure(409, "continuation_cwd_mismatch");
  if (stored.toolsHash !== binding.toolsHash)
    continuationFailure(409, "continuation_tools_mismatch");
  if (stored.policyHash !== binding.policyHash)
    continuationFailure(409, "continuation_policy_mismatch");

  // Set threadId first so cleanup can release it after setup failures.
  handle.threadId = stored.threadId;
  const { terminalToolResults } = request;
  if (
    stored.state === "expired" &&
    stored.pendingCalls?.length &&
    terminalToolResults.length
  )
    continuationFailure(410, "expired_tool_continuation");
  if (stored.state === "pending_tool") {
    if (!terminalToolResults.length)
      continuationFailure(409, "tool_results_required");
    const pending = stored.pendingCalls!;
    const results = validateToolResults(
      request.messages,
      terminalToolResults,
      pending,
    );
    // Claim before awaiting so concurrent continuations remain atomic.
    acquireThread(handle, options, onToolRequest);
    const instructionSources = await resumeIdleThread(request, options, handle);
    const items = pending.flatMap((call) => [
      // Inject the complete pair because an unpaired output is ignored.
      toFunctionCallItem(call),
      toFunctionCallOutputItem(call.callId, results.get(call.callId)!),
    ]);
    // Tombstone before injection to prevent replay after uncertain failure.
    options.continuations.protectPendingFromReplay(request.previousResponseId!);
    try {
      await options.rpc.request(
        "thread/inject_items",
        { threadId: handle.threadId, items },
        options.signal,
      );
    } catch (error) {
      // The tombstone blocks replay if the injection outcome is unknown.
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        502,
        "The app-server could not accept the tool results.",
        "server_error",
        "tool_result_injection_failed",
      );
    }
    // Mark success best-effort; the tombstone already blocks replay.
    options.continuations.recordPendingConsumed(request.previousResponseId!);
    await startTurn(request, options, handle);
    return { usageBaseline: stored.usageTotal, instructionSources };
  }

  if (stored.state === "expired")
    continuationFailure(410, "expired_previous_response_id");
  if (stored.state === "superseded")
    continuationFailure(409, "superseded_previous_response_id");
  if (terminalToolResults.length)
    continuationFailure(409, "tool_results_without_pending_call");
  acquireThread(handle, options, onToolRequest);
  const instructionSources = await resumeIdleThread(request, options, handle);
  await startTurn(request, options, handle);
  return { usageBaseline: stored.usageTotal, instructionSources };
}

/** Gates on a resumable thread status and resumes it under this request's policy. */
async function resumeIdleThread(
  request: ChatRequest,
  options: ChatHandlerOptions,
  handle: TurnHandle,
): Promise<string[]> {
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
  handle.rawResponseBoundaries = rawResponseThreads(options.rpc).has(
    handle.threadId,
  );
  return requiredStringArray(
    resumed.instructionSources,
    "thread/resume.instructionSources",
  );
}

/** Starts one fresh durable thread and its initial turn. */
async function startFreshThread(
  request: ChatRequest,
  options: ChatHandlerOptions,
  handle: TurnHandle,
  onToolRequest: (toolRequest: PendingToolCall) => void,
): Promise<string[]> {
  const started = asRecord(
    await options.rpc.request(
      "thread/start",
      {
        model: request.model,
        ephemeral: false,
        experimentalRawEvents: true,
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
  const instructionSources = requiredStringArray(
    started.instructionSources,
    "thread/start.instructionSources",
  );
  rawResponseThreads(options.rpc).add(handle.threadId);
  handle.rawResponseBoundaries = true;
  acquireThread(handle, options, onToolRequest);
  // Only a trailing user message becomes new turn input. Any other trailing
  // message joins the injected history and the empty-input turn asks the model
  // to continue from it. A terminal tool-result block never reaches this
  // fresh-thread path: it always resolves to a continuation or fails before
  // execution, so every tool message here is a completed earlier round.
  const last = request.messages.at(-1)!;
  const history =
    last.role === "user" ? request.messages.slice(0, -1) : request.messages;
  const prior = toHistoryItems(history);
  if (prior.unansweredCalls || prior.orphanResults)
    options.log("warn", "unpaired_history_tool_items_dropped", {
      request_id: options.requestId,
      unanswered_calls: prior.unansweredCalls,
      orphan_results: prior.orphanResults,
    });
  if (prior.items.length)
    await options.rpc.request(
      "thread/inject_items",
      { threadId: handle.threadId, items: prior.items },
      options.signal,
    );
  await startTurn(request, options, handle);
  return instructionSources;
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
  // Only a trailing user message is new turn input. A tool result's injected
  // function_call_output pairs, and any other trailing message injected as
  // history, are already the model-visible input; app-server accepts an empty
  // input list for both.
  const input =
    last.role === "user"
      ? [{ type: "text", text: last.content!, text_elements: [] }]
      : [];
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

/** Returns the raw-boundary subscriptions known on one transport generation. */
function rawResponseThreads(rpc: JsonRpcTransport): Set<string> {
  const existing = RAW_RESPONSE_THREADS.get(rpc);
  if (existing) return existing;
  const created = new Set<string>();
  RAW_RESPONSE_THREADS.set(rpc, created);
  return created;
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

/** Throws the stable OpenAI-shaped error for continuation failures. */
function continuationFailure(status: number, code: string): never {
  throw toolCorrelationErrorForStatus(
    status,
    "The previous response cannot be continued.",
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

/** Requires an app-server response field containing only string paths. */
function requiredStringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new Error(`Invalid ${location} response.`);
  return [...value];
}
