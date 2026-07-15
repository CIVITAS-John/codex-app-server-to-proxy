import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { JsonRpcTransport } from "./json-rpc.js";
import { HttpError, writeJson } from "./errors.js";
import type { Logger } from "./logger.js";
import {
  bindingHash,
  type ContinuationCoordinator,
  type PendingToolCall,
  type ThreadBinding,
} from "./state.js";

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
  continuations: ContinuationCoordinator;
  root: string;
  implicitToolContinuation: boolean;
}

/** Validates, executes, and serializes one Chat Completions request. */
export async function handleChatCompletion(
  body: unknown,
  response: ServerResponse,
  options: ChatHandlerOptions,
): Promise<void> {
  const request = validateRequest(
    body,
    options.log,
    options.requestId,
    options.implicitToolContinuation,
  );
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
  const events = execute(request, options, responseId);
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
  const toolCalls = new Map<number, Record<string, unknown>>();
  let finishReason: string | null = null;
  let usage: Usage | undefined;
  const extensions: unknown[] = [];
  for await (const event of events) {
    if (event.error)
      throw new HttpError(502, event.error, "server_error", "app_server_error");
    if (typeof event.delta?.content === "string")
      content += event.delta.content;
    if (Array.isArray(event.delta?.tool_calls)) {
      for (const raw of event.delta.tool_calls) {
        const call = record(raw);
        if (call && typeof call.index === "number")
          toolCalls.set(call.index, call);
      }
    }
    if (event.delta?.x_codex !== undefined)
      extensions.push(event.delta.x_codex);
    if (event.finishReason) finishReason = event.finishReason;
    if (event.usage) usage = event.usage;
  }
  const message: Record<string, unknown> = { role: "assistant", content };
  if (toolCalls.size) {
    message.content = null;
    message.tool_calls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        id: call.id,
        type: call.type,
        function: call.function,
      }));
  }
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

/** Runs or resumes a Codex thread and yields its normalized event stream. */
async function* execute(
  request: ChatRequest,
  options: ChatHandlerOptions,
  responseId: string,
): AsyncGenerator<NormalizedEvent> {
  const queued: Array<{ method: string; params: unknown }> = [];
  const toolRequests: PendingToolCall[] = [];
  let wake: (() => void) | undefined;
  let transportError: Error | undefined;
  const onNotification = (method: string, params: unknown): void => {
    const item = record(record(params)?.item);
    if (method === "item/started" && item?.type === "dynamicToolCall") {
      // The server request is authoritative and carries the responder ID; using
      // both messages would expose the same call twice.
      return;
    }
    queued.push({ method, params });
    wake?.();
  };
  const onToolRequest = (toolRequest: PendingToolCall): void => {
    toolRequests.push(toolRequest);
    wake?.();
  };
  const onClose = (error: Error): void => {
    transportError = error;
    wake?.();
  };
  options.rpc.on("notification", onNotification);
  options.rpc.once("close", onClose);
  let threadId: string | undefined;
  let turnId: string | undefined;
  let terminal = false;
  let suspended = false;
  const normalizer = new EventNormalizer();
  const binding: ThreadBinding = {
    model: request.model,
    cwd: options.root,
    toolsHash: bindingHash(request.dynamicTools),
    policyHash: bindingHash({}),
  };
  const abort = async (): Promise<void> => {
    if (threadId && turnId && !terminal)
      await options.rpc
        .request("turn/interrupt", { threadId, turnId })
        .catch(() => undefined);
  };
  options.signal.addEventListener("abort", () => void abort(), { once: true });
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
      if (stored.state === "pending_tool") {
        const pending = options.continuations.pending(
          request.previousResponseId,
        );
        if (!pending) continuationFailure(410, "expired_tool_continuation");
        const results = validateToolResults(request.messages, pending);
        turnId = pending[0]!.turnId;
        if (!options.continuations.setToolOwner(threadId, onToolRequest))
          continuationFailure(409, "thread_busy");
        options.continuations.resolve(request.previousResponseId, results);
      } else {
        if (stored.state === "expired")
          continuationFailure(410, "expired_previous_response_id");
        if (stored.state === "superseded")
          continuationFailure(409, "superseded_previous_response_id");
        if (stored.state !== "ready")
          continuationFailure(500, "corrupt_response_state");
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
          if (status === "systemError")
            continuationFailure(409, "thread_not_resumable");
          resumed = asRecord(
            await options.rpc.request(
              "thread/resume",
              { threadId, excludeTurns: true },
              options.signal,
            ),
            "thread/resume",
          );
        } catch (error) {
          if (error instanceof HttpError) throw error;
          continuationFailure(409, "thread_not_resumable");
        }
        threadId = stringAt(
          asRecord(resumed.thread, "thread/resume.thread"),
          "id",
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
      }
    } else {
      const started = asRecord(
        await options.rpc.request(
          "thread/start",
          {
            model: request.model,
            ephemeral: false,
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
          },
          options.signal,
        ),
        "turn/start",
      );
      turnId = stringAt(asRecord(turn.turn, "turn/start.turn"), "id");
    }
    while (!terminal) {
      if (transportError) throw transportError;
      if (!queued.length && !toolRequests.length)
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (queued.length || toolRequests.length) resolve();
        });
      wake = undefined;
      if (transportError) throw transportError;
      if (toolRequests.length) {
        // Let parallel app-server requests arriving in this event-loop turn join the batch.
        await new Promise<void>((resolve) => setImmediate(resolve));
        const calls = toolRequests
          .splice(0)
          .sort((a, b) => a.callId.localeCompare(b.callId));
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
        options.continuations.suspend(responseId, binding, calls);
        suspended = true;
        for (const [index, call] of calls.entries())
          yield {
            delta: {
              tool_calls: [
                {
                  index,
                  id: call.callId,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments ?? {}),
                  },
                },
              ],
            },
          };
        yield { finishReason: "tool_calls" };
        terminal = true;
        continue;
      }
      const next = queued.shift();
      if (!next) continue;
      const params = record(next.params);
      if (params) {
        const notificationTurnId =
          typeof params.turnId === "string"
            ? params.turnId
            : record(params.turn)?.id;
        // Turn lifecycle notifications carry the id inside `turn`; item and
        // delta notifications carry a top-level `turnId`.
        if (params.threadId !== threadId || notificationTurnId !== turnId)
          continue;
      }
      for (const event of normalizer.normalize(next.method, next.params)) {
        if (event.finishReason || event.error) terminal = true;
        yield event;
      }
    }
    if (
      !suspended &&
      threadId &&
      !options.continuations.recordReady(responseId, threadId, binding)
    )
      throw new Error("App-server transport was replaced before completion.");
  } finally {
    options.rpc.off("notification", onNotification);
    options.rpc.off("close", onClose);
    if (threadId) options.continuations.clearToolOwner(threadId, onToolRequest);
    if (threadId && !suspended) options.continuations.release(threadId);
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
  implicitToolContinuation: boolean,
): ChatRequest {
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
    ...(typeof body.previous_response_id === "string"
      ? { previousResponseId: body.previous_response_id }
      : {}),
  };
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
