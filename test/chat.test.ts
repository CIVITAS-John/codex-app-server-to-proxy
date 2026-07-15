import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { test } from "vitest";
import { EventNormalizer, normalizeNotification } from "../src/chat.js";
import { JsonRpcTransport } from "../src/json-rpc.js";
import { createLogger } from "../src/logger.js";
import { parseServeOptions } from "../src/config.js";
import { createProxyServer } from "../src/server.js";
import {
  protocolNotification,
  protocolTurn,
} from "./support/protocol-fixtures.js";

/** Suppresses expected HTTP diagnostics in Chat Completions tests. */
const silentLogger = createLogger("error", () => {});

/** Creates an offline fake app-server transport with deliberately split frames. */
function fakeAppServer(
  complete = true,
  onInterrupt: () => void = () => {},
): JsonRpcTransport {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const rpc = new JsonRpcTransport(fromServer, toServer);
  let thread = "";
  const send = (value: unknown): void => {
    const frame = `${JSON.stringify(value)}\n`;
    const middle = Math.max(1, Math.floor(frame.length / 2));
    fromServer.write(frame.slice(0, middle));
    fromServer.write(frame.slice(middle));
  };
  createInterface({ input: toServer }).on("line", (line) => {
    const message = JSON.parse(line) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    if (message.method === "thread/start") {
      thread = "thr_test";
      send({ id: message.id, result: { thread: { id: thread } } });
    } else if (message.method === "thread/inject_items") {
      send({ id: message.id, result: {} });
    } else if (message.method === "turn/start") {
      send({ id: message.id, result: { turn: { id: "turn_test" } } });
      send(
        protocolNotification({
          method: "item/agentMessage/delta",
          params: {
            threadId: thread,
            turnId: "turn_test",
            itemId: "text",
            delta: "Hello",
          },
        }),
      );
      if (complete) {
        send(
          protocolNotification({
            method: "thread/tokenUsage/updated",
            params: {
              threadId: thread,
              turnId: "turn_test",
              tokenUsage: {
                total: {
                  inputTokens: 4,
                  cachedInputTokens: 0,
                  outputTokens: 2,
                  reasoningOutputTokens: 0,
                  totalTokens: 6,
                },
                last: {
                  inputTokens: 4,
                  cachedInputTokens: 0,
                  outputTokens: 2,
                  reasoningOutputTokens: 0,
                  totalTokens: 6,
                },
                modelContextWindow: null,
              },
            },
          }),
        );
        send(
          protocolNotification({
            method: "turn/completed",
            params: {
              threadId: thread,
              turn: protocolTurn("turn_test", "completed"),
            },
          }),
        );
      }
    } else if (message.method === "turn/interrupt") {
      onInterrupt();
      send({ id: message.id, result: {} });
    }
  });
  return rpc;
}

/** Creates a fake turn with queued tool requests followed by an ingress failure. */
function failingIngressAppServer(mode: "overflow" | "mismatch"): {
  rpc: JsonRpcTransport;
  responderErrors: number[];
  wasInterrupted(): boolean;
} {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const rpc = new JsonRpcTransport(fromServer, toServer);
  const responderErrors: number[] = [];
  let interrupted = false;
  const send = (value: unknown): void => {
    fromServer.write(`${JSON.stringify(value)}\n`);
  };
  createInterface({ input: toServer }).on("line", (line) => {
    const message = JSON.parse(line) as {
      id: number;
      method?: string;
      error?: unknown;
    };
    if (message.method === "thread/start")
      send({ id: message.id, result: { thread: { id: "thr_overflow" } } });
    else if (message.method === "turn/start") {
      send({ id: message.id, result: { turn: { id: "turn_overflow" } } });
      for (const id of [7001, 7002])
        send({
          id,
          method: "item/tool/call",
          params: {
            threadId: "thr_overflow",
            turnId:
              mode === "mismatch" && id === 7002
                ? "foreign_turn"
                : "turn_overflow",
            callId: `call_${id}`,
            tool: "lookup",
            namespace: null,
            arguments: { id },
          },
        });
      if (mode === "overflow")
        for (let index = 0; index < 1_024; index += 1)
          send(
            protocolNotification({
              method: "item/agentMessage/delta",
              params: {
                threadId: "thr_overflow",
                turnId: "turn_overflow",
                itemId: "flood",
                delta: ".",
              },
            }),
          );
    } else if (message.method === "turn/interrupt") {
      interrupted = true;
      send({ id: message.id, result: {} });
    } else if (message.error !== undefined) responderErrors.push(message.id);
  });
  return { rpc, responderErrors, wasInterrupted: () => interrupted };
}

