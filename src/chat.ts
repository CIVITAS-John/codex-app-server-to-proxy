import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { JsonRpcTransport } from "./json-rpc.js";
import { HttpError, writeJson } from "./errors.js";
import type { Logger } from "./logger.js";

/** A validated text-only Chat Completions message. */
interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant";
  content: string;
}

/** The Stage 04 request subset after validation. */
interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  includeUsage: boolean;
  dynamicTools: Array<Record<string, unknown>>;
}

/** Standard token usage, with details present only when app-server reports them. */
interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: { reasoning_tokens: number };
}

/** One normalized delta shared by streaming and aggregate output. */
export interface NormalizedEvent {
  delta?: Record<string, unknown>;
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter";
  usage?: Usage;
  error?: string;
}

/** Dependencies used by one Chat Completions request. */
export interface ChatHandlerOptions {
  rpc: JsonRpcTransport;
  log: Logger;
  requestId: string;
  signal: AbortSignal;
}

/** Validates, executes, and serializes one Chat Completions request. */
export async function handleChatCompletion(
  body: unknown,
  response: ServerResponse,
  options: ChatHandlerOptions,
): Promise<void> {
  const request = validateRequest(body, options.log, options.requestId);
  const responseId = `chatcmpl_codex_${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1_000);
  const events = execute(request, options);
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
    for await (const event of events) {
      if (event.error) {
        await writeSse(response, {
          error: {
            message: event.error,
            type: "server_error",
            param: null,
            code: "app_server_error",
          },
        });
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
    await writeFrame(response, "[DONE]");
    response.end();
    return;
  }

  let content = "";
  let finishReason: string | null = null;
  let usage: Usage | undefined;
  const extensions: unknown[] = [];
  for await (const event of events) {
    if (event.error)
      throw new HttpError(502, event.error, "server_error", "app_server_error");
    if (typeof event.delta?.content === "string")
      content += event.delta.content;
    if (event.delta?.x_codex !== undefined)
      extensions.push(event.delta.x_codex);
    if (event.finishReason) finishReason = event.finishReason;
    if (event.usage) usage = event.usage;
  }
  const message: Record<string, unknown> = { role: "assistant", content };
  if (extensions.length > 0) message.x_codex = { events: extensions };
  writeJson(response, 200, {
    id: responseId,
    object: "chat.completion",
    created,
    model: request.model,
    choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
    ...(usage ? { usage } : {}),
  });
}

/** Runs a fresh Codex thread and yields its normalized event stream. */
async function* execute(
  request: ChatRequest,
  options: ChatHandlerOptions,
): AsyncGenerator<NormalizedEvent> {
  const queued: Array<{ method: string; params: unknown }> = [];
  let wake: (() => void) | undefined;
  const onNotification = (method: string, params: unknown): void => {
    queued.push({ method, params });
    wake?.();
  };
  options.rpc.on("notification", onNotification);
  let threadId: string | undefined;
  let turnId: string | undefined;
  let terminal = false;
  const normalizer = new EventNormalizer();
  const abort = async (): Promise<void> => {
    if (threadId && turnId && !terminal)
      await options.rpc
        .request("turn/interrupt", { threadId, turnId })
        .catch(() => undefined);
  };
  options.signal.addEventListener("abort", () => void abort(), { once: true });
  try {
    const started = asRecord(
      await options.rpc.request(
        "thread/start",
        {
          model: request.model,
          ephemeral: true,
          ...(request.dynamicTools.length
            ? { dynamicTools: request.dynamicTools }
            : {}),
        },
        options.signal,
      ),
      "thread/start",
    );
    threadId = stringAt(asRecord(started.thread, "thread/start.thread"), "id");
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
        },
        options.signal,
      ),
      "turn/start",
    );
    turnId = stringAt(asRecord(turn.turn, "turn/start.turn"), "id");
    while (!terminal) {
      if (!queued.length)
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (queued.length) resolve();
        });
      wake = undefined;
      const next = queued.shift();
      if (!next) continue;
      const params = record(next.params);
      if (params && (params.threadId !== threadId || params.turnId !== turnId))
        continue;
      for (const event of normalizer.normalize(next.method, next.params)) {
        if (event.finishReason || event.error) terminal = true;
        yield event;
      }
    }
  } finally {
    options.rpc.off("notification", onNotification);
    if (options.signal.aborted) await abort();
  }
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
  readonly #toolIndexes = new Map<string, number>();
  #sawClientTool = false;

  /** Converts one app-server notification into zero or more public events. */
  normalize(method: string, value: unknown): NormalizedEvent[] {
    const params = record(value);
    if (!params) return [];
    if (
      method === "item/agentMessage/delta" &&
      typeof params.delta === "string"
    )
      return [{ delta: { content: params.delta } }];
    if (method === "item/reasoning/summaryPartAdded")
      return [
        {
          delta: {
            x_codex: {
              type: "reasoning_summary_part",
              item_id: params.itemId,
              index: params.summaryIndex,
            },
          },
        },
      ];
    if (
      method === "item/reasoning/summaryTextDelta" &&
      typeof params.delta === "string"
    )
      return [
        {
          delta: {
            x_codex: {
              type: "reasoning_summary_delta",
              item_id: params.itemId,
              index: params.summaryIndex,
              text: params.delta,
            },
          },
        },
      ];
    if (
      method === "item/reasoning/textDelta" &&
      typeof params.delta === "string"
    )
      return [
        {
          delta: {
            x_codex: {
              type: "reasoning_delta",
              item_id: params.itemId,
              index: params.contentIndex,
              text: params.delta,
            },
          },
        },
      ];
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
        const index = this.#toolIndexes.get(itemId) ?? this.#toolIndexes.size;
        this.#toolIndexes.set(itemId, index);
        return [
          {
            delta: {
              tool_calls: [
                {
                  index,
                  id: itemId,
                  type: "function",
                  function: {
                    name: item.tool,
                    arguments: JSON.stringify(item.arguments ?? {}),
                  },
                },
              ],
            },
          },
        ];
      }
      if (
        !item ||
        item.type === "agentMessage" ||
        item.type === "reasoning" ||
        item.type === "userMessage"
      )
        return [];
      return [
        {
          delta: {
            x_codex: {
              type: "internal_item",
              lifecycle: method === "item/started" ? "started" : "completed",
              item,
            },
          },
        },
      ];
    }
    if (method.startsWith("item/") && method !== "item/agentMessage/delta")
      return [
        {
          delta: {
            x_codex: { type: "internal_delta", event: method, data: params },
          },
        },
      ];
    return [];
  }
}

/** Validates the deliberately narrow request surface implemented in Stage 04. */
function validateRequest(
  value: unknown,
  log: Logger,
  requestId: string,
): ChatRequest {
  const body = record(value);
  if (!body) invalid("Request body must be a JSON object.", null);
  if (typeof body.model !== "string" || body.model.trim() === "")
    invalid("model must be a non-empty string.", "model");
  if (!Array.isArray(body.messages) || body.messages.length === 0)
    invalid("messages must be a non-empty array.", "messages");
  if (body.stream !== undefined && typeof body.stream !== "boolean")
    invalid("stream must be a boolean.", "stream");
  if (body.previous_response_id !== undefined)
    invalid(
      "previous_response_id is not supported until continuation is enabled.",
      "previous_response_id",
    );
  if (
    body.x_codex !== undefined &&
    (record(body.x_codex) === undefined ||
      Object.keys(record(body.x_codex)!).length > 0)
  )
    invalid(
      "x_codex policy fields are not supported in this stage.",
      "x_codex",
    );
  const messages = body.messages.map((entry, index) =>
    validateMessage(entry, index),
  );
  if (messages.at(-1)?.role !== "user")
    invalid("The final message must have role user.", "messages");
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
  };
}

/** Validates one role-preserving, text-only message. */
function validateMessage(value: unknown, index: number): ChatMessage {
  const message = record(value);
  const param = `messages.${index}`;
  if (
    !message ||
    !["system", "developer", "user", "assistant"].includes(String(message.role))
  )
    invalid(
      "Only system, developer, user, and assistant messages are supported in this stage.",
      `${param}.role`,
    );
  if (typeof message.content !== "string")
    invalid("Message content must be a string.", `${param}.content`);
  if (
    Object.keys(message).some(
      (key) => !["role", "content", "name"].includes(key),
    )
  )
    invalid("This message contains unsupported fields.", param);
  return {
    role: message.role as ChatMessage["role"],
    content: message.content as string,
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
  delta: Record<string, unknown>,
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

/** Writes one SSE data frame and waits for drain when required. */
async function writeFrame(
  response: ServerResponse,
  data: string,
): Promise<void> {
  if (!response.write(`data: ${data}\n\n`))
    await Promise.race([once(response, "drain"), once(response, "close")]);
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
