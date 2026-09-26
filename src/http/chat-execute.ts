import { RpcError, type JsonRpcTransport } from "../app-server/json-rpc.js";
import type { ThreadConfigResolver } from "../app-server/windows-sandbox.js";
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
  type ResponseRecord,
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
  freshExecutionHistory,
  toFunctionCallItem,
  toFunctionCallOutputItem,
  toBaseInstructions,
  toHistoryItem,
  toHistoryItems,
  validateToolResults,
  type ChatMessage,
  type ChatRequest,
} from "./chat-validate.js";
import { HttpError, toolCorrelationErrorForStatus } from "./errors.js";
import { IDLE_USAGE_GRACE_MS } from "./chat-timing.js";
import {
  usageLimitErrorResolver,
  type UsageLimitErrorResolver,
} from "./quota.js";

/** Maximum buffered app-server activity retained for one HTTP response. */
const MAX_INGRESS_EVENTS = 1_024;

/** Quiet window for callbacks dispatched after their raw response completed. */
const LATE_TOOL_CALLBACK_GRACE_MS = 1_000;

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
    precedingBoundary: boolean,
  ): Promise<boolean> {
    let callbackCount = 0;
    let quietUntil = 0;
    for (;;) {
      this.assertHealthy();
      if (signal.aborted) return false;
      let closed = precedingBoundary;
      let lateCallback = false;
      let count = 0;
      for (const event of this.#ingress) {
        if (event.type === "dynamic_tool") {
          count += 1;
          if (closed) lateCallback = true;
        } else if (matchesTurn(event.params, threadId, turnId)) {
          // Raw items start the next response. An earlier completion must
          // never close a later response within the same Codex turn.
          if (
            event.type === "raw_dynamic_tool" ||
            event.method === "rawResponseItem/completed"
          ) {
            closed = false;
            lateCallback = false;
          } else if (event.method === "rawResponse/completed") closed = true;
        }
      }
      if (count !== callbackCount) {
        callbackCount = count;
        quietUntil = Date.now() + LATE_TOOL_CALLBACK_GRACE_MS;
      }
      if (closed && (!lateCallback || Date.now() >= quietUntil)) return true;
      const length = this.#ingress.length;
      await this.wait(signal, {
        ready: () => this.#ingress.length !== length,
        ...(closed && lateCallback
          ? { timeoutMs: quietUntil - Date.now() }
          : {}),
      });
    }
  }

  /**
   * Drops all retained ingress and rejects its dynamic requests, during
   * unsuspended cleanup or before a fallback abandons its source thread.
   */
  discardIngress(): void {
    for (const event of this.drainAll())
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
  resolveThreadConfig?: ThreadConfigResolver | undefined;
  implicitToolContinuation: boolean;
}

/** Fixed local reasons a continuation admission selects fresh execution. */
export type ContinuationFallbackReason =
  | "unknown_previous_response_id"
  | "unknown_tool_call_id"
  | "expired_previous_response_id"
  | "expired_tool_continuation"
  | "superseded_previous_response_id"
  | "ambiguous_tool_call_id"
  | "tool_results_required"
  | "continuation_model_mismatch"
  | "continuation_reasoning_effort_mismatch"
  | "continuation_cwd_mismatch"
  | "continuation_tools_mismatch"
  | "continuation_policy_mismatch"
  | "raw_response_capability_unavailable"
  | "thread_busy"
  | "thread_active"
  | "thread_not_resumable"
  | "pending_batch_mismatch"
  | "tool_results_without_pending_call";

/** One eagerly prepared execution with cleanup independent of generator startup. */
export interface ExecutionSession {
  events: AsyncGenerator<NormalizedEvent>;
  instructionSources: string[];
  threadReused: boolean;
  dispose(): Promise<void>;
}

/** Shared mutable lifecycle state for one app-server turn. */
interface TurnHandle {
  threadId?: string | undefined;
  turnId?: string | undefined;
  rawResponseBoundaries: boolean;
  terminal: boolean;
  lease?: ThreadLease | undefined;
}

/** Setup output shared by ready and pending-tool continuation paths. */
interface ContinuationSetup {
  usageBaseline: TokenUsageCounters | undefined;
  instructionSources: string[];
}

/** One synchronous local continuation decision made before any app-server RPC. */
type ContinuationAdmission =
  | { type: "fresh"; reason?: ContinuationFallbackReason }
  | {
      type: "reuse";
      responseId: string;
      record: ResponseRecord;
      /** Validated results for the selected pending batch, keyed by call ID. */
      results?: Map<string, string>;
      /**
       * User messages following the selected result block. The final one is
       * the new turn's input; earlier ones are injected after the pairs.
       */
      suffixUsers?: ChatMessage[];
    };