/** Runs an HTTP assertion against an ephemeral, ready offline proxy. */
async function withChatServer(
  run: (
    origin: string,
    proxy: ReturnType<typeof createProxyServer>,
  ) => Promise<void>,
): Promise<void> {
  const proxy = createProxyServer(
    parseServeOptions([
      "--port",
      "0",
      "--state-dir",
      `${tmpdir()}/codex-proxy-chat-tests-${process.pid}`,
    ]),
    silentLogger,
  );
  proxy.setTransport(fakeAppServer());
  proxy.setReady(true);
  const address = await proxy.listen();
  const host = address.address.includes(":")
    ? `[${address.address}]`
    : address.address;
  try {
    await run(`http://${host}:${address.port}`, proxy);
  } finally {
    await proxy.close();
  }
}

test("normalizes interleaved text, reasoning, internal items, tools, usage, and terminal states", () => {
  const normalizer = new EventNormalizer();
  const agentDelta = protocolNotification({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "message",
      delta: "a",
    },
  });
  assert.deepEqual(normalizer.normalize(agentDelta.method, agentDelta.params), [
    { delta: { content: "a" } },
  ]);
  const reasoningDelta = protocolNotification({
    method: "item/reasoning/summaryTextDelta",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "r",
      summaryIndex: 1,
      delta: "why",
    },
  });
  assert.deepEqual(
    normalizer.normalize(reasoningDelta.method, reasoningDelta.params),
    [{ delta: { reasoning: "why" } }],
  );
  /** Builds a generated-protocol dynamic tool start notification. */
  const dynamicTool = (id: string, tool: string) =>
    protocolNotification({
      method: "item/started",
      params: {
        threadId: "thread",
        turnId: "turn",
        startedAtMs: 0,
        item: {
          type: "dynamicToolCall",
          id,
          namespace: null,
          tool,
          arguments: tool === "lookup" ? { id: 1 } : {},
          status: "inProgress",
          contentItems: null,
          success: null,
          durationMs: null,
        },
      },
    });
  const firstNotification = dynamicTool("call_a", "lookup");
  const first = normalizer.normalize(
    firstNotification.method,
    firstNotification.params,
  );
  const secondNotification = dynamicTool("call_b", "other");
  const second = normalizer.normalize(
    secondNotification.method,
    secondNotification.params,
  );
  assert.equal(
    (first[0]?.delta?.tool_calls as Array<{ index: number }>)[0]?.index,
    0,
  );
  assert.equal(
    (second[0]?.delta?.tool_calls as Array<{ index: number }>)[0]?.index,
    1,
  );
  const commandStarted = protocolNotification({
    method: "item/started",
    params: {
      threadId: "thread",
      turnId: "turn",
      startedAtMs: 0,
      item: {
        type: "commandExecution",
        id: "command",
        command: "pwd",
        cwd: "/tmp",
        processId: null,
        source: "agent",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    },
  });
  const commandCall = normalizer.normalize(
    commandStarted.method,
    commandStarted.params,
  )[0]?.delta?.tool_calls;
  assert.deepEqual(commandCall, [
    {
      index: 2,
      id: "command",
      type: "function",
      function: { name: "commandExecution", arguments: '{"command":"pwd"}' },
    },
  ]);
  const commandOutput = protocolNotification({
    method: "item/commandExecution/outputDelta",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "command",
      delta: "output",
    },
  });
  const progress = normalizer.normalize(
    commandOutput.method,
    commandOutput.params,
  )[0]?.delta;
  assert.equal(progress?.tool_calls, undefined);
  assert.deepEqual(progress?.tool_results, [
    {
      id: "command",
      type: "function",
      function: { name: "commandExecution", arguments: '{"command":"pwd"}' },
      result: {
        status: "in_progress",
        progress_type: "outputDelta",
        content: "output",
      },
    },
  ]);
  const streamedArguments = [commandCall, progress?.tool_calls]
    .flatMap((calls) => calls ?? [])
    .map(
      (call) =>
        (call as { function: { arguments: string } }).function.arguments,
    )
    .join("");
  assert.deepEqual(JSON.parse(streamedArguments), { command: "pwd" });
  const commandCompleted = protocolNotification({
    method: "item/completed",
    params: {
      threadId: "thread",
      turnId: "turn",
      completedAtMs: 1,
      item: {
        type: "commandExecution",
        id: "command",
        command: "pwd",
        cwd: "/tmp",
        processId: null,
        source: "agent",
        status: "completed",
        commandActions: [],
        aggregatedOutput: "output",
        exitCode: 0,
        durationMs: 1,
      },
    },
  });
  const terminalCommand = normalizer.normalize(
    commandCompleted.method,
    commandCompleted.params,
  )[0]?.delta;
  assert.equal(terminalCommand?.tool_calls, undefined);
  assert.equal(
    (terminalCommand?.tool_results as Array<{ id: string }>)[0]?.id,
    "command",
  );
  const completed = protocolNotification({
    method: "turn/completed",
    params: {
      threadId: "thread",
      turn: protocolTurn("turn", "completed"),
    },
  });
  assert.deepEqual(normalizer.normalize(completed.method, completed.params), [
    { finishReason: "tool_calls" },
  ]);
  const tokenUsage = protocolNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread",
      turnId: "turn",
      tokenUsage: {
        total: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cachedInputTokens: 2,
          reasoningOutputTokens: 1,
        },
        last: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cachedInputTokens: 2,
          reasoningOutputTokens: 1,
        },
        modelContextWindow: null,
      },
    },
  });
  assert.deepEqual(normalizer.normalize(tokenUsage.method, tokenUsage.params), [
    {
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    },
  ]);
  const interrupted = protocolNotification({
    method: "turn/completed",
    params: {
      threadId: "thread",
      turn: protocolTurn("turn", "interrupted"),
    },
  });
  assert.deepEqual(
    normalizeNotification(interrupted.method, interrupted.params),
    [{ finishReason: "length" }],
  );
  const error = protocolNotification({
    method: "error",
    params: {
      threadId: "thread",
      turnId: "turn",
      willRetry: false,
      error: {
        message: "failed",
        codexErrorInfo: null,
        additionalDetails: null,
      },
    },
  });
  assert.equal(
    normalizeNotification(error.method, error.params)[0]?.error,
    "failed",
  );
});

