import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { EventNormalizer, normalizeNotification } from "../../src/http/chat.js";
import { createLogger } from "../../src/core/logger.js";
import type { ProxyServer } from "../../src/http/server.js";
import {
  protocolNotification,
  protocolResponse,
  protocolServerRequest,
  protocolThread,
  protocolThreadResumeResponse,
  protocolThreadStartResponse,
  protocolTurn,
} from "../support/protocol-fixtures.js";
import {
  UNRESTRICTED_POLICY_REQUIREMENTS,
  type PolicyRequirements,
} from "../../src/core/policy.js";
import { startProxyWithTransport } from "../support/http.js";
import { silentLogger } from "../support/logger.js";
import { withTempDir } from "../support/temp.js";
import {
  completeTurn,
  createFakeTransport,
  type FakeTransport,
} from "../support/transport.js";

/** Minimal fake transport view accepted when replacing an HTTP test transport. */
type ChatTestTransport = Pick<FakeTransport, "rpc">;

/** Creates an offline fake app-server transport with deliberately split frames. */
function fakeAppServer(
  complete = true,
  onInterrupt: () => void = () => {},
  requestTool = false,
): FakeTransport {
  let thread = "";
  return createFakeTransport({
    fragmentCount: 2,
    onMessage(rawMessage, send) {
      const message = rawMessage as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      if (message.method === "thread/start") {
        thread = "thr_test";
        send(
          protocolResponse(
            "thread/start",
            message.id,
            protocolThreadStartResponse(protocolThread(thread)),
          ),
        );
      } else if (message.method === "thread/inject_items") {
        send(protocolResponse("thread/inject_items", message.id, {}));
      } else if (message.method === "turn/start") {
        send(
          protocolResponse("turn/start", message.id, {
            turn: protocolTurn("turn_test", "inProgress"),
          }),
        );
        if (requestTool) {
          send(
            protocolServerRequest({
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
            }),
          );
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
          completeTurn(send, thread, "turn_test");
        }
      } else if (message.method === "turn/interrupt") {
        onInterrupt();
        send(protocolResponse("turn/interrupt", message.id, {}));
      }
    },
  });
}

