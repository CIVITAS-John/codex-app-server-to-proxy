import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { EventNormalizer, normalizeNotification } from "../../src/http/chat.js";
import { JsonRpcTransport } from "../../src/app-server/json-rpc.js";
import { createLogger } from "../../src/core/logger.js";
import { parseServeOptions } from "../../src/core/config.js";
import { createProxyServer } from "../../src/http/server.js";
import {
  protocolNotification,
  protocolTurn,
} from "../support/protocol-fixtures.js";
import { UNRESTRICTED_POLICY_REQUIREMENTS } from "../../src/core/policy.js";

/** Suppresses expected HTTP diagnostics in Chat Completions tests. */
const silentLogger = createLogger("error", () => {});

/** Creates an offline fake app-server transport with deliberately split frames. */
function fakeAppServer(
  complete = true,
  onInterrupt: () => void = () => {},
  requestTool = false,
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
      if (requestTool) {
        send({
          id: 8_001,
          method: "item/tool/call",
          params: {
            threadId: thread,
            turnId: "turn_test",
            callId: "call_lookup",
            tool: "lookup",
            namespace: null,
            arguments: { key: "value" },
          },
        });
        return;
      }
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

/** Captures exact policy-bearing RPC params for one completed fake turn. */
function policyCapturingAppServer(): {
  rpc: JsonRpcTransport;
  messages: Array<Record<string, unknown>>;
} {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const rpc = new JsonRpcTransport(fromServer, toServer);
  const messages: Array<Record<string, unknown>> = [];
  const send = (value: unknown): void => {
    fromServer.write(`${JSON.stringify(value)}\n`);
  };
  createInterface({ input: toServer }).on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (typeof message.method !== "string") return;
    messages.push(message);
    const id = message.id as number;
    if (message.method === "thread/start")
      send({ id, result: { thread: { id: "thr_policy" } } });
    else if (message.method === "thread/read")
      send({
        id,
        result: {
          thread: { id: "thr_policy", status: { type: "idle" } },
        },
      });
    else if (message.method === "thread/resume")
      send({ id, result: { thread: { id: "thr_policy" } } });
    else if (message.method === "turn/start") {
      send({ id, result: { turn: { id: "turn_policy" } } });
      send(
        protocolNotification({
          method: "turn/completed",
          params: {
            threadId: "thr_policy",
            turn: protocolTurn("turn_policy", "completed"),
          },
        }),
      );
    }
  });
  return { rpc, messages };
}

/** Creates a fake turn with queued tool requests followed by an ingress failure. */
function failingIngressAppServer(mode: "overflow" | "mismatch" | "suspend"): {
  rpc: JsonRpcTransport;
  responderErrors: number[];
  interruptCount(): number;
} {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const rpc = new JsonRpcTransport(fromServer, toServer);
  const responderErrors: number[] = [];
  let interrupts = 0;
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
      interrupts += 1;
      send({ id: message.id, result: {} });
    } else if (message.error !== undefined) responderErrors.push(message.id);
  });
  return { rpc, responderErrors, interruptCount: () => interrupts };
}

/** Creates a turn that fails only after turn/start has committed successfully. */
function lateFailureAppServer(mode: "transport" | "event"): JsonRpcTransport {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const rpc = new JsonRpcTransport(fromServer, toServer);
  const send = (value: unknown): void => {
    fromServer.write(`${JSON.stringify(value)}\n`);
  };
  createInterface({ input: toServer }).on("line", (line) => {
    const message = JSON.parse(line) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    if (message.method === "thread/start")
      send({ id: message.id, result: { thread: { id: "thr_failure" } } });
    else if (message.method === "turn/start") {
      send({ id: message.id, result: { turn: { id: "turn_failure" } } });
      send(
        protocolNotification({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thr_failure",
            turnId: "turn_failure",
            itemId: "partial",
            delta: "partial",
          },
        }),
      );
      if (mode === "transport")
        setImmediate(() => rpc.close(new Error("transport lost")));
      else
        send(
          protocolNotification({
            method: "error",
            params: {
              threadId: "thr_failure",
              turnId: "turn_failure",
              willRetry: false,
              error: {
                message: "turn failed",
                codexErrorInfo: null,
                additionalDetails: null,
              },
            },
          }),
        );
    } else if (message.method === "turn/interrupt")
      send({ id: message.id, result: {} });
  });
  return rpc;
}