test("allocates unique call indexes across internal, dynamic, continuation, and orphan progress", () => {
  const normalizer = new EventNormalizer();
  const internal = normalizer.normalize("item/started", {
    item: { id: "internal", type: "commandExecution", command: "pwd" },
  });
  const dynamic = normalizer.dynamicToolCall({
    request: { id: 1, method: "item/tool/call", params: {} },
    callId: "dynamic",
    name: "lookup",
    arguments: { id: 1 },
    threadId: "thread",
    turnId: "turn",
  });
  const result = normalizer.dynamicToolResult(
    {
      request: { id: 2, method: "item/tool/call", params: {} },
      callId: "continued",
      name: "weather",
      arguments: { city: "Chicago" },
      threadId: "thread",
      turnId: "turn",
    },
    "sunny",
  );
  const laterInternal = normalizer.normalize("item/started", {
    item: { id: "later", type: "webSearch", query: "forecast" },
  });
  const orphan = normalizer.normalize("item/mcpToolCall/progress.update", {
    itemId: "orphan",
    delta: "working",
  });
  const indexes = [
    internal[0],
    dynamic,
    result,
    laterInternal[0],
    orphan[0],
  ].map(
    (event) => (event?.delta?.tool_calls as Array<{ index: number }>)[0]?.index,
  );
  assert.deepEqual(indexes, [0, 1, 2, 3, 4]);
  assert.deepEqual(orphan[0]?.delta?.tool_calls, [
    {
      index: 4,
      id: "orphan",
      type: "function",
      function: { name: "mcpToolCall_progress_update", arguments: "{}" },
    },
  ]);
  assert.equal(
    (orphan[0]?.delta?.tool_results as Array<{ id: string }>)[0]?.id,
    "orphan",
  );
});