/** Captures exact policy-bearing RPC params for one completed fake turn. */
function policyCapturingAppServer(): {
  rpc: FakeTransport["rpc"];
  messages: Array<Record<string, unknown>>;
} {
  const messages: Array<Record<string, unknown>> = [];
  const fake = createFakeTransport({
    onMessage(message, send) {
      if (typeof message.method !== "string") return;
      messages.push(message);
      const id = message.id as number;
      if (message.method === "thread/start")
        send(
          protocolResponse(
            "thread/start",
            id,
            protocolThreadStartResponse(protocolThread("thr_policy")),
          ),
        );
      else if (message.method === "thread/read")
        send(
          protocolResponse("thread/read", id, {
            thread: protocolThread("thr_policy"),
          }),
        );
      else if (message.method === "thread/resume")
        send(
          protocolResponse(
            "thread/resume",
            id,
            protocolThreadResumeResponse(protocolThread("thr_policy")),
          ),
        );
      else if (message.method === "thread/inject_items")
        send(protocolResponse("thread/inject_items", id, {}));
      else if (message.method === "turn/start") {
        send(
          protocolResponse("turn/start", id, {
            turn: protocolTurn("turn_policy", "inProgress"),
          }),
        );
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
    },
  });
  return { rpc: fake.rpc, messages };
}

/** Creates a fake turn with queued tool requests followed by an ingress failure. */
function failingIngressAppServer(mode: "overflow" | "mismatch" | "suspend"): {
  rpc: FakeTransport["rpc"];
  responderErrors: number[];
  interruptCount(): number;
} {
  const responderErrors: number[] = [];
  let interrupts = 0;
  const fake = createFakeTransport({
    onMessage(rawMessage, send) {
      const message = rawMessage as {
        id: number;
        method?: string;
        error?: unknown;
      };
      if (message.method === "thread/start")
        send(
          protocolResponse(
            "thread/start",
            message.id,
            protocolThreadStartResponse(protocolThread("thr_overflow")),
          ),
        );
      else if (message.method === "turn/start") {
        send(
          protocolResponse("turn/start", message.id, {
            turn: protocolTurn("turn_overflow", "inProgress"),
          }),
        );
        for (const id of [7001, 7002])
          send(
            protocolServerRequest({
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
            }),
          );
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
        send(protocolResponse("turn/interrupt", message.id, {}));
      } else if (message.error !== undefined) responderErrors.push(message.id);
    },
  });
  return {
    rpc: fake.rpc,
    responderErrors,
    interruptCount: () => interrupts,
  };
}

/** Creates a turn that fails only after turn/start has committed successfully. */
function lateFailureAppServer(mode: "transport" | "event"): FakeTransport {
  const fake = createFakeTransport({
    onMessage(rawMessage, send) {
      const message = rawMessage as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      if (message.method === "thread/start")
        send(
          protocolResponse(
            "thread/start",
            message.id,
            protocolThreadStartResponse(protocolThread("thr_failure")),
          ),
        );
      else if (message.method === "turn/start") {
        send(
          protocolResponse("turn/start", message.id, {
            turn: protocolTurn("turn_failure", "inProgress"),
          }),
        );
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
          setImmediate(() => fake.rpc.close(new Error("transport lost")));
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
        send(protocolResponse("turn/interrupt", message.id, {}));
    },
  });
  return fake;
}

/** Creates a silent first turn and a successful second turn on one thread. */
function recoverableAppServer(): {
  rpc: FakeTransport["rpc"];
  wasInterrupted(): boolean;
} {
  let turns = 0;
  let interrupted = false;
  const fake = createFakeTransport({
    onMessage(rawMessage, send) {
      const message = rawMessage as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      if (message.method === "thread/start")
        send(
          protocolResponse(
            "thread/start",
            message.id,
            protocolThreadStartResponse(protocolThread("thr_recover")),
          ),
        );
      else if (message.method === "turn/start") {
        const turnId = `turn_recover_${++turns}`;
        send(
          protocolResponse("turn/start", message.id, {
            turn: protocolTurn(turnId, "inProgress"),
          }),
        );
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
        send(protocolResponse("turn/interrupt", message.id, {}));
      }
    },
  });
  return {
    rpc: fake.rpc,
    wasInterrupted: () => interrupted,
  };
}

/** Creates a completed turn containing duplicate unknown global notifications. */
function unknownEventAppServer(secret: string): FakeTransport {
  return createFakeTransport({
    onMessage(rawMessage, send) {
      const message = rawMessage as { id: number; method: string };
      if (message.method === "thread/start")
        send(
          protocolResponse(
            "thread/start",
            message.id,
            protocolThreadStartResponse(protocolThread("thr_unknown")),
          ),
        );
      else if (message.method === "turn/start") {
        send(
          protocolResponse("turn/start", message.id, {
            turn: protocolTurn("turn_unknown", "inProgress"),
          }),
        );
        // Unknown future events deliberately cannot satisfy the generated union.
        for (let index = 0; index < 2; index += 1)
          send({
            method: "future/diagnostic",
            params: { detail: `${secret} https://secret.example/token=abc` },
          });
        send(
          protocolNotification({
            method: "item/agentMessage/delta",
            params: {
              threadId: "thr_unknown",
              turnId: "turn_unknown",
              itemId: "message",
              delta: "Hello",
            },
          }),
        );
        send(
          protocolNotification({
            method: "turn/completed",
            params: {
              threadId: "thr_unknown",
              turn: protocolTurn("turn_unknown", "completed"),
            },
          }),
        );
      }
    },
  });
}

/** Creates an ordered multi-megabyte stream that exercises HTTP drain behavior. */
function backpressureAppServer(): FakeTransport {
  return createFakeTransport({
    onMessage(rawMessage, send) {
      const message = rawMessage as { id: number; method: string };
      if (message.method === "thread/start")
        send(
          protocolResponse(
            "thread/start",
            message.id,
            protocolThreadStartResponse(protocolThread("thr_slow")),
          ),
        );
      else if (message.method === "turn/start") {
        send(
          protocolResponse("turn/start", message.id, {
            turn: protocolTurn("turn_slow", "inProgress"),
          }),
        );
        for (let index = 0; index < 128; index += 1)
          send(
            protocolNotification({
              method: "item/agentMessage/delta",
              params: {
                threadId: "thr_slow",
                turnId: "turn_slow",
                itemId: "message",
                delta: `${String(index).padStart(3, "0")}:${"x".repeat(32 * 1024)}`,
              },
            }),
          );
        send(
          protocolNotification({
            method: "turn/completed",
            params: {
              threadId: "thr_slow",
              turn: protocolTurn("turn_slow", "completed"),
            },
          }),
        );
      } else if (message.method === "turn/interrupt")
        send(protocolResponse("turn/interrupt", message.id, {}));
    },
  });
}

/** Creates two active turns while flooding notifications for a third turn. */
function foreignFloodAppServer(): FakeTransport {
  let nextThread = 0;
  const turns: Array<{ threadId: string; turnId: string }> = [];
  return createFakeTransport({
    onMessage(rawMessage, send) {
      const message = rawMessage as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      if (message.method === "thread/start") {
        const threadId = `thr_active_${++nextThread}`;
        send(
          protocolResponse(
            "thread/start",
            message.id,
            protocolThreadStartResponse(protocolThread(threadId)),
          ),
        );
      } else if (message.method === "turn/start") {
        const threadId = String(message.params.threadId);
        const turnId = `turn_${threadId}`;
        turns.push({ threadId, turnId });
        send(
          protocolResponse("turn/start", message.id, {
            turn: protocolTurn(turnId, "inProgress"),
          }),
        );
        if (turns.length === 2)
          setImmediate(() => {
            for (let index = 0; index < 2_048; index += 1)
              send(
                protocolNotification({
                  method: "item/agentMessage/delta",
                  params: {
                    threadId: "thr_foreign",
                    turnId: "turn_foreign",
                    itemId: "foreign_message",
                    delta: ".",
                  },
                }),
              );
            // Correlation-less known notifications are malformed wire input. Once
            // a turn is established they must be rejected before ingress accounting.
            for (let index = 0; index < 2_048; index += 1)
              send({
                method: "item/agentMessage/delta",
                params: { itemId: "missing_correlation", delta: "." },
              });
            for (const active of turns) {
              send(
                protocolNotification({
                  method: "item/agentMessage/delta",
                  params: {
                    ...active,
                    itemId: `message_${active.threadId}`,
                    delta: active.threadId,
                  },
                }),
              );
              send(
                protocolNotification({
                  method: "turn/completed",
                  params: {
                    threadId: active.threadId,
                    turn: protocolTurn(active.turnId, "completed"),
                  },
                }),
              );
            }
          });
      } else if (message.method === "turn/interrupt")
        send({ id: message.id, result: {} });
    },
  });
}

/** Runs an HTTP assertion against an ephemeral, ready offline proxy. */
async function withChatServer(
  run: (
    origin: string,
    proxy: ProxyServer,
    useTransport: (
      fake: ChatTestTransport,
      requirements?: PolicyRequirements,
    ) => void,
  ) => Promise<void>,
  requestTimeoutMs = 30_000,
  stateDir = `${tmpdir()}/codex-proxy-chat-tests-${process.pid}`,
  logger = silentLogger,
): Promise<void> {
  const initial = fakeAppServer();
  let proxy: ProxyServer | undefined;
  try {
    const started = await startProxyWithTransport(initial.rpc, {
      root: await realpath("."),
      stateDir,
      requestTimeoutMs,
      log: logger,
    });
    proxy = started.proxy;
    const useTransport = (
      fake: ChatTestTransport,
      requirements = UNRESTRICTED_POLICY_REQUIREMENTS,
    ): void => {
      proxy!.setTransport(fake.rpc, requirements);
    };
    await run(started.origin, proxy, useTransport);
  } finally {
    proxy?.setReady(false);
    proxy?.setTransport(undefined);
    await proxy?.close();
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
  const orphan = normalizer.normalize("item/mcpToolCall/progress", {
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
      function: { name: "mcpToolCall_progress", arguments: "{}" },
    },
  ]);
  assert.equal(
    (orphan[0]?.delta?.tool_results as Array<{ id: string }>)[0]?.id,
    "orphan",
  );
});

test("exposes pinned item/plan/delta notifications as self-correlating progress", () => {
  const normalizer = new EventNormalizer();
  const notification = protocolNotification({
    method: "item/plan/delta",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "plan",
      delta: "step one",
    },
  });
  const progress = normalizer.normalize(
    notification.method,
    notification.params,
  );
  assert.deepEqual(progress[0]?.delta?.tool_calls, [
    {
      index: 0,
      id: "plan",
      type: "function",
      function: { name: "plan_delta", arguments: "{}" },
    },
  ]);
  assert.equal(
    (progress[0]?.delta?.tool_results as Array<{ id: string }>)[0]?.id,
    "plan",
  );
});

