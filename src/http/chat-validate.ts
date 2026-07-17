import { record } from "../core/canonical.js";
import type { Logger } from "../core/logger.js";
import {
  validateRequestPolicy,
  type EffectivePolicy,
  type PolicyError,
  type RequestPolicy,
} from "../core/policy.js";
import type { PendingToolCall } from "../continuation/state.js";
import { HttpError } from "./errors.js";

/** A validated text-only Chat Completions message. */
export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

/** The Stage 04 request subset after validation. */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  includeUsage: boolean;
  dynamicTools: Array<Record<string, unknown>>;
  previousResponseId?: string;
  policy: EffectivePolicy;
}

/** A validated request awaiting filesystem and managed-policy resolution. */
export type ParsedChatRequest = Omit<ChatRequest, "policy"> & {
  requestPolicy: RequestPolicy;
};

/** Validates the deliberately narrow request surface implemented in Stage 04. */
export function validateRequest(
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

/** Converts a safe policy failure to the public OpenAI error envelope. */
export function policyHttpError(error: PolicyError): HttpError {
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
export function toHistoryItem(message: ChatMessage): Record<string, unknown> {
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

/** Validates a complete, single-use result set for a suspended tool batch. */
export function validateToolResults(
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
