import type { ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type { JsonRpcTransport } from "../app-server/json-rpc.js";
import { HttpError, writeJson } from "./errors.js";
import type { Logger } from "../core/logger.js";
import {
  PolicyError,
  policyBindingHash,
  resolveEffectivePolicy,
  validateRequestPolicy,
  type EffectivePolicy,
  type PolicyRequirements,
  type RequestPolicy,
} from "../core/policy.js";
import {
  bindingHash,
  type ContinuationCoordinator,
  type PendingToolCall,
  type ThreadBinding,
} from "../continuation/state.js";

/** A validated text-only Chat Completions message. */
interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

/** The Stage 04 request subset after validation. */
interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  includeUsage: boolean;
  dynamicTools: Array<Record<string, unknown>>;
  previousResponseId?: string;
  policy: EffectivePolicy;
}

/** A validated request awaiting filesystem and managed-policy resolution. */
type ParsedChatRequest = Omit<ChatRequest, "policy"> & {
  requestPolicy: RequestPolicy;
};

/** Standard token usage, with details present only when app-server reports them. */
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: { reasoning_tokens: number };
}

/** Function metadata shared by normalized calls and their correlated results. */
export interface NormalizedFunction {
  name: string;
  arguments: string;
}

/** One function-shaped call with its stable streaming index. */
export interface NormalizedToolCall {
  index: number;
  id: string;
  type: "function";
  function: NormalizedFunction;
}

/** Bounded lifecycle data attached to one normalized tool result. */
export interface NormalizedToolResultData {
  status: string;
  content?: unknown;
  exit_code?: unknown;
  error?: NormalizedError;
  progress_type?: string;
  stream?: string;
  message?: string;
  patch?: unknown;
}

/** One self-correlating result for a normalized function-shaped call. */
export interface NormalizedToolResult {
  id: string;
  type: "function";
  function: NormalizedFunction;
  result: NormalizedToolResultData;
}

/** Public fields emitted by one normalized lifecycle event. */
export interface NormalizedDelta {
  content?: string;
  reasoning?: string;
  tool_calls?: NormalizedToolCall[];
  tool_results?: NormalizedToolResult[];
}

/** Structured public subset of an app-server tool error. */
export interface NormalizedError {
  message?: string;
  code?: string;
}

/** One normalized delta shared by streaming and aggregate output. */
export interface NormalizedEvent {
  delta?: NormalizedDelta;
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter";
  usage?: Usage;
  error?: string;
}

/** Maximum buffered app-server activity retained for one HTTP response. */
const MAX_INGRESS_EVENTS = 1_024;

/** Maximum approximate JSON bytes retained in one response's ingress queue. */
const MAX_INGRESS_BYTES = 8 * 1024 * 1024;

/** Maximum distinct unexposed methods diagnosed for one app-server transport. */
const MAX_DIAGNOSTIC_METHODS = 32;

/** Explicit handling selected for one pinned app-server notification method. */
type NotificationBehavior = "normalize" | "progress" | "ignore" | "diagnose";

/**
 * Classifies pinned notification methods without making diagnostic recognition
 * an implicit opt-in to public HTTP output.
 */
const NOTIFICATION_BEHAVIORS = new Map<string, NotificationBehavior>([
  ["error", "normalize"],
  ["item/agentMessage/delta", "normalize"],
  ["item/autoApprovalReview/started", "diagnose"],
  ["item/autoApprovalReview/completed", "diagnose"],
  ["item/commandExecution/outputDelta", "progress"],
  ["item/commandExecution/terminalInteraction", "diagnose"],
  ["item/fileChange/outputDelta", "progress"],
  ["item/fileChange/patchUpdated", "progress"],
  ["item/mcpToolCall/progress", "progress"],
  ["item/plan/delta", "progress"],
  ["item/reasoning/summaryPartAdded", "ignore"],
  ["item/reasoning/summaryTextDelta", "normalize"],
  ["item/reasoning/textDelta", "normalize"],
  ["item/started", "normalize"],
  ["item/completed", "normalize"],
  ["serverRequest/resolved", "ignore"],
  ["thread/tokenUsage/updated", "normalize"],
  ["turn/completed", "normalize"],
]);

/** Notification methods that the HTTP translation intentionally handles. */
export const HANDLED_NOTIFICATION_METHODS: ReadonlySet<string> = new Set(
  [...NOTIFICATION_BEHAVIORS]
    .filter(([, behavior]) => behavior !== "diagnose")
    .map(([method]) => method),
);

/** Returns the explicit behavior, diagnosing unclassified future methods. */
function notificationBehavior(method: string): NotificationBehavior {
  return NOTIFICATION_BEHAVIORS.get(method) ?? "diagnose";
}

/** Unexposed notification methods diagnosed for each transport generation. */
const DIAGNOSED_NOTIFICATION_METHODS = new WeakMap<
  JsonRpcTransport,
  Set<string>
>();

/** One arrival-ordered app-server notification or dynamic tool request. */
type IngressEvent =
  | { type: "notification"; method: string; params: unknown }
  | { type: "dynamic_tool"; call: PendingToolCall };