test("keeps unstable auto-approval review notifications out of HTTP output", () => {
  const normalizer = new EventNormalizer();
  const action = {
    type: "networkAccess" as const,
    target: "fixture target",
    host: "fixture.invalid",
    protocol: "https" as const,
    port: 443,
  };
  const started = protocolNotification({
    method: "item/autoApprovalReview/started",
    params: {
      threadId: "thread",
      turnId: "turn",
      startedAtMs: 0,
      reviewId: "review_1",
      targetItemId: null,
      review: {
        status: "inProgress",
        riskLevel: null,
        userAuthorization: null,
        rationale: null,
      },
      action,
    },
  });
  const completed = protocolNotification({
    method: "item/autoApprovalReview/completed",
    params: {
      threadId: "thread",
      turnId: "turn",
      startedAtMs: 0,
      completedAtMs: 1,
      reviewId: "review_1",
      targetItemId: null,
      decisionSource: "agent",
      review: {
        status: "approved",
        riskLevel: "low",
        userAuthorization: "high",
        rationale: "fixture review",
      },
      action,
    },
  });

  assert.deepEqual(normalizer.normalize(started.method, started.params), []);
  assert.deepEqual(
    normalizer.normalize(completed.method, completed.params),
    [],
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

test("strips replayed assistant reasoning before injecting visible history", async () => {
  await withChatServer(async (origin, _proxy, useTransport) => {
    const fake = policyCapturingAppServer();
    useTransport(fake);
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        reasoning_effort: "high",
        messages: [
          { role: "user", content: "input1" },
          {
            role: "assistant",
            reasoning: "reasoning from the first response",
            tool_calls: [
              {
                id: "internal_command",
                type: "function",
                function: {
                  name: "commandExecution",
                  arguments: '{"command":"pwd"}',
                },
              },
            ],
            tool_results: [
              {
                id: "internal_command",
                type: "function",
                function: {
                  name: "commandExecution",
                  arguments: '{"command":"pwd"}',
                },
                result: {
                  status: "in_progress",
                  progress_type: "outputDelta",
                  content: "workspace output",
                },
              },
              {
                id: "internal_command",
                type: "function",
                function: {
                  name: "commandExecution",
                  arguments: '{"command":"pwd"}',
                },
                result: {
                  status: "completed",
                  content: "workspace output",
                  exit_code: 0,
                },
              },
            ],
            content: "message from the first response",
          },
          { role: "user", content: "input2" },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const injected = fake.messages.find(
      (message) => message.method === "thread/inject_items",
    );
    assert.deepEqual(injected?.params, {
      threadId: "thr_policy",
      items: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "input1" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "message from the first response",
            },
          ],
        },
      ],
    });
    const turn = fake.messages.find(
      (message) => message.method === "turn/start",
    );
    assert.deepEqual(turn?.params, {
      threadId: "thr_policy",
      model: "m",
      effort: "high",
      summary: "detailed",
      input: [{ type: "text", text: "input2", text_elements: [] }],
      cwd: await realpath("."),
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
  });
});

test("reasoning effort none disables app-server reasoning summaries", async () => {
  await withChatServer(async (origin, _proxy, useTransport) => {
    const fake = policyCapturingAppServer();
    useTransport(fake);
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        reasoning_effort: "none",
        messages: [{ role: "user", content: "answer" }],
      }),
    });
    assert.equal(response.status, 200);
    const turn = fake.messages.find(
      (message) => message.method === "turn/start",
    );
    assert.equal((turn?.params as Record<string, unknown>)?.effort, "none");
    assert.equal((turn?.params as Record<string, unknown>)?.summary, "none");
  });
});