test("streaming and aggregate responses share content and exact usage", async () => {
  await withChatServer(async (origin) => {
    const request = {
      model: "model-from-client",
      messages: [
        { role: "system", content: "Be concise" },
        { role: "user", content: "Hello" },
      ],
    };
    const aggregate = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(aggregate.status, 200);
    const body = (await aggregate.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { total_tokens: number };
    };
    assert.equal(body.choices[0]?.message.content, "Hello");
    assert.equal(body.usage.total_tokens, 6);

    const streaming = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...request,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    assert.equal(
      streaming.headers.get("content-type"),
      "text/event-stream; charset=utf-8",
    );
    const frames = (await streaming.text())
      .split("\n\n")
      .filter(Boolean)
      .map((frame) => frame.slice(6));
    assert.equal(frames.at(-1), "[DONE]");
    const chunks = frames
      .slice(0, -1)
      .map((frame) => JSON.parse(frame) as Record<string, unknown>);
    const text = chunks
      .flatMap(
        (chunk) => chunk.choices as Array<{ delta: { content?: string } }>,
      )
      .map((choice) => choice.delta.content ?? "")
      .join("");
    assert.equal(text, "Hello");
    assert.equal(
      (
        chunks.find(
          (chunk) => Array.isArray(chunk.choices) && chunk.choices.length === 0,
        )?.usage as { total_tokens: number }
      ).total_tokens,
      6,
    );
  });
});

test("rejects ambiguous history and unknown continuation before app-server work", async () => {
  await withChatServer(async (origin) => {
    for (const body of [
      {
        model: "m",
        messages: [{ role: "assistant", content: "not a user turn" }],
      },
      { model: "m", messages: [{ role: "tool", content: "x" }] },
    ]) {
      const response = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        "invalid_request",
      );
    }
    const unknown = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        previous_response_id: "chatcmpl_old",
      }),
    });
    assert.equal(unknown.status, 404);
    assert.equal(
      ((await unknown.json()) as { error: { code: string } }).error.code,
      "unknown_previous_response_id",
    );
  });
});

test("client disconnect interrupts an active app-server turn", async () => {
  await withChatServer(async (origin, proxy) => {
    let interrupted = false;
    proxy.setTransport(
      fakeAppServer(false, () => {
        interrupted = true;
      }),
    );
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        stream: true,
      }),
    });
    const reader = response.body!.getReader();
    while (true) {
      const part = await reader.read();
      if (part.done || Buffer.from(part.value).includes("Hello")) break;
    }
    await reader.cancel();
    for (let attempt = 0; attempt < 20 && !interrupted; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(interrupted, true);
  });
});

test("ingress overflow interrupts the turn and rejects every queued tool responder", async () => {
  await withChatServer(async (origin, proxy) => {
    const fake = failingIngressAppServer("overflow");
    proxy.setTransport(fake.rpc);
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        tools: [
          { type: "function", function: { name: "lookup", parameters: {} } },
        ],
        messages: [{ role: "user", content: "overflow" }],
      }),
    });
    assert.equal(response.status, 500);
    assert.equal(fake.wasInterrupted(), true);
    assert.deepEqual(
      fake.responderErrors.sort((a, b) => a - b),
      [7001, 7002],
    );
  });
});

test("dynamic correlation failure rejects every captured responder", async () => {
  await withChatServer(async (origin, proxy) => {
    const fake = failingIngressAppServer("mismatch");
    proxy.setTransport(fake.rpc);
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        tools: [
          { type: "function", function: { name: "lookup", parameters: {} } },
        ],
        messages: [{ role: "user", content: "mismatch" }],
      }),
    });
    assert.equal(response.status, 500);
    assert.equal(fake.wasInterrupted(), true);
    assert.deepEqual(
      fake.responderErrors.sort((a, b) => a - b),
      [7001, 7002],
    );
  });
});