/** Creates a silent first turn and a successful second turn on one thread. */
function recoverableAppServer(): {
  rpc: JsonRpcTransport;
  wasInterrupted(): boolean;
} {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const rpc = new JsonRpcTransport(fromServer, toServer);
  let turns = 0;
  let interrupted = false;
  const send = (value: unknown): void => {
    fromServer.write(`${JSON.stringify(value)}\n`);
  };
  createInterface({ input: toServer }).on("line", (line) => {
    const message = JSON.parse(line) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    if (message.method === "thread/start")
      send({ id: message.id, result: { thread: { id: "thr_recover" } } });
    else if (message.method === "turn/start") {
      const turnId = `turn_recover_${++turns}`;
      send({ id: message.id, result: { turn: { id: turnId } } });
      if (turns === 1) return;
      send(
        protocolNotification({
          method: "turn/completed",
          params: {
            threadId: "thr_recover",
            turn: protocolTurn(turnId, "completed"),
          },
        }),
      );
    } else if (message.method === "turn/interrupt") {
      interrupted = true;
      send({ id: message.id, result: {} });
    }
  });
  return { rpc, wasInterrupted: () => interrupted };
}

/** Runs an HTTP assertion against an ephemeral, ready offline proxy. */
async function withChatServer(
  run: (
    origin: string,
    proxy: ReturnType<typeof createProxyServer>,
  ) => Promise<void>,
  requestTimeout = "30s",
  stateDir = `${tmpdir()}/codex-proxy-chat-tests-${process.pid}`,
): Promise<void> {
  const proxy = createProxyServer(
    parseServeOptions([
      "--port",
      "0",
      "--state-dir",
      stateDir,
      "--request-timeout",
      requestTimeout,
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

test("aggregate tool-only responses use null content", async () => {
  await withChatServer(async (origin, proxy) => {
    proxy.setTransport(fakeAppServer(true, () => {}, true));
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        tools: [
          { type: "function", function: { name: "lookup", parameters: {} } },
        ],
        messages: [{ role: "user", content: "use lookup" }],
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      choices: Array<{
        message: { content: string | null; tool_calls: unknown[] };
      }>;
    };
    assert.equal(body.choices[0]?.message.content, null);
    assert.equal(body.choices[0]?.message.tool_calls.length, 1);
  });
});

test("late streaming failures emit one error and close without DONE", async () => {
  for (const mode of ["transport", "event"] as const)
    await withChatServer(async (origin, proxy) => {
      proxy.setTransport(lateFailureAppServer(mode));
      const response = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          stream: true,
          messages: [{ role: "user", content: mode }],
        }),
      });
      assert.equal(response.status, 200);
      const frames = (await response.text())
        .split("\n\n")
        .filter(Boolean)
        .map((frame) => frame.slice(6));
      assert.equal(frames.includes("[DONE]"), false);
      const errors = frames
        .map((frame) => JSON.parse(frame) as Record<string, unknown>)
        .filter((frame) => frame.error !== undefined);
      assert.equal(errors.length, 1);
      assert.equal(
        (errors[0]!.error as { code: string }).code,
        "app_server_error",
      );
      if (mode === "event") {
        const first = JSON.parse(frames[0]!) as { id: string };
        const continuation = await fetch(`${origin}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(500),
          body: JSON.stringify({
            model: "m",
            previous_response_id: first.id,
            messages: [{ role: "user", content: "must be unknown" }],
          }),
        });
        assert.equal(continuation.status, 404);
      }
    });
});

test("initial SSE write failure disposes eager execution before generator startup", async () => {
  await withChatServer(async (origin, proxy) => {
    const fake = recoverableAppServer();
    proxy.setTransport(fake.rpc);
    proxy.server.prependOnceListener("request", (_request, response) => {
      response.write = (() => {
        throw new Error("initial SSE write failed");
      }) as typeof response.write;
    });
    await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        stream: true,
        messages: [{ role: "user", content: "first" }],
      }),
    }).catch(() => undefined);
    for (let attempt = 0; attempt < 20 && !fake.wasInterrupted(); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fake.wasInterrupted(), true);

    // Reusing the same thread proves the abandoned session released its claim
    // and tool-owner callback rather than only interrupting the turn.
    const recovered = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "second" }],
      }),
    });
    assert.equal(recovered.status, 200);
  });
});

test("persistence failure emits an SSE error before finish reason or usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-persist-failure-"));
  try {
    await withChatServer(
      async (origin) => {
        // Atomic rename cannot replace a directory, deterministically forcing
        // recordReady persistence to fail after the app-server completes.
        await mkdir(join(directory, "continuations.json"));
        const response = await fetch(`${origin}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "m",
            stream: true,
            stream_options: { include_usage: true },
            messages: [{ role: "user", content: "persist" }],
          }),
        });
        const body = await response.text();
        assert.match(body, /"code":"app_server_error"/);
        assert.doesNotMatch(body, /"finish_reason":"stop"/);
        assert.doesNotMatch(body, /"usage":/);
        assert.doesNotMatch(body, /\[DONE\]/);
      },
      "30s",
      directory,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("request timeout wakes a silent turn and closes its SSE stream", async () => {
  await withChatServer(async (origin, proxy) => {
    proxy.setTransport(fakeAppServer(false));
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        stream: true,
        messages: [{ role: "user", content: "wait forever" }],
      }),
    });
    const body = await response.text();
    assert.match(body, /"code":"app_server_error"/);
    assert.doesNotMatch(body, /\[DONE\]/);
  }, "50ms");
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
        stream: true,
        messages: [{ role: "user", content: "x" }],
        previous_response_id: "chatcmpl_old",
      }),
    });
    assert.equal(unknown.status, 404);
    assert.equal(
      unknown.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
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
    assert.equal(fake.interruptCount(), 1);
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
    assert.equal(fake.interruptCount(), 1);
    assert.deepEqual(
      fake.responderErrors.sort((a, b) => a - b),
      [7001, 7002],
    );
  });
});