/** The reuse branch of {@link ContinuationAdmission}. */
type ReuseAdmission = Extract<ContinuationAdmission, { type: "reuse" }>;

/** A read/resume preflight outcome that selects fresh execution instead. */
interface PreflightFallback {
  reason: Extract<
    ContinuationFallbackReason,
    "thread_active" | "thread_not_resumable"
  >;
  /**
   * Every thread the preflight addressed or app-server resumed in its place,
   * whose late events must not consume fresh startup ingress.
   */
  threadIds: string[];
}

/**
 * Absolute deadline for terminal usage collection, normally a backstop for a
 * missing idle boundary. A request-timeout abort can end collection sooner.
 */
const TERMINAL_USAGE_WAIT_MS = 10_000;

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
  const excludedThreadIds = new Set<string>();
  const usageStartedAt = Date.now();
  const usageDiagnostics = {
    raw_completions: 0,
    raw_with_usage: 0,
    thread_usage_updates: 0,
    usage_updates_rejected: 0,
  };
  const onNotification = (method: string, params: unknown): void => {
    // A preflight fallback must not let a flood of late source events exhaust
    // fresh startup ingress. The new thread's early events remain eligible.
    const threadId = record(params)?.threadId;
    if (typeof threadId === "string" && excludedThreadIds.has(threadId)) return;
    if (
      method === "rawResponse/completed" ||
      method === "thread/tokenUsage/updated"
    ) {
      const correlated = !isEstablishedUnrelatedNotification(
        params,
        handle.threadId,
        handle.turnId,
      );
      // Log only correlation and counter presence, never provider payloads,
      // tool arguments, or raw thread/response identifiers.
      if (threadId === handle.threadId || !handle.threadId) {
        const value = record(params);
        const counters =
          method === "rawResponse/completed"
            ? record(value?.usage)
            : record(record(value?.tokenUsage)?.last);
        if (!correlated) usageDiagnostics.usage_updates_rejected += 1;
        else if (method === "rawResponse/completed") {
          usageDiagnostics.raw_completions += 1;
          if (counters) usageDiagnostics.raw_with_usage += 1;
        } else usageDiagnostics.thread_usage_updates += 1;
        options.log("debug", "usage_notification", {
          request_id: options.requestId,
          method,
          correlated,
          has_usage: Boolean(counters),
          has_reasoning: typeof counters?.reasoningOutputTokens === "number",
          elapsed_ms: Date.now() - usageStartedAt,
        });
      }
    }
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
      else
        // Keep only correlation, not provider payloads, to invalidate an older
        // boundary even when the next raw item is private/internal activity.
        queue.enqueue({
          type: "notification",
          method,
          params: {
            threadId: record(params)?.threadId,
            turnId: record(params)?.turnId,
          },
        });
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
    queue.discardIngress();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  let usageBaseline: TokenUsageCounters | undefined;
  let instructionSources: string[] = [];
  let threadReused = false;
  try {
    assertDispatchable(options);
    const admission = prepareContinuation(
      request,
      options,
      binding,
      handle,
      onToolRequest,
    );
    let fallbackReason =
      admission.type === "fresh" ? admission.reason : undefined;
    if (admission.type === "reuse") {
      const preflight = await resumeIdleThread(request, options, handle);
      queue.assertHealthy();
      if (Array.isArray(preflight)) {
        const continuation = await resumeContinuation(
          request,
          options,
          admission,
          handle,
          preflight,
        );
        usageBaseline = continuation.usageBaseline;
        instructionSources = continuation.instructionSources;
        threadReused = true;
      } else {
        fallbackReason = preflight.reason;
        for (const threadId of preflight.threadIds)
          excludedThreadIds.add(threadId);
        // Release the source before starting a new thread, and settle callbacks
        // queued during read/resume without touching its durable checkpoint.
        releaseSource(handle);
        queue.discardIngress();
      }
    }
    if (!threadReused) {
      assertDispatchable(options);
      queue.assertHealthy();
      if (fallbackReason) {
        // One diagnostic per dispatched fallback: fixed reason and request ID
        // only, so transcripts, tool arguments, and raw thread IDs stay out
        // of logs. Emitted after the gates that can still reject the request,
        // so a cancelled fallback never logs an execution that never started.
        options.log("info", "continuation_fresh_fallback", {
          request_id: options.requestId,
          reason: fallbackReason,
        });
      }
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
      let capturedBatch: StoredToolCall[] | undefined;
      // A raw completion may be consumed before app-server dispatches its
      // callback. Retain it until another correlated raw item starts a response.
      let precedingRawBoundary = false;
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
              precedingRawBoundary,
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
            capturedBatch = stored;
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
              options.log("debug", "usage_tool_interrupt", {
                request_id: options.requestId,
                elapsed_ms: Date.now() - usageStartedAt,
                ...usageDiagnostics,
              });
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
          if (next.method === "rawResponseItem/completed") {
            precedingRawBoundary = false;
            continue;
          }
          if (next.method === "rawResponse/completed")
            precedingRawBoundary = true;
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
        // Earlier usage may cover only part of the turn. Keep collecting for
        // the full idle grace even after receiving counts or a correction.
        if (!failed) {
          const collected = await collectTerminalUsage(
            queue,
            normalizer,
            handle,
            options.signal,
          );
          // Raw usage can be invalidated by a later completion without counts.
          // Read the final selection instead of retaining an earlier partial sum.
          pendingUsage = normalizer.usageSnapshot();
          const missing = !pendingUsage
            ? "all"
            : pendingUsage.completion_tokens_details?.reasoning_tokens ===
                undefined
              ? "reasoning"
              : undefined;
          const diagnostic = {
            request_id: options.requestId,
            reason: collected.exitReason,
            pending_tool_batch: Boolean(capturedBatch),
            usage_source: normalizer.usageSource() ?? "none",
            elapsed_ms: Date.now() - usageStartedAt,
            ...usageDiagnostics,
          };
          options.log("debug", "usage_collection_completed", {
            ...diagnostic,
            missing: missing ?? "none",
          });
          if (missing)
            options.log("warn", "usage_unreported", {
              ...diagnostic,
              missing,
            });
        }
        // Usage is optional output. Persisting the boundary for the next
        // response is best-effort and must never fail a tool handoff that is
        // already durable.
        if (capturedBatch && !failed)
          options.continuations.recordPendingUsage(
            responseId,
            normalizer.usageBoundary(),
          );
        if (
          !capturedBatch &&
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
          // Deliver usage once, before clients can stop on the finish reason.
          if (pendingUsage) yield { usage: pendingUsage };
          if (pendingFinishReason) yield { finishReason: pendingFinishReason };
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
  return { events, instructionSources, threadReused, dispose: cleanup };
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
): Promise<{
  usage: Usage | undefined;
  exitReason:
    | "idle_grace_expired"
    | "backstop_expired"
    | "aborted"
    | "transport_failed"
    | "queue_overflowed";
}> {
  let usage: Usage | undefined;
  let idleAt: number | undefined;
  const deadline = Date.now() + TERMINAL_USAGE_WAIT_MS;
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

/**
 * Decides synchronously, before any app-server RPC, whether this request
 * continues a mapped thread or executes on a fresh one. Every named local
 * unavailability or compatibility mismatch selects fresh execution with a
 * fixed reason; ambiguous client result IDs remain typed client errors. The thread
 * lease is claimed last, only for reuse, and is attached to the handle only
 * after acquisition so a fresh result never retains the rejected source's
 * thread or lease.
 */
function prepareContinuation(
  request: ChatRequest,
  options: ChatHandlerOptions,
  binding: ThreadBinding,
  handle: TurnHandle,
  onToolRequest: (toolRequest: PendingToolCall) => void,
): ContinuationAdmission {
  let responseId = request.previousResponseId;
  if (!responseId && request.terminalToolResults.length) {
    const callIds = request.terminalToolResults.map(
      (message) => message.toolCallId!,
    );
    try {
      responseId = options.continuations.findPendingResponse(callIds);
    } catch (error) {
      const reason = implicitLookupFallbackReason(error);
      if (reason === undefined) throw error;
      return { type: "fresh", reason };
    }
  }
  if (!responseId) return { type: "fresh" };
  const stored = options.continuations.store.get(responseId);
  if (!stored) return { type: "fresh", reason: "unknown_previous_response_id" };
  // Pending-result compatibility precedes binding, capability, and contention
  // checks so the first mismatch selects fresh execution without touching the
  // source checkpoint.
  let results: Map<string, string> | undefined;
  let suffixUsers: ChatMessage[] | undefined;
  if (stored.state === "pending_tool") {
    // An explicit selector may continue a complete result block followed by
    // consecutive user messages. The implicit selector resolves only a
    // terminal block, which this same selection represents with an empty
    // suffix, so one view serves both without broadening implicit selection.
    const batch = request.toolBatch;
    // No submitted results means this request cannot resume the pending batch.
    // Start independently without consuming or acquiring the source checkpoint.
    if (!batch.results.length)
      return { type: "fresh", reason: "tool_results_required" };
    results = validateToolResults(
      batch.assistant,
      batch.results,
      stored.pendingCalls!,
    );
    if (!results) return { type: "fresh", reason: "pending_batch_mismatch" };
    suffixUsers = batch.suffixUsers;
  } else if (stored.state === "expired") {
    return stored.pendingCalls?.length && request.toolBatch.results.length
      ? { type: "fresh", reason: "expired_tool_continuation" }
      : { type: "fresh", reason: "expired_previous_response_id" };
  } else if (stored.state === "superseded") {
    return { type: "fresh", reason: "superseded_previous_response_id" };
  } else if (request.toolBatch.results.length) {
    return { type: "fresh", reason: "tool_results_without_pending_call" };
  }
  if (stored.model !== binding.model)
    return { type: "fresh", reason: "continuation_model_mismatch" };
  if (stored.reasoningEffort !== binding.reasoningEffort)
    return { type: "fresh", reason: "continuation_reasoning_effort_mismatch" };
  if (stored.cwd !== binding.cwd)
    return { type: "fresh", reason: "continuation_cwd_mismatch" };
  if (stored.toolsHash !== binding.toolsHash)
    return { type: "fresh", reason: "continuation_tools_mismatch" };
  if (stored.policyHash !== binding.policyHash)
    return { type: "fresh", reason: "continuation_policy_mismatch" };
  if (
    request.dynamicTools.length &&
    !rawResponseThreads(options.rpc).has(stored.threadId)
  )
    return { type: "fresh", reason: "raw_response_capability_unavailable" };
  const lease = options.continuations.acquireThread(
    stored.threadId,
    onToolRequest,
  );
  if (!lease) return { type: "fresh", reason: "thread_busy" };
  // threadId gates cleanup's lease release, so both attach together here,
  // only after acquisition, and only on the reuse path.
  handle.threadId = stored.threadId;
  handle.lease = lease;
  return {
    type: "reuse",
    responseId,
    record: stored,
    ...(results ? { results } : {}),
    ...(suffixUsers ? { suffixUsers } : {}),
  };
}

/**
 * Classifies an implicit selector lookup failure into a fallback reason only
 * for the named lookup-unavailability codes. Duplicate result IDs and generic
 * store failures stay errors: neither means the requested continuation is
 * merely unavailable.
 */
function implicitLookupFallbackReason(
  error: unknown,
): ContinuationFallbackReason | undefined {
  if (!(error instanceof HttpError)) return undefined;
  if (
    error.code === "unknown_tool_call_id" ||
    error.code === "expired_tool_continuation" ||
    error.code === "ambiguous_tool_call_id"
  )
    return error.code;
  return undefined;
}

/** Fails a request that can no longer execute before any RPC is issued. */
function assertDispatchable(options: ChatHandlerOptions): void {
  // Disposal and cancellation are lifecycle errors, never fallback reasons.
  options.continuations.assertActive();
  if (options.signal.aborted)
    throw new HttpError(
      408,
      "The request timed out or was disconnected.",
      "server_error",
      "request_timeout",
    );
}

/** Resumes and drives one admitted continuation on the shared turn handle. */
async function resumeContinuation(
  request: ChatRequest,
  options: ChatHandlerOptions,
  admission: ReuseAdmission,
  handle: TurnHandle,
  instructionSources: string[],
): Promise<ContinuationSetup> {
  const stored = admission.record;
  if (stored.state !== "pending_tool") {
    await startTurn(request, options, handle);
    return { usageBaseline: stored.usageTotal, instructionSources };
  }
  const pending = stored.pendingCalls!;
  // The final suffix user message stays the turn input; every earlier suffix
  // user joins the injection after the pairs, keeping its own message and
  // order. No other transcript history is ever injected on the native path.
  const earlierUsers = (admission.suffixUsers ?? []).slice(0, -1);
  const items = [
    ...pending.flatMap((call) => [
      // Inject the complete pair because an unpaired output is ignored.
      toFunctionCallItem(call),
      toFunctionCallOutputItem(
        call.callId,
        admission.results!.get(call.callId)!,
      ),
    ]),
    ...earlierUsers.flatMap((message) => {
      const item = toHistoryItem(message);
      // The role-preserving mapper skips content-less messages; validated
      // user messages always carry string content, so nothing drops here.
      return item ? [item] : [];
    }),
  ];
  // Tombstone before injection to prevent replay after uncertain failure.
  options.continuations.protectPendingFromReplay(admission.responseId);
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
  options.continuations.recordPendingConsumed(admission.responseId);
  await startTurn(request, options, handle);
  return { usageBaseline: stored.usageTotal, instructionSources };
}

/** Releases a reuse admission's source ownership before fresh execution. */
function releaseSource(handle: TurnHandle): void {
  handle.lease?.release();
  // Reset every source-bound field so no source state reaches fresh setup.
  handle.threadId = undefined;
  handle.turnId = undefined;
  handle.lease = undefined;
  handle.rawResponseBoundaries = false;
  handle.terminal = false;
}

/** Reads and resumes a source thread before any replay or turn-start attempt. */
async function resumeIdleThread(
  request: ChatRequest,
  options: ChatHandlerOptions,
  handle: TurnHandle,
): Promise<string[] | PreflightFallback> {
  const sourceThreadId = handle.threadId!;
  const fallback = (
    reason: PreflightFallback["reason"],
    ...otherThreadIds: string[]
  ): PreflightFallback => ({
    reason,
    threadIds: [sourceThreadId, ...otherThreadIds],
  });
  let readValue: unknown;
  try {
    readValue = await options.rpc.request(
      "thread/read",
      { threadId: sourceThreadId, includeTurns: false },
      options.signal,
    );
  } catch (error) {
    if (error instanceof RpcError) return fallback("thread_not_resumable");
    throw error;
  }
  const read = asRecord(readValue, "thread/read");
  const readThread = asRecord(read.thread, "thread/read.thread");
  if (requiredId(read.thread, "thread/read.thread") !== sourceThreadId)
    return fallback("thread_not_resumable");
  const status = asRecord(readThread.status, "thread/read.thread.status").type;
  if (typeof status !== "string")
    throw new Error("Invalid thread/read.thread.status response.");
  // Distinct from local lease contention (`thread_busy`): app-server itself
  // reports a turn running on the mapped thread.
  if (status === "active") return fallback("thread_active");
  if (status !== "idle" && status !== "notLoaded")
    return fallback("thread_not_resumable");
  // Configuration resolution remains outside the RPC-error fallback boundary.
  const policyParams = await threadPolicyParams(request.policy, options);
  let resumedValue: unknown;
  try {
    resumedValue = await options.rpc.request(
      "thread/resume",
      { threadId: sourceThreadId, excludeTurns: true, ...policyParams },
      options.signal,
    );
  } catch (error) {
    if (error instanceof RpcError) return fallback("thread_not_resumable");
    throw error;
  }
  const resumed = asRecord(resumedValue, "thread/resume");
  const resumedThreadId = requiredId(resumed.thread, "thread/resume.thread");
  // The durable mapping is authoritative. A mismatched resume result must
  // never transfer ownership to, or start work on, an unexpected thread, and
  // the thread app-server subscribed in its place must not flood fresh ingress.
  if (resumedThreadId !== sourceThreadId)
    return fallback("thread_not_resumable", resumedThreadId);
  handle.rawResponseBoundaries = rawResponseThreads(options.rpc).has(
    sourceThreadId,
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
        // System messages become thread base instructions because app-server
        // treats that field as the durable instruction channel.
        baseInstructions: toBaseInstructions(request.messages),
        ...(await threadPolicyParams(request.policy, options)),
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
  // non-system message joins injected history and the empty-input turn asks the
  // model to continue from it. System messages are already represented by the
  // thread base. Unpairable history is dropped with one structured warning.
  const prior = toHistoryItems(freshExecutionHistory(request.messages));
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
  // Only a trailing user message is new turn input. Other messages already
  // supply history, tool-result pairs, or system base instructions; app-server
  // accepts an empty input list to continue from that context.
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
async function threadPolicyParams(
  policy: EffectivePolicy,
  options: ChatHandlerOptions,
): Promise<Record<string, unknown>> {
  const config = {
    web_search: policy.webSearch,
    ...(options.resolveThreadConfig
      ? await options.resolveThreadConfig(policy.cwd, options.signal)
      : {}),
  };
  return {
    cwd: policy.cwd,
    sandbox: policy.threadSandbox,
    approvalPolicy: policy.approvalPolicy,
    ...(policy.approvalsReviewer
      ? { approvalsReviewer: policy.approvalsReviewer }
      : {}),
    config,
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
