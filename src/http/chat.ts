import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { writeJson } from "./errors.js";
import { chunk, writeFrame, writeSse, writeSseError } from "./chat-sse.js";
import {
  aggregateNormalizedEvents,
  type NormalizedEvent,
} from "./chat-normalize.js";
import { execute, type ChatHandlerOptions } from "./chat-execute.js";
import {
  policyHttpError,
  validateRequest,
  type ChatRequest,
  type ParsedChatRequest,
} from "./chat-validate.js";
import {
  PolicyError,
  resolveEffectivePolicy,
  type EffectivePolicy,
} from "../core/policy.js";

export { serializeSseFrame } from "./chat-sse.js";
export {
  aggregateNormalizedEvents,
  EventNormalizer,
  HANDLED_NOTIFICATION_METHODS,
  normalizeNotification,
} from "./chat-normalize.js";
export type {
  AggregatedNormalizedEvents,
  NormalizedDelta,
  NormalizedError,
  NormalizedEvent,
  NormalizedFunction,
  NormalizedToolCall,
  NormalizedToolResult,
  NormalizedToolResultData,
  Usage,
} from "./chat-normalize.js";
export type { ChatHandlerOptions } from "./chat-execute.js";

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
      await streamChatResponse(response, events, request, responseId, created);
      return;
    }
    await writeAggregateResponse(
      response,
      events,
      request,
      responseId,
      created,
    );
  } finally {
    // This also covers writeHead/initial-role failures before the async
    // generator has ever started, when its own finally block cannot run.
    await execution.dispose();
  }
}

/** Serializes one execution as an SSE Chat Completions response. */
async function streamChatResponse(
  response: ServerResponse,
  events: AsyncIterable<NormalizedEvent>,
  request: ChatRequest,
  responseId: string,
  created: number,
): Promise<void> {
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
        error instanceof Error ? error.message : "The app-server turn failed.",
      );
  }
  if (!streamFailed) await writeFrame(response, "[DONE]");
  response.end();
}

/** Aggregates and serializes one non-streaming Chat Completions response. */
async function writeAggregateResponse(
  response: ServerResponse,
  events: AsyncIterable<NormalizedEvent>,
  request: ChatRequest,
  responseId: string,
  created: number,
): Promise<void> {
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
}