test("app-server reasoning summaries default to detailed", async () => {
  await withChatServer(async (origin, _proxy, useTransport) => {
    const fake = policyCapturingAppServer();
    useTransport(fake);
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "answer" }],
      }),
    });
    assert.equal(response.status, 200);
    const turn = fake.messages.find(
      (message) => message.method === "turn/start",
    );
    assert.equal((turn?.params as Record<string, unknown>)?.effort, undefined);
    assert.equal(
      (turn?.params as Record<string, unknown>)?.summary,
      "detailed",
    );
  });
});

test("aggregate tool-only responses use null content", async () => {
  await withChatServer(async (origin, _proxy, useTransport) => {
    useTransport(fakeAppServer(true, () => {}, true));
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
    await withChatServer(async (origin, _proxy, useTransport) => {
      useTransport(lateFailureAppServer(mode));
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
  await withChatServer(async (origin, proxy, useTransport) => {
    const fake = recoverableAppServer();
    useTransport(fake);
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
  await withTempDir(async (directory) => {
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
      30_000,
      directory,
    );
  }, "codex-persist-failure-");
});

test("request timeout wakes a silent turn and closes its SSE stream", async () => {
  await withChatServer(async (origin, _proxy, useTransport) => {
    useTransport(fakeAppServer(false));
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
  }, 50);
});

test("rejects ambiguous history and unknown continuation before app-server work", async () => {
  await withChatServer(async (origin) => {
    for (const body of [
      {
        model: "m",
        messages: [{ role: "assistant", content: "not a user turn" }],
      },
      { model: "m", messages: [{ role: "tool", content: "x" }] },
      {
        model: "m",
        messages: [{ role: "user", content: "x", reasoning: "not allowed" }],
      },
      {
        model: "m",
        messages: [
          { role: "assistant", content: "x", reasoning: { text: "bad" } },
          { role: "user", content: "continue" },
        ],
      },
      {
        model: "m",
        messages: [
          { role: "user", content: "x", tool_results: [] },
          { role: "user", content: "continue" },
        ],
      },
      {
        model: "m",
        messages: [
          {
            role: "assistant",
            content: "x",
            tool_calls: [
              {
                id: "call_a",
                type: "function",
                function: { name: "commandExecution", arguments: "{}" },
              },
            ],
            tool_results: [
              {
                id: "foreign_call",
                type: "function",
                function: { name: "commandExecution", arguments: "{}" },
                result: { status: "completed" },
              },
            ],
          },
          { role: "user", content: "continue" },
        ],
      },
      {
        model: "m",
        reasoning_effort: "ultra",
        messages: [{ role: "user", content: "x" }],
      },
      {
        model: "m",
        reasoning_effort: 1,
        messages: [{ role: "user", content: "x" }],
      },
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
  await withChatServer(async (origin, _proxy, useTransport) => {
    let interrupted = false;
    useTransport(
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

test("unknown app-server events produce one transport-scoped safe diagnostic", async () => {
  await withTempDir(async (directory) => {
    const secret = `${await realpath(".")} https://secret.example/token=abc`;
    const entries: Array<Record<string, unknown>> = [];
    const logger = createLogger("debug", (entry) => entries.push(entry));
    await withChatServer(
      async (origin, _proxy, useTransport) => {
        useTransport(unknownEventAppServer(secret));
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await fetch(`${origin}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: "m",
              messages: [{ role: "user", content: "x" }],
            }),
          });
          assert.equal(response.status, 200);
          assert.equal(
            (
              (await response.json()) as {
                choices: [{ message: { content: string } }];
              }
            ).choices[0].message.content,
            "Hello",
          );
        }
      },
      30_000,
      join(directory, "state"),
      logger,
    );
    const diagnostics = entries.filter(
      (entry) => entry.event === "unknown_app_server_event",
    );
    assert.equal(diagnostics.length, 1);
    assert.match(String(diagnostics[0]?.method_fingerprint), /^[a-f0-9]{16}$/);
    assert.equal(diagnostics[0]?.params_type, "object");
    assert.deepEqual(diagnostics[0]?.field_fingerprints, ["9c0211c51d04574f"]);
    assert.equal("request_id" in diagnostics[0]!, false);
    assert.equal(JSON.stringify(entries).includes(secret), false);
  }, "codex-unknown-event-");
});

test("a paused real SSE client drains bounded frames in order", async () => {
  await withChatServer(async (origin, proxy, useTransport) => {
    useTransport(backpressureAppServer());
    let drains = 0;
    let maxWritableLength = 0;
    proxy.server.prependOnceListener("request", (_request, response) => {
      response.on("drain", () => {
        drains += 1;
      });
      const monitor = setInterval(() => {
        maxWritableLength = Math.max(
          maxWritableLength,
          response.writableLength,
        );
      }, 1);
      monitor.unref();
      response.once("close", () => clearInterval(monitor));
    });
    const url = new URL(`${origin}/v1/chat/completions`);
    const body = JSON.stringify({
      model: "m",
      stream: true,
      messages: [{ role: "user", content: "x" }],
    });
    const response = await new Promise<http.IncomingMessage>(
      (resolve, reject) => {
        const request = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          resolve,
        );
        request.once("error", reject);
        request.end(body);
      },
    );
    response.pause();
    await new Promise((resolve) => setTimeout(resolve, 50));
    let raw = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      raw += chunk;
    });
    response.resume();
    await once(response, "end");

    const frames = raw
      .split("\n\n")
      .filter(Boolean)
      .map((frame) => frame.slice(6));
    assert.equal(frames.at(-1), "[DONE]");
    const indexes = frames
      .slice(0, -1)
      .map(
        (frame) =>
          JSON.parse(frame) as { choices?: [{ delta?: { content?: string } }] },
      )
      .map((frame) => frame.choices?.[0]?.delta?.content)
      .filter((content): content is string => content !== undefined)
      .map((content) => Number(content.slice(0, 3)));
    assert.deepEqual(
      indexes,
      Array.from({ length: 128 }, (_, index) => index),
    );
    assert.ok(drains > 0, "server never observed writable backpressure");
    assert.ok(
      maxWritableLength < 128 * 1024,
      `buffer grew to ${maxWritableLength}`,
    );
  }, 60_000);
}, 70_000);

test("ingress overflow interrupts the turn and rejects every queued tool responder", async () => {
  await withChatServer(async (origin, _proxy, useTransport) => {
    const fake = failingIngressAppServer("overflow");
    useTransport(fake);
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

test("concurrent foreign notifications do not consume ingress capacity", async () => {
  await withChatServer(async (origin, _proxy, useTransport) => {
    useTransport(foreignFloodAppServer());
    const request = (content: string): Promise<Response> =>
      fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content }],
        }),
      });
    const responses = await Promise.all([request("one"), request("two")]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      const content = (
        (await response.json()) as {
          choices: [{ message: { content: string } }];
        }
      ).choices[0].message.content;
      assert.match(content, /^thr_active_[12]$/);
    }
  });
});

test("dynamic correlation failure rejects every captured responder", async () => {
  await withChatServer(async (origin, _proxy, useTransport) => {
    const fake = failingIngressAppServer("mismatch");
    useTransport(fake);
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
  await withTempDir(async (directory) => {
    await withChatServer(
      async (origin, _proxy, useTransport) => {
        const fake = failingIngressAppServer("suspend");
        useTransport(fake);
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
      30_000,
      directory,
    );
  }, "codex-suspend-failure-");
});

test("request policies map exactly, bind continuations, and honor managed denials", async () => {
  await withTempDir(async (directory) => {
    const configuredRoot = join(directory, "root");
    const configuredCwd = join(configuredRoot, "project");
    await mkdir(configuredCwd, { recursive: true });
    const root = await realpath(configuredRoot);
    const cwd = await realpath(configuredCwd);
    const fake = policyCapturingAppServer();
    let proxy: ProxyServer | undefined;
    try {
      const started = await startProxyWithTransport(fake.rpc, {
        root,
        stateDir: join(directory, "state"),
      });
      proxy = started.proxy;
      const origin = started.origin;
      const request = {
        model: "m",
        reasoning_effort: "high",
        messages: [{ role: "user", content: "policy" }],
        x_codex: {
          cwd,
          sandbox: "workspace-write",
          web_search: "indexed",
        },
      };
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
        effort: "high",
        summary: "detailed",
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
        effort: "high",
        summary: "detailed",
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
      const changedManagedPolicy = await fetch(
        `${origin}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...request,
            previous_response_id: continuedBody.id,
          }),
        },
      );
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
        disabledFake.messages.find(
          (message) => message.method === "thread/start",
        )?.params,
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
          summary: "detailed",
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
      proxy?.setReady(false);
      proxy?.setTransport(undefined);
      await proxy?.close();
    }
  }, "codex-policy-http-");
});

test("refreshing managed requirements on an unchanged transport takes effect", async () => {
  await withTempDir(async (directory) => {
    const root = await realpath(directory);
    const fake = policyCapturingAppServer();
    let proxy: ProxyServer | undefined;
    try {
      const started = await startProxyWithTransport(fake.rpc, {
        root,
        stateDir: join(directory, "state"),
        requirements: {
          ...UNRESTRICTED_POLICY_REQUIREMENTS,
          allowedSandboxModes: ["read-only"],
        },
      });
      proxy = started.proxy;
      const body = JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        x_codex: { sandbox: "workspace-write" },
      });
      const send = (): Promise<Response> =>
        fetch(`${started.origin}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
      const denied = await send();
      assert.equal(denied.status, 400);
      assert.equal(
        ((await denied.json()) as { error: { code: string } }).error.code,
        "sandbox_not_allowed",
      );
      // Same transport instance, relaxed requirements: the refresh must apply
      // rather than being discarded by the same-transport short-circuit.
      proxy.setTransport(fake.rpc, UNRESTRICTED_POLICY_REQUIREMENTS);
      assert.equal((await send()).status, 200);
    } finally {
      proxy?.setReady(false);
      proxy?.setTransport(undefined);
      await proxy?.close();
    }
  }, "codex-policy-refresh-");
});
