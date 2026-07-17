import { createHash } from "node:crypto";
import type { JsonRpcTransport } from "../app-server/json-rpc.js";
import { record } from "../core/canonical.js";
import type { Logger } from "../core/logger.js";
import type { PendingToolCall } from "../continuation/state.js";
import { HttpError } from "./errors.js";

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

/** Aggregate fields derived from the shared normalized event stream. */
export interface AggregatedNormalizedEvents {
  content: string;
  reasoning: string;
  toolCalls: NormalizedToolCall[];
  toolResults: NormalizedToolResult[];
  finishReason: string | null;
  usage?: Usage;
}

/** Maximum distinct unexposed methods diagnosed for one app-server transport. */
const MAX_DIAGNOSTIC_METHODS = 32;

/** Explicit handling selected for one pinned app-server notification method. */
type NotificationBehavior = "normalize" | "progress" | "ignore" | "diagnose";

/** Classifies pinned notification methods without implicitly exposing them. */
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

/** Unexposed notification methods diagnosed for each transport generation. */
const DIAGNOSED_NOTIFICATION_METHODS = new WeakMap<
  JsonRpcTransport,
  Set<string>
>();

/** Returns the explicit behavior, diagnosing unclassified future methods. */
export function notificationBehavior(method: string): NotificationBehavior {
  return NOTIFICATION_BEHAVIORS.get(method) ?? "diagnose";
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
export function matchesTurn(
  value: unknown,
  threadId: string | undefined,
  turnId: string | undefined,
): boolean {
  const params = record(value);
  if (!params) return true;
  return params.threadId === threadId && notificationTurnId(params) === turnId;
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

/** Records safe structural metadata once per unexposed method and transport. */
export function diagnoseUnexposedNotification(
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

/** Rejects notifications already established as belonging to another turn. */
export function isEstablishedUnrelatedNotification(
  value: unknown,
  threadId: string | undefined,
  turnId: string | undefined,
): boolean {
  const params = record(value);
  if (!params) return false;
  if (threadId && params.threadId !== threadId) return true;
  return Boolean(turnId && notificationTurnId(params) !== turnId);
}

/** Requires a finite usage count without estimating it. */
function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Invalid app-server usage ${name}.`);
  return value;
}