/** One queued ingress event with the retained byte size computed at enqueue. */
interface QueuedIngress {
  event: IngressEvent;
  bytes: number;
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
interface ExecutionSession {
  events: AsyncGenerator<NormalizedEvent>;
  dispose(): Promise<void>;
}

/** Aggregate fields derived from the shared normalized event stream. */
export interface AggregatedNormalizedEvents {
  content: string;
  reasoning: string;
  toolCalls: NormalizedToolCall[];
  toolResults: NormalizedToolResult[];
  finishReason: string | null;
  usage?: Usage;
}

/** Validates, executes, and serializes one Chat Completions request. */
export async function handleChatCompletion(
  body: unknown,
  response: ServerResponse,
  options: ChatHandlerOptions,
): Promise<void> {
  let parsed: ParsedChatRequest;
  try {
    parsed = validateRequest(
      body,
      options.log,
      options.requestId,
      options.implicitToolContinuation,
    );
  } catch (error) {
    if (error instanceof PolicyError) throw policyHttpError(error);
    throw error;
  }
  let policy: EffectivePolicy;
  try {
    policy = await resolveEffectivePolicy(
      parsed.requestPolicy,
      options.root,
      options.requirements,
    );
  } catch (error) {
    if (error instanceof PolicyError) throw policyHttpError(error);
    throw error;
  }
  const request: ChatRequest = {
    model: parsed.model,
    messages: parsed.messages,
    stream: parsed.stream,
    includeUsage: parsed.includeUsage,
    dynamicTools: parsed.dynamicTools,
    ...(parsed.previousResponseId
      ? { previousResponseId: parsed.previousResponseId }
      : {}),
    policy,
  };
  if (
    !request.previousResponseId &&
    request.messages.some((message) => message.role === "tool")
  ) {
    const callIds = request.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.toolCallId!);
    request.previousResponseId =
      options.continuations.findPendingResponse(callIds);
  }
  const responseId = `chatcmpl_codex_${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1_000);
  // Setup is eager so validation and RPC failures retain their HTTP status
  // instead of committing an SSE response before the generator is advanced.
  const execution = await execute(request, options, responseId);
  const { events } = execution;
  try {
    if (request.stream) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      await writeSse(
        response,
        chunk(responseId, created, request.model, { role: "assistant" }, null),
      );
      let streamFailed = false;
      try {
        for await (const event of events) {
          if (event.error) {
            await writeSseError(response, event.error);
            streamFailed = true;
            break;
          }
          if (event.delta)
            await writeSse(
              response,
              chunk(responseId, created, request.model, event.delta, null),
            );
          if (event.finishReason)
            await writeSse(
              response,
              chunk(responseId, created, request.model, {}, event.finishReason),
            );
          if (event.usage && request.includeUsage)
            await writeSse(response, {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model: request.model,
              choices: [],
              usage: event.usage,
            });
        }
      } catch (error) {
        streamFailed = true;
        if (!response.writableEnded && !response.destroyed)
          await writeSseError(
            response,
            error instanceof Error
              ? error.message
              : "The app-server turn failed.",
          );
      }
      if (!streamFailed) await writeFrame(response, "[DONE]");
      response.end();
      return;
    }

    const aggregated = await aggregateNormalizedEvents(events);
    const { content, reasoning, toolResults, finishReason, usage } = aggregated;
    const message: Record<string, unknown> = {
      role: "assistant",
      content: aggregated.toolCalls.length && content === "" ? null : content,
    };
    if (reasoning) message.reasoning = reasoning;
    if (aggregated.toolCalls.length) {
      message.tool_calls = aggregated.toolCalls.map((call) => ({
        id: call.id,
        type: call.type,
        function: call.function,
      }));
    }
    if (toolResults.length) message.tool_results = toolResults;
    writeJson(response, 200, {
      id: responseId,
      object: "chat.completion",
      created,
      model: request.model,
      choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
      ...(usage ? { usage } : {}),
    });
  } finally {
    // This also covers writeHead/initial-role failures before the async
    // generator has ever started, when its own finally block cannot run.
    await execution.dispose();
  }
}

/** Aggregates normalized events for non-streaming output without HTTP state. */
export async function aggregateNormalizedEvents(
  events: AsyncIterable<NormalizedEvent> | Iterable<NormalizedEvent>,
): Promise<AggregatedNormalizedEvents> {
  let content = "";
  let reasoning = "";
  const toolCalls = new Map<number, NormalizedToolCall>();
  const toolResults: NormalizedToolResult[] = [];
  let finishReason: string | null = null;
  let usage: Usage | undefined;
  for await (const event of events) {
    if (event.error)
      throw new HttpError(502, event.error, "server_error", "app_server_error");
    if (typeof event.delta?.content === "string")
      content += event.delta.content;
    if (typeof event.delta?.reasoning === "string")
      reasoning += event.delta.reasoning;
    for (const call of event.delta?.tool_calls ?? [])
      toolCalls.set(call.index, call);
    toolResults.push(...(event.delta?.tool_results ?? []));
    if (event.finishReason) finishReason = event.finishReason;
    if (event.usage) usage = event.usage;
  }
  return {
    content,
    reasoning,
    toolCalls: [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call),
    toolResults,
    finishReason,
    ...(usage ? { usage } : {}),
  };
}

/** Runs or resumes a Codex thread and yields its normalized event stream. */
async function execute(
  request: ChatRequest,
  options: ChatHandlerOptions,
  responseId: string,
): Promise<ExecutionSession> {
  const ingress: QueuedIngress[] = [];
  let ingressBytes = 0;
  let wake: (() => void) | undefined;
  let transportError: Error | undefined;
  let queueError: Error | undefined;
  let threadId: string | undefined;
  let turnId: string | undefined;
  const enqueue = (event: IngressEvent): void => {
    if (queueError) {
      if (event.type === "dynamic_tool") rejectDynamicCall(options, event.call);
      return;
    }
    const eventBytes = approximateJsonBytes(event);
    if (
      ingress.length >= MAX_INGRESS_EVENTS ||
      ingressBytes + eventBytes > MAX_INGRESS_BYTES
    ) {
      queueError = new Error("App-server activity queue overflowed.");
      if (event.type === "dynamic_tool") rejectDynamicCall(options, event.call);
      wake?.();
      return;
    }
    ingress.push({ event, bytes: eventBytes });
    ingressBytes += eventBytes;
    wake?.();
  };
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
    if (isEstablishedUnrelatedNotification(params, threadId, turnId)) return;
    const item = record(record(params)?.item);
    if (
      (method === "item/started" || method === "item/completed") &&
      item?.type === "dynamicToolCall"
    ) {
      // The server request is authoritative and carries the responder ID; using
      // notification lifecycle messages would expose the same call twice.
      return;
    }
    enqueue({ type: "notification", method, params });
  };
  const onToolRequest = (toolRequest: PendingToolCall): void => {
    enqueue({ type: "dynamic_tool", call: toolRequest });
  };
  const onClose = (error: Error): void => {
    transportError = error;
    wake?.();
  };
  options.rpc.on("notification", onNotification);
  options.rpc.once("close", onClose);
  let terminal = false;
  let suspended = false;
  let disposed = false;
  const normalizer = new EventNormalizer();
  let continuationResults: Array<{ call: PendingToolCall; content: string }> =
    [];
  const binding: ThreadBinding = {
    model: request.model,
    cwd: request.policy.cwd,
    toolsHash: bindingHash(request.dynamicTools),
    policyHash: policyBindingHash(request.policy),
  };
  const abort = async (): Promise<void> => {
    if (threadId && turnId && !terminal)
      await options.rpc
        .request("turn/interrupt", { threadId, turnId })
        .catch(() => undefined);
  };
  const onAbort = (): void => {
    // Interrupt is best-effort, but waking the consumer is mandatory: a wedged
    // app-server may never emit the terminal event that previously released it.
    wake?.();
    void abort();
  };
  const cleanup = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await abort();
    options.signal.removeEventListener("abort", onAbort);
    options.rpc.off("notification", onNotification);
    options.rpc.off("close", onClose);
    if (threadId) options.continuations.clearToolOwner(threadId, onToolRequest);
    if (threadId && !suspended) options.continuations.release(threadId);
    if (!suspended)
      for (const { event } of ingress)
        if (event.type === "dynamic_tool")
          rejectDynamicCall(options, event.call);
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (request.previousResponseId) {
      const stored = options.continuations.store.get(
        request.previousResponseId,
      );
      if (!stored) continuationFailure(404, "unknown_previous_response_id");
      if (stored.model !== binding.model)
        continuationFailure(409, "continuation_model_mismatch");
      if (stored.cwd !== binding.cwd)
        continuationFailure(409, "continuation_cwd_mismatch");
      if (stored.toolsHash !== binding.toolsHash)
        continuationFailure(409, "continuation_tools_mismatch");
      if (stored.policyHash !== binding.policyHash)
        continuationFailure(409, "continuation_policy_mismatch");
      threadId = stored.threadId;
      if (
        stored.state === "expired" &&
        stored.callIds?.length &&
        request.messages.some((message) => message.role === "tool")
      )
        continuationFailure(410, "expired_tool_continuation");
      if (stored.state === "pending_tool") {
        // A pending response owns the thread. Only a request that actually
        // carries tool results may enter the exact-suspension validation path.
        if (!request.messages.some((message) => message.role === "tool"))
          continuationFailure(409, "tool_results_required");
        const pending = options.continuations.pending(
          request.previousResponseId,
        );
        if (!pending) continuationFailure(410, "expired_tool_continuation");
        const results = validateToolResults(request.messages, pending);
        turnId = pending[0]!.turnId;
        if (!options.continuations.setToolOwner(threadId, onToolRequest))
          continuationFailure(409, "thread_busy");
        continuationResults = pending.map((call) => ({
          call,
          content: results.get(call.callId)!,
        }));
        options.continuations.resolve(request.previousResponseId, results);
      } else {
        if (stored.state === "expired")
          continuationFailure(410, "expired_previous_response_id");
        if (stored.state === "superseded")
          continuationFailure(409, "superseded_previous_response_id");
        if (stored.state !== "ready")
          continuationFailure(500, "corrupt_response_state");
        if (request.messages.at(-1)?.role === "tool")
          continuationFailure(409, "tool_results_without_pending_call");
        if (!options.continuations.claim(threadId))
          continuationFailure(409, "thread_busy");
        if (!options.continuations.setToolOwner(threadId, onToolRequest))
          continuationFailure(409, "thread_busy");
        let resumed: Record<string, unknown>;
        try {
          const read = asRecord(
            await options.rpc.request(
              "thread/read",
              { threadId, includeTurns: false },
              options.signal,
            ),
            "thread/read",
          );
          const readThread = asRecord(read.thread, "thread/read.thread");
          const status = record(readThread.status)?.type;
          if (status === "active") continuationFailure(409, "thread_busy");
          // Only protocol states that can safely enter thread/resume are
          // accepted. Missing, malformed, and future status values fail closed.
          if (status !== "idle" && status !== "notLoaded")
            continuationFailure(409, "thread_not_resumable");
          resumed = asRecord(
            await options.rpc.request(
              "thread/resume",
              {
                threadId,
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
        const resumedThreadId = stringAt(
          asRecord(resumed.thread, "thread/resume.thread"),
          "id",
        );
        // The durable mapping is authoritative. A mismatched resume result must
        // never transfer ownership to, or start work on, an unexpected thread.
        if (resumedThreadId !== threadId)
          continuationFailure(409, "thread_not_resumable");
        const last = request.messages.at(-1)!;
        const turn = asRecord(
          await options.rpc.request(
            "turn/start",
            {
              threadId,
              model: request.model,
              input: [{ type: "text", text: last.content, text_elements: [] }],
              ...turnPolicyParams(request.policy),
            },
            options.signal,
          ),
          "turn/start",
        );
        turnId = stringAt(asRecord(turn.turn, "turn/start.turn"), "id");
      }
    } else {
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
      threadId = stringAt(
        asRecord(started.thread, "thread/start.thread"),
        "id",
      );
      if (!options.continuations.claim(threadId))
        continuationFailure(409, "thread_busy");
      if (!options.continuations.setToolOwner(threadId, onToolRequest))
        continuationFailure(409, "thread_busy");
      const prior = request.messages.slice(0, -1).map(toHistoryItem);
      if (prior.length)
        await options.rpc.request(
          "thread/inject_items",
          { threadId, items: prior },
          options.signal,
        );
      const last = request.messages.at(-1)!;
      const turn = asRecord(
        await options.rpc.request(
          "turn/start",
          {
            threadId,
            model: request.model,
            input: [{ type: "text", text: last.content, text_elements: [] }],
            ...turnPolicyParams(request.policy),
          },
          options.signal,
        ),
        "turn/start",
      );
      turnId = stringAt(asRecord(turn.turn, "turn/start.turn"), "id");
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
        while (!terminal) {
          if (transportError) throw transportError;
          if (queueError) throw queueError;
          // Preserve all already-arrived events. Once they are drained, abort is a
          // terminal wake source even if interrupt fails or the transport wedges.
          if (!ingress.length && options.signal.aborted)
            throw new HttpError(
              408,
              "The request timed out or was disconnected.",
              "server_error",
              "request_timeout",
            );
          if (!ingress.length)
            await new Promise<void>((resolve) => {
              wake = resolve;
              if (
                ingress.length ||
                queueError ||
                transportError ||
                options.signal.aborted
              )
                resolve();
            });
          wake = undefined;
          if (transportError) throw transportError;
          if (queueError) throw queueError;
          if (ingress[0]?.event.type === "dynamic_tool") {
            // Let parallel app-server requests arriving in this event-loop turn join the batch.
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (queueError) throw queueError;
            const captured = ingress.splice(0).map((queued) => queued.event);
            ingressBytes = 0;
            const calls = captured
              .filter(
                (
                  event,
                ): event is Extract<IngressEvent, { type: "dynamic_tool" }> =>
                  event.type === "dynamic_tool",
              )
              .map((event) => event.call);
            if (
              calls.some(
                (call) => call.threadId !== threadId || call.turnId !== turnId,
              )
            ) {
              for (const call of calls)
                options.rpc.respondError(call.request.id, {
                  code: -32602,
                  message: "Dynamic tool correlation mismatch",
                });
              throw new Error(
                "Dynamic tool request did not match the active turn.",
              );
            }
            try {
              options.continuations.suspend(responseId, binding, calls);
            } catch (error) {
              // Captured calls are no longer in ingress, so this handoff owns
              // rejecting every responder if durable suspension fails.
              for (const call of calls) rejectDynamicCall(options, call);
              throw error;
            }
            suspended = true;
            for (const event of captured) {
              if (event.type === "notification") {
                if (!matchesTurn(event.params, threadId, turnId)) continue;
                for (const normalized of normalizer.normalize(
                  event.method,
                  event.params,
                ))
                  yield normalized;
                continue;
              }
              const call = event.call;
              yield normalizer.dynamicToolCall(call);
            }
            yield { finishReason: "tool_calls" };
            terminal = true;
            continue;
          }
          const next = ingress.shift();
          if (!next) continue;
          ingressBytes -= next.bytes;
          if (next.event.type === "dynamic_tool") continue;
          if (!matchesTurn(next.event.params, threadId, turnId)) continue;
          for (const event of normalizer.normalize(
            next.event.method,
            next.event.params,
          )) {
            if (event.error) {
              terminal = true;
              failed = true;
              yield event;
            } else if (event.finishReason) {
              // Persistence is part of successful completion. Do not expose a
              // terminal success frame until the continuation can be recorded.
              terminal = true;
              pendingFinishReason = event.finishReason;
            } else if (event.usage) {
              pendingUsage = event.usage;
            } else {
              yield event;
            }
          }
        }
        if (
          !suspended &&
          !failed &&
          threadId &&
          !options.continuations.recordReady(responseId, threadId, binding)
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
        terminal = true;
        throw error;
      } finally {
        await cleanup();
      }
    })();
  return { events, dispose: cleanup };
}

/** Converts one app-server notification into zero or more public events. */
export function normalizeNotification(
  method: string,
  value: unknown,
): NormalizedEvent[] {
  return new EventNormalizer().normalize(method, value);
}

/** Maintains stable item-to-choice indexes while normalizing interleaved events. */
export class EventNormalizer {
  readonly #toolCalls = new Map<string, NormalizedToolCall>();
  #nextToolIndex = 0;
  #sawClientTool = false;

  /** Converts one authoritative dynamic request to a function tool call. */
  dynamicToolCall(call: PendingToolCall): NormalizedEvent {
    const argumentsJson = JSON.stringify(call.arguments ?? {});
    const publicCall = this.#allocateToolCall(
      call.callId,
      call.name,
      argumentsJson,
    );
    return { delta: { tool_calls: [publicCall] } };
  }

  /** Emits an accepted dynamic result together with its matching call. */
  dynamicToolResult(call: PendingToolCall, content: string): NormalizedEvent {
    const publicCall = this.#allocateToolCall(
      call.callId,
      call.name,
      JSON.stringify(call.arguments ?? {}),
    );
    return {
      delta: {
        tool_calls: [publicCall],
        tool_results: [
          {
            id: call.callId,
            type: "function",
            function: publicCall.function,
            result: { status: "completed", content },
          },
        ],
      },
    };
  }

  /** Converts one app-server notification into zero or more public events. */
  normalize(method: string, value: unknown): NormalizedEvent[] {
    const params = record(value);
    if (!params) return [];
    if (
      method === "item/agentMessage/delta" &&
      typeof params.delta === "string"
    )
      return [{ delta: { content: params.delta } }];
    if (
      method === "item/reasoning/summaryTextDelta" &&
      typeof params.delta === "string"
    )
      return [{ delta: { reasoning: params.delta } }];
    if (
      method === "item/reasoning/textDelta" &&
      typeof params.delta === "string"
    )
      return [{ delta: { reasoning: params.delta } }];
    if (method === "thread/tokenUsage/updated") {
      const usage = record(record(params.tokenUsage)?.last);
      if (!usage) return [];
      return [{ usage: toUsage(usage) }];
    }
    if (method === "error") {
      const error = record(params.error);
      return [
        {
          error:
            typeof error?.message === "string"
              ? error.message
              : "The app-server turn failed.",
        },
      ];
    }
    if (method === "turn/completed") {
      const turn = record(params.turn);
      const status = turn?.status;
      if (status === "completed")
        return [{ finishReason: this.#sawClientTool ? "tool_calls" : "stop" }];
      if (status === "interrupted") return [{ finishReason: "length" }];
      const error = record(turn?.error);
      return [
        {
          error:
            typeof error?.message === "string"
              ? error.message
              : `The app-server turn ended with status ${String(status)}.`,
        },
      ];
    }
    if (method === "item/started" || method === "item/completed") {
      const item = record(params.item);
      if (method === "item/started" && item?.type === "dynamicToolCall") {
        this.#sawClientTool = true;
        const itemId = String(item.id);
        const publicCall = this.#allocateToolCall(
          itemId,
          String(item.tool),
          JSON.stringify(item.arguments ?? {}),
        );
        return [{ delta: { tool_calls: [publicCall] } }];
      }
      if (
        !item ||
        item.type === "agentMessage" ||
        item.type === "reasoning" ||
        item.type === "userMessage"
      )
        return [];
      return [
        this.#internalItem(
          method === "item/started" ? "started" : "completed",
          item,
        ),
      ];
    }
    if (notificationBehavior(method) === "progress")
      return [this.#internalProgress(method, params)];
    return [];
  }

  /** Emits an internal call, or a self-correlating call/result pair. */
  #internalItem(
    lifecycle: "started" | "completed",
    item: Record<string, unknown>,
  ): NormalizedEvent {
    const id = String(item.id);
    const existing = this.#toolCalls.get(id);
    let call = existing;
    if (!call) {
      const shape = internalToolShape(item);
      call = this.#allocateToolCall(id, shape.name, shape.arguments);
    }
    if (lifecycle === "started") return { delta: { tool_calls: [call] } };
    return {
      delta: {
        // Streaming clients concatenate function arguments by call index, so a
        // previously announced call must not repeat its complete arguments.
        ...(!existing ? { tool_calls: [call] } : {}),
        tool_results: [internalToolResult(item, call)],
      },
    };
  }

  /** Emits bounded progress as a self-correlating tool result. */
  #internalProgress(
    method: string,
    params: Record<string, unknown>,
  ): NormalizedEvent {
    const id = String(params.itemId);
    const existing = this.#toolCalls.get(id);
    const call =
      existing ??
      this.#allocateToolCall(
        id,
        safeToolName(method.slice("item/".length)),
        "{}",
      );
    return {
      delta: {
        // Orphan progress still introduces a reconstructable call, while later
        // progress carries only the nonstandard self-correlating result.
        ...(!existing ? { tool_calls: [call] } : {}),
        tool_results: [progressToolResult(method, params, call)],
      },
    };
  }

  /** Allocates one monotonically increasing index for each call or item ID. */
  #allocateToolCall(
    id: string,
    name: string,
    argumentsJson: string,
  ): NormalizedToolCall {
    const existing = this.#toolCalls.get(id);
    if (existing) return existing;
    const call: NormalizedToolCall = {
      index: this.#nextToolIndex++,
      id,
      type: "function",
      function: { name: safeToolName(name), arguments: argumentsJson },
    };
    this.#toolCalls.set(id, call);
    return call;
  }
}

/** Extracts the turn identifier a notification correlates to, if present. */
function notificationTurnId(params: Record<string, unknown>): unknown {
  return typeof params.turnId === "string"
    ? params.turnId
    : record(params.turn)?.id;
}

/** Checks notification correlation without exposing foreign-thread activity. */
function matchesTurn(
  value: unknown,
  threadId: string | undefined,
  turnId: string | undefined,
): boolean {
  const params = record(value);
  if (!params) return true;
  return params.threadId === threadId && notificationTurnId(params) === turnId;
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

/** Maps a pinned internal ThreadItem to a function-shaped call. */
function internalToolShape(item: Record<string, unknown>): {
  name: string;
  arguments: string;
} {
  const kind = typeof item.type === "string" ? item.type : "unknown";
  const details: Record<string, unknown> = {};
  for (const key of [
    "command",
    "changes",
    "server",
    "tool",
    "arguments",
    "query",
    "action",
    "prompt",
  ])
    if (item[key] !== undefined) details[key] = item[key];
  return {
    name: typeof item.tool === "string" ? item.tool : kind,
    arguments: JSON.stringify(details),
  };
}

/** Produces a valid function name from an app-server method or item kind. */
function safeToolName(value: string): string {
  const normalized = value.replaceAll(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  return normalized || "unknown_tool";
}

/** Maps a terminal internal ThreadItem to a self-contained tool result. */
function internalToolResult(
  item: Record<string, unknown>,
  call: NormalizedToolCall,
): NormalizedToolResult {
  const result = item.result ?? item.aggregatedOutput ?? item.action;
  return {
    id: String(item.id),
    type: "function",
    function: call.function,
    result: {
      status: typeof item.status === "string" ? item.status : "completed",
      ...(result !== undefined ? { content: boundValue(result) } : {}),
      ...(item.exitCode !== undefined ? { exit_code: item.exitCode } : {}),
      ...(item.error !== undefined
        ? { error: normalizeError(item.error) }
        : {}),
    },
  };
}

/** Maps correlated item deltas to a bounded in-progress tool result. */
function progressToolResult(
  method: string,
  params: Record<string, unknown>,
  call: NormalizedToolCall,
): NormalizedToolResult {
  const subtype = method.slice("item/".length).split("/")[1] ?? "update";
  const output =
    typeof params.delta === "string"
      ? params.delta.slice(0, 64 * 1024)
      : undefined;
  const message =
    typeof params.message === "string"
      ? params.message.slice(0, 8 * 1024)
      : undefined;
  return {
    id: String(params.itemId),
    type: "function",
    function: call.function,
    result: {
      status: "in_progress",
      progress_type: subtype,
      ...(typeof params.stream === "string" ? { stream: params.stream } : {}),
      ...(output !== undefined ? { content: output } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(params.patch !== undefined
        ? { patch: boundValue(params.patch) }
        : {}),
    },
  };
}

/** Bounds structured tool payloads without changing primitive values. */
function boundValue(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 64 * 1024);
  const encoded = JSON.stringify(value);
  return encoded.length <= 64 * 1024 ? value : encoded.slice(0, 64 * 1024);
}

/** Reduces an app-server error to its documented structured public fields. */
function normalizeError(value: unknown): NormalizedError {
  const error = record(value);
  if (!error) return { message: String(value) };
  return {
    ...(typeof error.message === "string" ? { message: error.message } : {}),
    ...(typeof error.code === "string" ? { code: error.code } : {}),
  };
}

/** Validates the deliberately narrow request surface implemented in Stage 04. */
function validateRequest(
  value: unknown,
  log: Logger,
  requestId: string,
  implicitToolContinuation: boolean,
): ParsedChatRequest {
  const body = record(value);
  if (!body) invalid("Request body must be a JSON object.", null);
  if (typeof body.model !== "string" || body.model.trim() === "")
    invalid("model must be a non-empty string.", "model");
  if (!Array.isArray(body.messages) || body.messages.length === 0)
    invalid("messages must be a non-empty array.", "messages");
  if (body.stream !== undefined && typeof body.stream !== "boolean")
    invalid("stream must be a boolean.", "stream");
  if (
    body.previous_response_id !== undefined &&
    (typeof body.previous_response_id !== "string" ||
      body.previous_response_id === "")
  )
    invalid(
      "previous_response_id must be a non-empty string.",
      "previous_response_id",
    );
  const requestPolicy = validateRequestPolicy(body.x_codex);
  const messages = body.messages.map((entry, index) =>
    validateMessage(entry, index),
  );
  const hasToolResults = messages.some((message) => message.role === "tool");
  if (!body.previous_response_id && hasToolResults && !implicitToolContinuation)
    invalid(
      "Tool results require previous_response_id when implicit tool continuation is disabled.",
      "previous_response_id",
    );
  if (
    !body.previous_response_id &&
    !hasToolResults &&
    messages.at(-1)?.role !== "user"
  )
    invalid("The final message must have role user.", "messages");
  if (
    body.previous_response_id &&
    !["user", "tool"].includes(messages.at(-1)!.role)
  )
    invalid("A continuation must end with a user or tool message.", "messages");
  let includeUsage = false;
  if (body.stream_options !== undefined) {
    const streamOptions = record(body.stream_options);
    if (
      !streamOptions ||
      Object.keys(streamOptions).some((key) => key !== "include_usage") ||
      (streamOptions.include_usage !== undefined &&
        typeof streamOptions.include_usage !== "boolean")
    )
      invalid(
        "stream_options supports only a boolean include_usage field.",
        "stream_options",
      );
    includeUsage = streamOptions.include_usage === true;
  }
  const dynamicTools = validateTools(body.tools, body.tool_choice);
  const supported = new Set([
    "model",
    "messages",
    "stream",
    "stream_options",
    "tools",
    "tool_choice",
    "previous_response_id",
    "x_codex",
  ]);
  const ignored = Object.keys(body).filter((key) => !supported.has(key));
  if (ignored.length)
    log("warn", "unsupported_chat_fields_ignored", {
      request_id: requestId,
      fields: ignored.sort(),
    });
  return {
    model: body.model as string,
    messages,
    stream: body.stream === true,
    includeUsage,
    dynamicTools,
    requestPolicy,
    ...(typeof body.previous_response_id === "string"
      ? { previousResponseId: body.previous_response_id }
      : {}),
  };
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

/** Converts a safe policy failure to the public OpenAI error envelope. */
function policyHttpError(error: PolicyError): HttpError {
  return new HttpError(
    400,
    error.message,
    "invalid_request_error",
    error.code,
    error.param,
  );
}

/** Validates one role-preserving, text-only message. */
function validateMessage(value: unknown, index: number): ChatMessage {
  const message = record(value);
  const param = `messages.${index}`;
  if (
    !message ||
    !["system", "developer", "user", "assistant", "tool"].includes(
      String(message.role),
    )
  )
    invalid(
      "Only system, developer, user, assistant, and tool messages are supported.",
      `${param}.role`,
    );
  if (
    typeof message.content !== "string" &&
    !(message.role === "assistant" && message.content === null)
  )
    invalid("Message content must be a string.", `${param}.content`);
  const allowed = new Set([
    "role",
    "content",
    "name",
    "tool_call_id",
    "tool_calls",
  ]);
  if (Object.keys(message).some((key) => !allowed.has(key)))
    invalid("This message contains unsupported fields.", param);
  let toolCalls: ChatMessage["toolCalls"];
  if (message.role === "assistant" && message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls))
      invalid("tool_calls must be an array.", `${param}.tool_calls`);
    toolCalls = message.tool_calls.map((raw, callIndex) => {
      const call = record(raw);
      const fn = record(call?.function);
      if (
        call?.type !== "function" ||
        typeof call.id !== "string" ||
        typeof fn?.name !== "string" ||
        typeof fn.arguments !== "string"
      )
        invalid(
          "Each assistant tool call must be a complete function call.",
          `${param}.tool_calls.${callIndex}`,
        );
      return { id: call.id, name: fn.name, arguments: fn.arguments };
    });
  }
  if (message.role === "tool" && typeof message.tool_call_id !== "string")
    invalid("A tool message requires tool_call_id.", `${param}.tool_call_id`);
  return {
    role: message.role as ChatMessage["role"],
    content: typeof message.content === "string" ? message.content : "",
    ...(typeof message.tool_call_id === "string"
      ? { toolCallId: message.tool_call_id }
      : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

/** Converts OpenAI function declarations to app-server dynamic tool specs. */
function validateTools(
  value: unknown,
  choice: unknown,
): Array<Record<string, unknown>> {
  if (choice !== undefined && choice !== "auto" && choice !== "none")
    invalid(
      "tool_choice supports only auto or none in this stage.",
      "tool_choice",
    );
  if (value === undefined || choice === "none") return [];
  if (!Array.isArray(value)) invalid("tools must be an array.", "tools");
  return value.map((raw, index) => {
    const tool = record(raw);
    const fn = record(tool?.function);
    if (
      tool?.type !== "function" ||
      !fn ||
      typeof fn.name !== "string" ||
      fn.name === "" ||
      fn.name.length > 128 ||
      !/^[a-zA-Z0-9_-]+$/.test(fn.name) ||
      !record(fn.parameters)
    )
      invalid(
        "Each tool must be a named function with a JSON Schema parameters object.",
        `tools.${index}`,
      );
    return {
      type: "function",
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      inputSchema: fn.parameters,
    };
  });
}

/** Maps prior messages to raw Responses API history without flattening roles. */
function toHistoryItem(message: ChatMessage): Record<string, unknown> {
  return {
    type: "message",
    role: message.role,
    content: [
      {
        type: message.role === "assistant" ? "output_text" : "input_text",
        text: message.content,
      },
    ],
  };
}

/** Maps exact app-server last-turn usage to the standard usage object. */
function toUsage(value: Record<string, unknown>): Usage {
  const input = finite(value.inputTokens, "inputTokens");
  const output = finite(value.outputTokens, "outputTokens");
  const result: Usage = {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: finite(value.totalTokens, "totalTokens"),
  };
  if (typeof value.cachedInputTokens === "number")
    result.prompt_tokens_details = { cached_tokens: value.cachedInputTokens };
  if (typeof value.reasoningOutputTokens === "number")
    result.completion_tokens_details = {
      reasoning_tokens: value.reasoningOutputTokens,
    };
  return result;
}

/** Creates a conventional single-choice streaming chunk. */
function chunk(
  id: string,
  created: number,
  model: string,
  delta: NormalizedDelta | { role: "assistant" },
  finishReason: string | null,
): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** Writes one JSON SSE data frame while respecting HTTP backpressure. */
async function writeSse(
  response: ServerResponse,
  value: unknown,
): Promise<void> {
  await writeFrame(response, JSON.stringify(value));
}

/** Writes the single terminal OpenAI-shaped error allowed on an SSE stream. */
async function writeSseError(
  response: ServerResponse,
  message: string,
): Promise<void> {
  await writeSse(response, {
    error: {
      message,
      type: "server_error",
      param: null,
      code: "app_server_error",
    },
  });
}

/** Writes one SSE data frame and waits for drain when required. */
async function writeFrame(
  response: ServerResponse,
  data: string,
): Promise<void> {
  if (response.destroyed || response.writableEnded)
    throw new Error("The HTTP response closed before the SSE frame was sent.");
  if (!response.write(serializeSseFrame(data))) {
    // close may have fired synchronously during write, before listeners attach.
    if (response.destroyed || response.writableEnded)
      throw new Error("The HTTP response closed while sending an SSE frame.");
    await new Promise<void>((resolve) => {
      const cleanup = (): void => {
        response.off("drain", onDrain);
        response.off("close", onClose);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onClose = (): void => {
        cleanup();
        resolve();
      };
      response.once("drain", onDrain);
      response.once("close", onClose);
    });
    if (response.destroyed && !response.writableFinished)
      throw new Error("The HTTP response closed while sending an SSE frame.");
  }
}

/** Serializes one SSE data frame without performing I/O. */
export function serializeSseFrame(data: string): string {
  return `data: ${data}\n\n`;
}

/** Records safe structural metadata once per unexposed method and transport. */
function diagnoseUnexposedNotification(
  method: string,
  params: unknown,
  rpc: JsonRpcTransport,
  log: Logger,
): void {
  let diagnosed = DIAGNOSED_NOTIFICATION_METHODS.get(rpc);
  if (!diagnosed) {
    diagnosed = new Set<string>();
    DIAGNOSED_NOTIFICATION_METHODS.set(rpc, diagnosed);
  }
  if (diagnosed.has(method)) return;
  if (diagnosed.size >= MAX_DIAGNOSTIC_METHODS) return;
  diagnosed.add(method);
  const value = record(params);
  const keys = value ? Object.keys(value) : [];
  log("debug", "unknown_app_server_event", {
    method_fingerprint: diagnosticFingerprint(method),
    params_type: Array.isArray(params)
      ? "array"
      : params === null
        ? "null"
        : typeof params,
    field_count: keys.length,
    field_fingerprints: keys.slice(0, 32).map(diagnosticFingerprint).sort(),
  });
}

/** Hashes an untrusted diagnostic name without retaining its sensitive value. */
function diagnosticFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Rejects notifications already established as belonging to a different turn.
 * A notification without correlation params cannot be proven unrelated, so it is
 * kept — matching how the dequeue-side `matchesTurn` treats paramless events.
 */
function isEstablishedUnrelatedNotification(
  value: unknown,
  threadId: string | undefined,
  turnId: string | undefined,
): boolean {
  const params = record(value);
  if (!params) return false;
  if (threadId && params.threadId !== threadId) return true;
  return Boolean(turnId && notificationTurnId(params) !== turnId);
}

/** Estimates retained ingress size using its JSON representation. */
function approximateJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null");
  } catch {
    return MAX_INGRESS_BYTES + 1;
  }
}

/** Validates a complete, single-use result set for a suspended tool batch. */
function validateToolResults(
  messages: ChatMessage[],
  pending: PendingToolCall[],
): Map<string, string> {
  const assistant = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" && message.toolCalls !== undefined,
    );
  if (!assistant?.toolCalls)
    invalid("The assistant tool-call message is required.", "messages");
  const expected = new Map(pending.map((call) => [call.callId, call]));
  if (
    assistant.toolCalls.length !== expected.size ||
    assistant.toolCalls.some(
      (call) =>
        expected.get(call.id)?.name !== call.name ||
        call.arguments !==
          JSON.stringify(expected.get(call.id)?.arguments ?? {}),
    )
  )
    invalid(
      "The assistant tool calls do not match the pending continuation.",
      "messages",
    );
  const results = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    if (!message.toolCallId || !expected.has(message.toolCallId))
      invalid("The tool result references a foreign call ID.", "messages");
    if (results.has(message.toolCallId))
      invalid("A tool call has more than one result.", "messages");
    results.set(message.toolCallId, message.content);
  }
  if (results.size !== expected.size)
    invalid(
      "Exactly one result is required for every pending tool call.",
      "messages",
    );
  return results;
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

/** Throws an OpenAI-shaped request validation error. */
function invalid(message: string, param: string | null): never {
  throw new HttpError(
    400,
    message,
    "invalid_request_error",
    "invalid_request",
    param,
  );
}

/** Narrows an unknown value to a record when possible. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Requires an app-server response object. */
function asRecord(value: unknown, location: string): Record<string, unknown> {
  const result = record(value);
  if (!result) throw new Error(`Invalid ${location} response.`);
  return result;
}

/** Requires a string property in an app-server response. */
function stringAt(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string")
    throw new Error(`Invalid app-server ${key}.`);
  return value[key];
}

/** Requires a finite usage count without estimating it. */
function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Invalid app-server usage ${name}.`);
  return value;
}