test("suspension persistence failure rejects every captured responder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-suspend-failure-"));
  try {
    await withChatServer(
      async (origin, proxy) => {
        const fake = failingIngressAppServer("suspend");
        proxy.setTransport(fake.rpc);
        await mkdir(join(directory, "continuations.json"));
        const request = {
          model: "m",
          tools: [
            { type: "function", function: { name: "lookup", parameters: {} } },
          ],
          messages: [{ role: "user", content: "suspend" }],
        };
        const failed = await fetch(`${origin}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        assert.equal(failed.status, 500);
        assert.equal(fake.interruptCount(), 1);
        assert.deepEqual(
          fake.responderErrors.sort((a, b) => a - b),
          [7001, 7002],
        );

        // A successful retry on the same thread proves failure cleanup also
        // released the request claim and tool-owner callback.
        await rm(join(directory, "continuations.json"), {
          recursive: true,
          force: true,
        });
        const retried = await fetch(`${origin}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        assert.equal(retried.status, 200);
      },
      "30s",
      directory,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("request policies map exactly, bind continuations, and honor managed denials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-policy-http-"));
  const configuredRoot = join(directory, "root");
  const configuredCwd = join(configuredRoot, "project");
  await mkdir(configuredCwd, { recursive: true });
  const root = await realpath(configuredRoot);
  const cwd = await realpath(configuredCwd);
  const options = parseServeOptions([
    "--port",
    "0",
    "--root",
    root,
    "--state-dir",
    join(directory, "state"),
  ]);
  const proxy = createProxyServer(options, silentLogger);
  const fake = policyCapturingAppServer();
  proxy.setTransport(fake.rpc, UNRESTRICTED_POLICY_REQUIREMENTS);
  proxy.setReady(true);
  const address = await proxy.listen();
  const host = address.address.includes(":")
    ? `[${address.address}]`
    : address.address;
  const origin = `http://${host}:${address.port}`;
  const request = {
    model: "m",
    messages: [{ role: "user", content: "policy" }],
    x_codex: {
      cwd,
      sandbox: "workspace-write",
      web_search: "indexed",
    },
  };
  try {
    const first = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { id: string };
    const thread = fake.messages.find(
      (message) => message.method === "thread/start",
    );
    assert.deepEqual(thread?.params, {
      model: "m",
      ephemeral: false,
      cwd,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      config: { web_search: "indexed" },
    });
    const turn = fake.messages.find(
      (message) => message.method === "turn/start",
    );
    assert.deepEqual(turn?.params, {
      threadId: "thr_policy",
      model: "m",
      input: [{ type: "text", text: "policy", text_elements: [] }],
      cwd,
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });

    const continued = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...request,
        previous_response_id: firstBody.id,
        messages: [{ role: "user", content: "continue" }],
      }),
    });
    assert.equal(continued.status, 200);
    const continuedBody = (await continued.json()) as { id: string };
    const resume = fake.messages.find(
      (message) => message.method === "thread/resume",
    );
    assert.deepEqual(resume?.params, {
      threadId: "thr_policy",
      excludeTurns: true,
      cwd,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      config: { web_search: "indexed" },
    });
    const continuedTurn = fake.messages
      .filter((message) => message.method === "turn/start")
      .at(-1);
    assert.deepEqual(continuedTurn?.params, {
      threadId: "thr_policy",
      model: "m",
      input: [{ type: "text", text: "continue", text_elements: [] }],
      cwd,
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });

    const beforeContinuation = fake.messages.length;
    const changed = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...request,
        previous_response_id: continuedBody.id,
        x_codex: { ...request.x_codex, sandbox: "read-only" },
      }),
    });
    assert.equal(changed.status, 409);
    assert.equal(
      ((await changed.json()) as { error: { code: string } }).error.code,
      "continuation_policy_mismatch",
    );
    assert.equal(fake.messages.length, beforeContinuation);

    const changedWeb = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...request,
        previous_response_id: continuedBody.id,
        x_codex: { ...request.x_codex, web_search: "disabled" },
      }),
    });
    assert.equal(changedWeb.status, 409);
    assert.equal(
      ((await changedWeb.json()) as { error: { code: string } }).error.code,
      "continuation_policy_mismatch",
    );
    assert.equal(fake.messages.length, beforeContinuation);

    const managedFake = policyCapturingAppServer();
    proxy.setTransport(managedFake.rpc, {
      ...UNRESTRICTED_POLICY_REQUIREMENTS,
      allowedApprovalPolicies: ["on-request"],
      allowedApprovalsReviewers: ["user"],
    });
    const changedManagedPolicy = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...request,
        previous_response_id: continuedBody.id,
      }),
    });
    assert.equal(changedManagedPolicy.status, 409);
    assert.equal(
      (
        (await changedManagedPolicy.json()) as {
          error: { code: string };
        }
      ).error.code,
      "continuation_policy_mismatch",
    );
    assert.deepEqual(managedFake.messages, []);

    const disabledFake = policyCapturingAppServer();
    proxy.setTransport(disabledFake.rpc, UNRESTRICTED_POLICY_REQUIREMENTS);
    const disabled = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "offline" }],
      }),
    });
    assert.equal(disabled.status, 200);
    assert.deepEqual(
      disabledFake.messages.find((message) => message.method === "thread/start")
        ?.params,
      {
        model: "m",
        ephemeral: false,
        cwd: root,
        sandbox: "read-only",
        approvalPolicy: "never",
        approvalsReviewer: "auto_review",
        config: { web_search: "disabled" },
      },
    );
    assert.deepEqual(
      disabledFake.messages.find((message) => message.method === "turn/start")
        ?.params,
      {
        threadId: "thr_policy",
        model: "m",
        input: [{ type: "text", text: "offline", text_elements: [] }],
        cwd: root,
        approvalPolicy: "never",
        approvalsReviewer: "auto_review",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
    );

    const deniedFake = policyCapturingAppServer();
    proxy.setTransport(deniedFake.rpc, {
      ...UNRESTRICTED_POLICY_REQUIREMENTS,
      allowedSandboxModes: ["read-only"],
    });
    const denied = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(denied.status, 400);
    assert.equal(
      ((await denied.json()) as { error: { code: string } }).error.code,
      "sandbox_not_allowed",
    );
    assert.deepEqual(deniedFake.messages, []);
  } finally {
    await proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
});
