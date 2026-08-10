import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import {
  EventNormalizer,
  HANDLED_NOTIFICATION_METHODS,
  type Usage,
} from "../../src/http/chat-normalize.js";
import { createLogger, type Logger } from "../../src/core/logger.js";
import type { ProxyServer } from "../../src/http/server.js";
import {
  protocolNotification,
  protocolRateLimitSnapshot,
  protocolRateLimitsResponse,
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
import type { CodexErrorInfo } from "../../protocol/generated/typescript/v2/CodexErrorInfo.js";
import type { TokenUsageBreakdown } from "../../protocol/generated/typescript/v2/TokenUsageBreakdown.js";
import {
  parseSseChunks,
  parseSseFrames,
  startProxyWithTransport,
} from "../support/http.js";
import { silentLogger } from "../support/logger.js";
import { withTempDir } from "../support/temp.js";
import {
  completeRawResponseBatch,
  completeTurn,
  createFakeTransport,
  interruptTurn,
  sendTokenUsage,
  suspendWithTools,
  tokenUsageFixture,
  type FakeTransport,
  type UsageWireOrder,
} from "../support/transport.js";

/** Minimal fake transport view accepted when replacing an HTTP test transport. */
type ChatTestTransport = Pick<FakeTransport, "rpc">;

/** One decoded streaming chunk with the fields these tests assert on. */
interface StreamedChunk {
  choices?: Array<{
    delta?: { content?: string; reasoning?: string };
    finish_reason?: string | null;
  }>;
  usage?: Usage;
}

/** In-memory structured logs and the logger that appends to them. */
interface CapturedLogs {
  entries: Array<Record<string, unknown>>;
  log: Logger;
}

/** Creates a warning-level logger whose entries never leave process memory. */
function captureLogs(): CapturedLogs {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    log: createLogger("warn", (entry) => entries.push(entry)),
  };
}

/** Selects entries for one structured event from an in-memory capture. */
function capturedEvent(
  entries: Array<Record<string, unknown>>,
  event: string,
): Array<Record<string, unknown>> {
  return entries.filter((entry) => entry.event === event);
}

/** Decodes one complete SSE body into its chunks, asserting the DONE frame. */
function streamedChunks(body: string): StreamedChunk[] {
  return parseSseChunks<StreamedChunk>(body);
}

/** Turn behavior selected by one offline fake app-server. */
interface FakeAppServerOptions {
  complete?: boolean;
  onInterrupt?: () => void;
  requestTool?: boolean;
  usageOrder?: UsageWireOrder;
  usageOnCompletion?: boolean;
  usageAfterTool?: boolean;
  extraModelRequest?: boolean;
}

/** Creates an offline fake app-server transport with deliberately split frames. */
function fakeAppServer({
  complete = true,
  onInterrupt = () => {},
  requestTool = false,
  usageOrder = "before_completion",
  usageOnCompletion = true,
  usageAfterTool = false,
  extraModelRequest = false,
}: FakeAppServerOptions = {}): FakeTransport {
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
          suspendWithTools(send, thread, "turn_test", [
            {
              id: 8_001,
              callId: "call_lookup",
              tool: "lookup",
              arguments: { key: "value" },
            },
          ]);
          return;
        }
        // A turn that runs internal activity spans several model requests, each
        // reporting its own usage against grown cumulative counters.
        if (extraModelRequest)
          sendTokenUsage(send, thread, "turn_test", tokenUsageFixture());
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
          completeTurn(send, thread, "turn_test", {
            usageOrder,
            priorRequests: extraModelRequest ? 1 : 0,
            includeUsage: usageOnCompletion,
          });
        }
      } else if (message.method === "turn/interrupt") {
        onInterrupt();
        send(protocolResponse("turn/interrupt", message.id, {}));
        // A tool-call turn ends at its interrupt: live app-server flushes the
        // turn's usage and idle boundary within milliseconds of the ack.
        if (requestTool)
          interruptTurn(send, thread, "turn_test", {
            reasoningOutputTokens: 3,
            includeUsage: usageAfterTool,
          });
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
  let priorRequests = 0;
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
        // Policy assertions are unrelated to missing usage, so reproduce the
        // live terminal sequence and avoid the proxy's defensive grace period.
        completeTurn(send, "thr_policy", "turn_policy", { priorRequests });
        priorRequests += 1;
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
  let turns = 0;
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
        const turnId = `turn_overflow_${++turns}`;
        send(
          protocolResponse("turn/start", message.id, {
            turn: protocolTurn(turnId, "inProgress"),
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
                  mode === "mismatch" && id === 7002 ? "foreign_turn" : turnId,
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
                  turnId,
                  itemId: "flood",
                  delta: ".",
                },
              }),
            );
        else completeRawResponseBatch(send, "thr_overflow", turnId);
      } else if (message.method === "turn/interrupt") {
        interrupts += 1;
        send(protocolResponse("turn/interrupt", message.id, {}));
        if (mode === "suspend")
          send(
            protocolNotification({
              method: "thread/status/changed",
              params: {
                threadId: "thr_overflow",
                status: { type: "idle" },
              },
            }),
          );
      } else if (message.error !== undefined) responderErrors.push(message.id);
    },
  });
  return {
    rpc: fake.rpc,
    responderErrors,
    interruptCount: () => interrupts,
  };
}

/**
 * Creates a turn that completes normally and then loses its transport before
 * the optional trailing usage and idle boundary can arrive.
 */
function completeThenDropTransport(): FakeTransport {
  const fake: FakeTransport = createFakeTransport({
    onMessage(rawMessage, send) {
      const message = rawMessage as { id: number; method: string };
      if (message.method === "thread/start") {
        send(
          protocolResponse(
            "thread/start",
            message.id,
            protocolThreadStartResponse(protocolThread("thr_dropped")),
          ),
        );
        return;
      }
      if (message.method !== "turn/start") return;
      send(
        protocolResponse("turn/start", message.id, {
          turn: protocolTurn("turn_dropped", "inProgress"),
        }),
      );
      send(
        protocolNotification({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thr_dropped",
            turnId: "turn_dropped",
            itemId: "text",
            delta: "Hello",
          },
        }),
      );
      send(
        protocolNotification({
          method: "turn/completed",
          params: {
            threadId: "thr_dropped",
            turn: protocolTurn("turn_dropped", "completed"),
          },
        }),
      );
      // The app-server dies during terminal usage collection, before either a
      // usage update or the thread's idle transition can arrive.
      setImmediate(() => fake.rpc.close(new Error("transport lost")));
    },
  });
  return fake;
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

/** Creates a failing turn that can fail before or after visible stream content. */
function terminalFailureAppServer({
  terminal,
  emitContent = false,
  codexErrorInfo = "usageLimitExceeded",
  message = "Usage limit reached.",
  duplicateTerminal = false,
  resetAt,
}: {
  terminal: "error" | "completed";
  emitContent?: boolean;
  codexErrorInfo?: CodexErrorInfo | null;
  message?: string;
  duplicateTerminal?: boolean;
  resetAt: number;
}): { rpc: FakeTransport["rpc"]; rateLimitReads(): number } {
  let reads = 0;
  const error = {
    message,
    codexErrorInfo,
    additionalDetails: null,
  };
  const fake = createFakeTransport({
    onMessage(rawMessage, send) {
      const message = rawMessage as { id: number; method: string };
      if (message.method === "thread/start") {
        send(
          protocolResponse(
            "thread/start",
            message.id,
            protocolThreadStartResponse(protocolThread("thr_quota")),
          ),
        );
        return;
      }
      if (message.method === "account/rateLimits/read") {
        reads += 1;
        send(
          protocolResponse(
            "account/rateLimits/read",
            message.id,
            protocolRateLimitsResponse(
              protocolRateLimitSnapshot({
                primary: {
                  usedPercent: 100,
                  windowDurationMins: 60,
                  resetsAt: resetAt,
                },
              }),
              null,
            ),
          ),
        );
        return;
      }
      if (message.method !== "turn/start") return;
      send(
        protocolResponse("turn/start", message.id, {
          turn: protocolTurn("turn_quota", "inProgress"),
        }),
      );
      if (emitContent)
        send(
          protocolNotification({
            method: "item/agentMessage/delta",
            params: {
              threadId: "thr_quota",
              turnId: "turn_quota",
              itemId: "message",
              delta: "partial",
            },
          }),
        );
      const report = (): void => {
        if (terminal === "error")
          send(
            protocolNotification({
              method: "error",
              params: {
                threadId: "thr_quota",
                turnId: "turn_quota",
                willRetry: false,
                error,
              },
            }),
          );
        else
          send(
            protocolNotification({
              method: "turn/completed",
              params: {
                threadId: "thr_quota",
                turn: {
                  ...protocolTurn("turn_quota", "failed"),
                  error,
                },
              },
            }),
          );
      };
      report();
      if (duplicateTerminal) report();
    },
  });
  return { rpc: fake.rpc, rateLimitReads: () => reads };
}

/** Creates a first turn with one delta and a successful second turn on one thread. */
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
        if (turns === 1) {
          // Streaming now primes until real output before writing the role, so
          // this delta deterministically reaches the injected write failure.
          send(
            protocolNotification({
              method: "item/agentMessage/delta",
              params: {
                threadId: "thr_recover",
                turnId,
                itemId: "message",
                delta: "primed",
              },
            }),
          );
          return;
        }
        send(
          protocolNotification({
            method: "turn/completed",
            params: {
              threadId: "thr_recover",
              turn: protocolTurn(turnId, "completed"),
            },
          }),
        );
        send(
          protocolNotification({
            method: "thread/status/changed",
            params: { threadId: "thr_recover", status: { type: "idle" } },
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
        send(
          protocolNotification({
            method: "thread/status/changed",
            params: { threadId: "thr_unknown", status: { type: "idle" } },
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
        send(
          protocolNotification({
            method: "thread/status/changed",
            params: { threadId: "thr_slow", status: { type: "idle" } },
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
              send(
                protocolNotification({
                  method: "thread/status/changed",
                  params: {
                    threadId: active.threadId,
                    status: { type: "idle" },
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
  const first = [
    normalizer.dynamicToolCall({
      callId: "call_a",
      name: "lookup",
      arguments: '{"id":1}',
    }),
  ];
  const second = [
    normalizer.dynamicToolCall({
      callId: "call_b",
      name: "other",
      arguments: "{}",
    }),
  ];
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
        pluginId: null,
        scriptPath: null,
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
        pluginId: null,
        scriptPath: null,
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
          cacheWriteInputTokens: 0,
          reasoningOutputTokens: 1,
        },
        last: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cachedInputTokens: 2,
          cacheWriteInputTokens: 0,
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
    new EventNormalizer().normalize(interrupted.method, interrupted.params),
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
    new EventNormalizer().normalize(error.method, error.params)[0]
      ?.terminalError?.message,
    "failed",
  );
});

test("tool lifecycle output is emitted without truncation", () => {
  const normalizer = new EventNormalizer();
  const content = "o".repeat(70 * 1024);
  const message = "m".repeat(10 * 1024);
  const patch = { text: "p".repeat(70 * 1024) };
  normalizer.normalize("item/started", {
    threadId: "thread",
    turnId: "turn",
    item: {
      type: "commandExecution",
      id: "command",
      command: "pwd",
      status: "inProgress",
    },
  });

  const progress = normalizer.normalize("item/commandExecution/outputDelta", {
    threadId: "thread",
    turnId: "turn",
    itemId: "command",
    delta: content,
    message,
    patch,
  })[0]?.delta?.tool_results?.[0]?.result;
  assert.equal(progress?.content, content);
  assert.equal(progress?.message, message);
  assert.deepEqual(progress?.patch, patch);

  const completed = normalizer.normalize("item/completed", {
    threadId: "thread",
    turnId: "turn",
    item: {
      type: "commandExecution",
      id: "command",
      command: "pwd",
      status: "completed",
      aggregatedOutput: content,
    },
  })[0]?.delta?.tool_results?.[0]?.result;
  assert.equal(completed?.content, content);
});

test("hides replayed dynamic lifecycle items without changing continuation finish reason", () => {
  /** Builds a generated dynamic-tool lifecycle notification for this turn. */
  const replayedDynamicTool = (method: "item/started" | "item/completed") => {
    const item = {
      type: "dynamicToolCall" as const,
      id: "call_replayed",
      namespace: null,
      tool: "set-research",
      arguments: { enabled: true },
      success: true,
    };
    if (method === "item/started")
      return protocolNotification({
        method,
        params: {
          threadId: "thread",
          turnId: "continuation",
          startedAtMs: 0,
          item: {
            ...item,
            status: "inProgress",
            contentItems: null,
            durationMs: null,
          },
        },
      });
    return protocolNotification({
      method,
      params: {
        threadId: "thread",
        turnId: "continuation",
        completedAtMs: 1,
        item: {
          ...item,
          status: "completed",
          // This is the byte-for-byte output the client submitted.
          contentItems: [
            {
              type: "inputText",
              text: '{"_oracle":true,"message":"Tool set-research not executed in replay mode."}',
            },
          ],
          durationMs: 1,
        },
      },
    });
  };
  const replayNormalizer = new EventNormalizer();
  for (const method of ["item/started", "item/completed"] as const) {
    const replay = replayedDynamicTool(method);
    assert.deepEqual(
      replayNormalizer.normalize(replay.method, replay.params),
      [],
    );
  }
  const completed = protocolNotification({
    method: "turn/completed",
    params: {
      threadId: "thread",
      turn: protocolTurn("continuation", "completed"),
    },
  });
  assert.deepEqual(
    replayNormalizer.normalize(completed.method, completed.params),
    [{ finishReason: "stop" }],
  );

  const newCallNormalizer = new EventNormalizer();
  const newCall = newCallNormalizer.dynamicToolCall({
    callId: "call_new",
    name: "keep-status-quo",
    arguments: "{}",
  });
  assert.deepEqual(
    newCall.delta?.tool_calls?.map((call) => call.id),
    ["call_new"],
  );
  assert.deepEqual(
    newCallNormalizer.normalize(completed.method, completed.params),
    [{ finishReason: "tool_calls" }],
  );
});

test("attributes every model request of one turn from cumulative usage", () => {
  /** Builds one thread-scoped usage notification from its two breakdowns. */
  const usageNotification = (
    last: TokenUsageBreakdown,
    total: TokenUsageBreakdown,
  ) =>
    protocolNotification({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread",
        turnId: "turn",
        tokenUsage: { last, total, modelContextWindow: null },
      },
    });
  /** Builds one complete breakdown from its distinguishable counters. */
  const breakdown = (
    inputTokens: number,
    cachedInputTokens: number,
    outputTokens: number,
    reasoningOutputTokens: number,
  ): TokenUsageBreakdown => ({
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens,
  });
  const normalizer = new EventNormalizer(breakdown(100, 10, 20, 10));
  /** Normalizes one usage notification down to its single usage event. */
  const usageOf = (notification: ReturnType<typeof usageNotification>) =>
    normalizer.normalize(notification.method, notification.params)[0]?.usage;

  // The thread already carries usage from earlier turns, so this turn owns only
  // what the cumulative totals gain while it runs.
  const first = usageNotification(
    breakdown(10, 2, 5, 4),
    breakdown(110, 12, 25, 14),
  );
  assert.deepEqual(usageOf(first), {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 2 },
    completion_tokens_details: { reasoning_tokens: 4 },
  });
  // A repeated breakdown must not be counted twice.
  assert.deepEqual(usageOf(first), usageOf(first));
  // A second model request in the same turn reports no reasoning of its own,
  // yet the response must still account for the reasoning already streamed.
  const second = usageNotification(
    breakdown(20, 1, 3, 0),
    breakdown(130, 13, 28, 14),
  );
  assert.deepEqual(usageOf(second), {
    prompt_tokens: 30,
    completion_tokens: 8,
    total_tokens: 38,
    prompt_tokens_details: { cached_tokens: 3 },
    completion_tokens_details: { reasoning_tokens: 4 },
  });
  // Cumulative counters dropping means app-server reset them, which ends exact
  // attribution: the reported request is mapped instead of a negative count.
  const afterReset = usageNotification(
    breakdown(5, 0, 1, 0),
    breakdown(5, 0, 1, 0),
  );
  assert.deepEqual(usageOf(afterReset), {
    prompt_tokens: 5,
    completion_tokens: 1,
    total_tokens: 6,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  });
  // Growing beyond the stale pre-reset baseline must not silently re-enable
  // subtraction; this response can now expose only the exact last request.
  const afterResetGrowth = usageNotification(
    breakdown(7, 1, 2, 1),
    breakdown(210, 21, 42, 21),
  );
  assert.deepEqual(usageOf(afterResetGrowth), {
    prompt_tokens: 7,
    completion_tokens: 2,
    total_tokens: 9,
    prompt_tokens_details: { cached_tokens: 1 },
    completion_tokens_details: { reasoning_tokens: 1 },
  });
  // An app-server build that omits a counter cannot be attributed by
  // subtraction either, so its last reported request is mapped as it arrived.
  const partialTotal: Partial<TokenUsageBreakdown> = breakdown(200, 20, 40, 20);
  delete partialTotal.reasoningOutputTokens;
  assert.deepEqual(
    normalizer.normalize("thread/tokenUsage/updated", {
      threadId: "thread",
      turnId: "turn",
      tokenUsage: {
        last: breakdown(9, 1, 4, 2),
        total: partialTotal,
        modelContextWindow: null,
      },
    })[0]?.usage,
    {
      prompt_tokens: 9,
      completion_tokens: 4,
      total_tokens: 13,
      prompt_tokens_details: { cached_tokens: 1 },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  );
});

test("warns at most once when usage attribution has no baseline", () => {
  const captured = captureLogs();
  const normalizer = new EventNormalizer(undefined, {
    log: captured.log,
    requestId: "req_fixture",
  });
  const tokenUsage = tokenUsageFixture();
  const params = { threadId: "thread", turnId: "turn", tokenUsage };

  normalizer.normalize("thread/tokenUsage/updated", params);
  normalizer.normalize("thread/tokenUsage/updated", params);

  const warnings = capturedEvent(
    captured.entries,
    "usage_attribution_degraded",
  );
  assert.equal(warnings.length, 1);
  assert.deepEqual(
    {
      level: warnings[0]?.level,
      request_id: warnings[0]?.request_id,
      reason: warnings[0]?.reason,
    },
    {
      level: "warn",
      request_id: "req_fixture",
      reason: "baseline_missing",
    },
  );
});

test("warns at most once when cumulative usage counters reset", () => {
  const captured = captureLogs();
  const normalizer = new EventNormalizer(tokenUsageFixture(0, 2).total, {
    log: captured.log,
    requestId: "req_fixture",
  });
  const tokenUsage = tokenUsageFixture();
  const params = { threadId: "thread", turnId: "turn", tokenUsage };

  normalizer.normalize("thread/tokenUsage/updated", params);
  normalizer.normalize("thread/tokenUsage/updated", params);

  const warnings = capturedEvent(
    captured.entries,
    "usage_attribution_degraded",
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.request_id, "req_fixture");
  assert.equal(warnings[0]?.reason, "cumulative_reset");
});

test("warns at most once when a usage update omits last", () => {
  const captured = captureLogs();
  const normalizer = new EventNormalizer(tokenUsageFixture().total, {
    log: captured.log,
    requestId: "req_fixture",
  });
  const params = {
    threadId: "thread",
    turnId: "turn",
    tokenUsage: {
      total: tokenUsageFixture().total,
      modelContextWindow: null,
    },
  };

  normalizer.normalize("thread/tokenUsage/updated", params);
  normalizer.normalize("thread/tokenUsage/updated", params);

  const warnings = capturedEvent(
    captured.entries,
    "usage_attribution_degraded",
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.request_id, "req_fixture");
  assert.equal(warnings[0]?.reason, "missing_last");
});

test("warns at most once when usage counters are non-finite", () => {
  const captured = captureLogs();
  const normalizer = new EventNormalizer(tokenUsageFixture().total, {
    log: captured.log,
    requestId: "req_fixture",
  });
  const last = { ...tokenUsageFixture().last, outputTokens: Number.NaN };
  const params = {
    threadId: "thread",
    turnId: "turn",
    tokenUsage: { last, modelContextWindow: null },
  };

  normalizer.normalize("thread/tokenUsage/updated", params);
  normalizer.normalize("thread/tokenUsage/updated", params);

  const warnings = capturedEvent(
    captured.entries,
    "usage_attribution_degraded",
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.request_id, "req_fixture");
  assert.equal(warnings[0]?.reason, "non_finite_counters");
});

test("logger-less usage degradation remains safe", () => {
  const normalizer = new EventNormalizer();
  assert.doesNotThrow(() => {
    normalizer.normalize("thread/tokenUsage/updated", {
      threadId: "thread",
      turnId: "turn",
      tokenUsage: tokenUsageFixture(),
    });
    normalizer.normalize("thread/tokenUsage/updated", {
      threadId: "thread",
      turnId: "turn",
      tokenUsage: { total: tokenUsageFixture().total },
    });
  });
});

test("uses an authoritative baseline when the first observed update is coalesced", () => {
  const normalizer = new EventNormalizer({
    inputTokens: 100,
    cachedInputTokens: 10,
    outputTokens: 20,
    reasoningOutputTokens: 10,
    totalTokens: 120,
  });
  const events = normalizer.normalize("thread/tokenUsage/updated", {
    threadId: "thread",
    turnId: "turn",
    tokenUsage: {
      // The first observed update is for request B, while the cumulative total
      // already includes both A and B.
      last: {
        inputTokens: 20,
        cachedInputTokens: 1,
        cacheWriteInputTokens: 0,
        outputTokens: 3,
        reasoningOutputTokens: 0,
        totalTokens: 23,
      },
      total: {
        inputTokens: 130,
        cachedInputTokens: 13,
        cacheWriteInputTokens: 0,
        outputTokens: 28,
        reasoningOutputTokens: 14,
        totalTokens: 158,
      },
      modelContextWindow: null,
    },
  });
  assert.deepEqual(events[0]?.usage, {
    prompt_tokens: 30,
    completion_tokens: 8,
    total_tokens: 38,
    prompt_tokens_details: { cached_tokens: 3 },
    completion_tokens_details: { reasoning_tokens: 4 },
  });
});

test("hands the next response a boundary even when nothing was attributed", () => {
  const baseline = {
    inputTokens: 100,
    cachedInputTokens: 10,
    outputTokens: 20,
    reasoningOutputTokens: 10,
    totalTokens: 120,
  };
  /** Builds one usage notification from its optional breakdowns. */
  const usage = (
    last: Record<string, number> | undefined,
    total: Record<string, number>,
  ) => ({
    threadId: "thread",
    turnId: "turn",
    tokenUsage: {
      ...(last ? { last } : {}),
      total,
      modelContextWindow: null,
    },
  });
  const total = {
    inputTokens: 130,
    cachedInputTokens: 13,
    cacheWriteInputTokens: 0,
    outputTokens: 28,
    reasoningOutputTokens: 14,
    totalTokens: 158,
  };
  const last = {
    inputTokens: 20,
    cachedInputTokens: 1,
    cacheWriteInputTokens: 0,
    outputTokens: 3,
    reasoningOutputTokens: 0,
    totalTokens: 23,
  };

  // A response that observed nothing hands forward the boundary it started
  // from, so the requests it could not report are attributed by its successor.
  const unreported = new EventNormalizer(baseline);
  assert.deepEqual(unreported.usageBoundary(), baseline);
  assert.notEqual(unreported.usageBoundary(), baseline);

  // A total whose delta was never emitted must not advance the boundary past
  // tokens no response reported.
  assert.deepEqual(
    unreported.normalize("thread/tokenUsage/updated", usage(undefined, total)),
    [],
  );
  assert.deepEqual(unreported.usageBoundary(), baseline);

  // Once a delta is reported, the newest total becomes the next boundary.
  unreported.normalize("thread/tokenUsage/updated", usage(last, total));
  assert.deepEqual(unreported.usageBoundary(), {
    inputTokens: 130,
    cachedInputTokens: 13,
    outputTokens: 28,
    reasoningOutputTokens: 14,
    totalTokens: 158,
  });

  // A prerelease mapping without a stored snapshot still has no boundary to
  // offer, preserving the documented one-response last-request fallback.
  assert.equal(new EventNormalizer().usageBoundary(), undefined);
});

test("raw-response completion is handled as an unexposed boundary", () => {
  // `rawResponse/completed` carries exact per-request usage, but it is an
  // internal-only per-request delta. The executor consumes its ordering while
  // the normalizer deliberately excludes its payload from the HTTP surface.
  assert.equal(HANDLED_NOTIFICATION_METHODS.has("rawResponse/completed"), true);
  assert.deepEqual(
    new EventNormalizer().normalize("rawResponse/completed", {
      threadId: "thread",
      turnId: "turn",
      responseId: "resp_1",
      usage: {
        inputTokens: 4,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 2,
        reasoningOutputTokens: 1,
        totalTokens: 6,
      },
    }),
    [],
  );
});

test("backfills completed reasoning without duplicating streamed prefixes", () => {
  /** Builds a completed reasoning item with the supplied final text. */
  const completedReasoning = (
    id: string,
    summary: string[],
    content: string[] = [],
  ) =>
    protocolNotification({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        completedAtMs: 1,
        item: { type: "reasoning", id, summary, content },
      },
    });

  const completionOnly = completedReasoning("completion-only", [
    "final ",
    "summary",
  ]);
  assert.deepEqual(
    new EventNormalizer().normalize(
      completionOnly.method,
      completionOnly.params,
    ),
    [{ delta: { reasoning: "final summary" } }],
  );

  const partial = new EventNormalizer();
  assert.deepEqual(
    partial.normalize("item/reasoning/summaryTextDelta", {
      threadId: "thread",
      turnId: "turn",
      itemId: "partial",
      summaryIndex: 0,
      delta: "final ",
    }),
    [{ delta: { reasoning: "final " } }],
  );
  const partialCompletion = completedReasoning("partial", ["final summary"]);
  assert.deepEqual(
    partial.normalize(partialCompletion.method, partialCompletion.params),
    [{ delta: { reasoning: "summary" } }],
  );

  const fullyStreamed = new EventNormalizer();
  for (const delta of ["final ", "summary"])
    fullyStreamed.normalize("item/reasoning/summaryTextDelta", {
      threadId: "thread",
      turnId: "turn",
      itemId: "complete",
      summaryIndex: 0,
      delta,
    });
  const fullCompletion = completedReasoning("complete", ["final summary"]);
  assert.deepEqual(
    fullyStreamed.normalize(fullCompletion.method, fullCompletion.params),
    [],
  );

  const rawCompletion = completedReasoning("raw", [], ["raw ", "reasoning"]);
  assert.deepEqual(
    new EventNormalizer().normalize(rawCompletion.method, rawCompletion.params),
    [{ delta: { reasoning: "raw reasoning" } }],
  );
});

test("allocates unique call indexes across internal, dynamic, and orphan progress", () => {
  const normalizer = new EventNormalizer();
  const internal = normalizer.normalize("item/started", {
    item: { id: "internal", type: "commandExecution", command: "pwd" },
  });
  const dynamic = normalizer.dynamicToolCall({
    callId: "dynamic",
    name: "lookup",
    arguments: '{"id":1}',
  });
  const laterInternal = normalizer.normalize("item/started", {
    item: { id: "later", type: "webSearch", query: "forecast" },
  });
  const orphan = normalizer.normalize("item/mcpToolCall/progress", {
    itemId: "orphan",
    delta: "working",
  });
  const indexes = [internal[0], dynamic, laterInternal[0], orphan[0]].map(
    (event) => (event?.delta?.tool_calls as Array<{ index: number }>)[0]?.index,
  );
  assert.deepEqual(indexes, [0, 1, 2, 3]);
  assert.deepEqual(orphan[0]?.delta?.tool_calls, [
    {
      index: 3,
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

test("does not repeat arguments when orphan progress precedes item start", () => {
  const normalizer = new EventNormalizer();
  const progress = normalizer.normalize("item/commandExecution/outputDelta", {
    itemId: "command",
    delta: "early output",
  });
  const started = normalizer.normalize("item/started", {
    item: { id: "command", type: "commandExecution", command: "pwd" },
  });
  assert.deepEqual(progress[0]?.delta?.tool_calls, [
    {
      index: 0,
      id: "command",
      type: "function",
      function: { name: "commandExecution_outputDelta", arguments: "{}" },
    },
  ]);
  assert.equal(started[0]?.delta?.tool_calls, undefined);
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
      usage: {
        total_tokens: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    assert.equal(body.choices[0]?.message.content, "Hello");
    assert.equal(body.usage.total_tokens, 6);
    assert.equal(body.usage.prompt_tokens_details?.cached_tokens, 0);
    assert.equal(body.usage.completion_tokens_details?.reasoning_tokens, 0);

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
    const chunks = parseSseChunks(await streaming.text());
    const text = chunks
      .flatMap(
        (chunk) => chunk.choices as Array<{ delta: { content?: string } }>,
      )
      .map((choice) => choice.delta.content ?? "")
      .join("");
    assert.equal(text, "Hello");
    const streamedUsage = chunks.find(
      (chunk) => Array.isArray(chunk.choices) && chunk.choices.length === 0,
    )?.usage as
      | {
          total_tokens: number;
          prompt_tokens_details?: { cached_tokens?: number };
          completion_tokens_details?: { reasoning_tokens?: number };
        }
      | undefined;
    assert.equal(streamedUsage?.total_tokens, 6);
    assert.equal(streamedUsage?.prompt_tokens_details?.cached_tokens, 0);
    assert.equal(streamedUsage?.completion_tokens_details?.reasoning_tokens, 0);
  });
});

test("streaming usage defaults on and only explicit false opts out", async () => {
  await withChatServer(async (origin) => {
    /** Sends one streaming request with the selected stream options. */
    const stream = async (streamOptions?: unknown): Promise<Response> =>
      fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
          ...(streamOptions === undefined
            ? {}
            : { stream_options: streamOptions }),
        }),
      });
    /** Reports whether a successful stream contains its empty-choice usage chunk. */
    const hasUsageChunk = async (response: Response): Promise<boolean> => {
      assert.equal(response.status, 200);
      return streamedChunks(await response.text()).some(
        (chunk) => chunk.choices?.length === 0 && chunk.usage !== undefined,
      );
    };

    assert.equal(await hasUsageChunk(await stream()), true);
    assert.equal(
      await hasUsageChunk(await stream({ include_usage: false })),
      false,
    );
    assert.equal(await hasUsageChunk(await stream({})), true);

    const invalid = await stream({ include_usage: "yes" });
    assert.equal(invalid.status, 400);
  });
});

test("reports usage that app-server streams after turn completion", async () => {
  await withChatServer(async (origin, _proxy, useTransport) => {
    // Usage in the same transport read as the terminal frame is recovered by
    // the drain alone; the streaming case below defers it to a later read so
    // recovery depends on the idle lifecycle boundary rather than timing luck.
    useTransport(fakeAppServer({ usageOrder: "after_completion" }));
    const aggregate = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    assert.equal(aggregate.status, 200);
    const body = (await aggregate.json()) as { usage?: Usage };
    assert.deepEqual(body.usage, {
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });

    useTransport(fakeAppServer({ usageOrder: "later_read" }));
    const streaming = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    assert.equal(streaming.status, 200);
    const chunks = streamedChunks(await streaming.text());
    // The usage chunk stays last, after the chunk carrying the finish reason.
    assert.equal(chunks.at(-2)?.choices?.[0]?.finish_reason, "stop");
    assert.equal(
      (chunks.at(-1)?.usage as Usage | undefined)?.completion_tokens_details
        ?.reasoning_tokens,
      0,
    );
  });
});

test("recovers usage flushed after idle for aggregate and default streaming output", async () => {
  await withChatServer(async (origin, _proxy, useTransport) => {
    useTransport(fakeAppServer({ usageOrder: "after_idle" }));
    const aggregate = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    assert.equal(aggregate.status, 200);
    assert.deepEqual(((await aggregate.json()) as { usage?: Usage }).usage, {
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });

    useTransport(fakeAppServer({ usageOrder: "after_idle" }));
    const streaming = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });
    assert.equal(streaming.status, 200);
    const chunks = streamedChunks(await streaming.text());
    assert.equal(chunks.at(-2)?.choices?.[0]?.finish_reason, "stop");
    assert.deepEqual(chunks.at(-1)?.usage, {
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
  });
});

test("warns once when idle grace expires without usage", async () => {
  const captured = captureLogs();
  await withChatServer(
    async (origin, _proxy, useTransport) => {
      useTransport(fakeAppServer({ usageOnCompletion: false }));
      const response = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        choices: Array<{ finish_reason: string }>;
        usage?: Usage;
      };
      assert.equal(body.choices[0]?.finish_reason, "stop");
      assert.equal(body.usage, undefined);

      const warnings = capturedEvent(captured.entries, "usage_unreported");
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.level, "warn");
      assert.equal(warnings[0]?.reason, "idle_grace_expired");
      assert.equal(warnings[0]?.pending_tool_batch, false);
      assert.equal(typeof warnings[0]?.request_id, "string");
    },
    30_000,
    `${tmpdir()}/codex-proxy-chat-tests-${process.pid}`,
    captured.log,
  );
});

test("keeps a completed turn when the transport dies before optional usage", async () => {
  const captured = captureLogs();
  await withChatServer(
    async (origin, _proxy, useTransport) => {
      useTransport(completeThenDropTransport());
      const aggregate = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });
      // Usage is optional output. Losing the transport while waiting for it must
      // not retract frames the completed turn already earned.
      assert.equal(aggregate.status, 200);
      const body = (await aggregate.json()) as {
        choices: Array<{ finish_reason: string; message: { content: string } }>;
        usage?: Usage;
      };
      assert.equal(body.choices[0]?.finish_reason, "stop");
      assert.equal(body.choices[0]?.message.content, "Hello");
      assert.equal(body.usage, undefined);
      let warnings = capturedEvent(captured.entries, "usage_unreported");
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.reason, "transport_failed");
      assert.equal(warnings[0]?.pending_tool_batch, false);
      assert.equal(typeof warnings[0]?.request_id, "string");

      useTransport(completeThenDropTransport());
      const streaming = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
      assert.equal(streaming.status, 200);
      const text = await streaming.text();
      const chunks = streamedChunks(text);
      assert.equal(chunks.at(-1)?.choices?.[0]?.finish_reason, "stop");
      // A completed stream still terminates normally instead of emitting an error.
      assert.ok(text.includes("data: [DONE]"));
      warnings = capturedEvent(captured.entries, "usage_unreported");
      assert.equal(warnings.length, 2);
      assert.equal(warnings[1]?.reason, "transport_failed");
      assert.equal(warnings[1]?.pending_tool_batch, false);
      assert.equal(typeof warnings[1]?.request_id, "string");
    },
    30_000,
    `${tmpdir()}/codex-proxy-chat-tests-${process.pid}`,
    captured.log,
  );
});

test("reports usage for every model request behind one response", async () => {
  await withChatServer(async (origin, _proxy, useTransport) => {
    useTransport(fakeAppServer({ extraModelRequest: true }));
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { usage?: Usage };
    // Both requests, not the final one alone: two requests of four prompt and
    // two completion tokens each.
    assert.deepEqual(body.usage, {
      prompt_tokens: 8,
      completion_tokens: 4,
      total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
  });
});

test("reports usage captured with a suspended client tool batch", async () => {
  await withChatServer(async (origin, _proxy, useTransport) => {
    useTransport(fakeAppServer({ requestTool: true, usageAfterTool: true }));
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        tools: [
          { type: "function", function: { name: "lookup", parameters: {} } },
        ],
        messages: [{ role: "user", content: "use lookup" }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    assert.equal(response.status, 200);
    const chunks = streamedChunks(await response.text());
    assert.equal(chunks.at(-2)?.choices?.[0]?.finish_reason, "tool_calls");
    assert.equal(
      (chunks.at(-1)?.usage as Usage | undefined)?.completion_tokens_details
        ?.reasoning_tokens,
      3,
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
            // OpenAI-compatible clients replay the same text under their own
            // field name; both must be accepted and both must stay invisible.
            reasoning_content: "reasoning replayed by an AI SDK client",
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
      environments: [],
    });
  });
});

test("a fresh request may end with an assistant message to continue", async () => {
  await withChatServer(async (origin, _proxy, useTransport) => {
    const fake = policyCapturingAppServer();
    useTransport(fake);
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [
          { role: "user", content: "classify this conversation" },
          { role: "assistant", content: "The conversation is" },
        ],
      }),
    });
    assert.equal(response.status, 200);
    // The trailing assistant message joins the injected history and the turn
    // starts with no new input, so the model continues its own prior output.
    const injected = fake.messages.find(
      (message) => message.method === "thread/inject_items",
    );
    assert.deepEqual(injected?.params, {
      threadId: "thr_policy",
      items: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "classify this conversation" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "The conversation is" }],
        },
      ],
    });
    const turn = fake.messages.find(
      (message) => message.method === "turn/start",
    );
    assert.deepEqual((turn?.params as { input: unknown[] }).input, []);
  });
});

test("skips replayed tool-only assistant messages during history injection", async () => {
  await withChatServer(async (origin, _proxy, useTransport) => {
    const fake = policyCapturingAppServer();
    useTransport(fake);
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [
          { role: "user", content: "input1" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "internal_command",
                type: "function",
                function: { name: "commandExecution", arguments: "{}" },
              },
            ],
            tool_results: [
              {
                id: "internal_command",
                type: "function",
                function: { name: "commandExecution", arguments: "{}" },
                result: { status: "completed" },
              },
            ],
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
      ],
    });
  });
});

test("treats null reasoning effort as omitted", async () => {
  await withChatServer(async (origin, _proxy, useTransport) => {
    const fake = policyCapturingAppServer();
    useTransport(fake);
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        reasoning_effort: null,
        messages: [{ role: "user", content: "answer" }],
      }),
    });
    assert.equal(response.status, 200);
    const turn = fake.messages.find(
      (message) => message.method === "turn/start",
    );
    assert.equal((turn?.params as Record<string, unknown>)?.effort, undefined);
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
    useTransport(fakeAppServer({ requestTool: true }));
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
      const frames = parseSseFrames(await response.text());
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

/** Verifies quota failures preserve HTTP semantics before and typed SSE semantics after commit. */
test("quota failures are JSON 429 before streaming commits and typed SSE errors afterward", async () => {
  const resetAt = 2_000_000_060;
  vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
  try {
    for (const terminal of ["error", "completed"] as const)
      await withChatServer(async (origin, _proxy, useTransport) => {
        const immediate = terminalFailureAppServer({ terminal, resetAt });
        useTransport(immediate);
        const aggregate = await fetch(`${origin}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "m",
            messages: [{ role: "user", content: terminal }],
          }),
        });
        assert.equal(aggregate.status, 429);
        assert.equal(
          aggregate.headers.get("retry-after"),
          String(resetAt - 2_000_000_000),
        );
        assert.deepEqual(await aggregate.json(), {
          error: {
            message: "Usage limit reached.",
            type: "rate_limit_error",
            param: null,
            code: "usage_limit_exceeded",
            x_codex: { reset_at: resetAt },
          },
        });
        assert.equal(immediate.rateLimitReads(), 1);

        const immediateStream = terminalFailureAppServer({ terminal, resetAt });
        useTransport(immediateStream);
        const stream = await fetch(`${origin}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "m",
            stream: true,
            messages: [{ role: "user", content: `${terminal} stream` }],
          }),
        });
        assert.equal(stream.status, 429);
        assert.match(
          stream.headers.get("content-type") ?? "",
          /^application\/json/,
        );
        assert.equal(
          ((await stream.json()) as { error: { code: string } }).error.code,
          "usage_limit_exceeded",
        );
        assert.equal(immediateStream.rateLimitReads(), 1);

        const late = terminalFailureAppServer({
          terminal,
          emitContent: true,
          duplicateTerminal: true,
          resetAt,
        });
        useTransport(late);
        const lateStream = await fetch(`${origin}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "m",
            stream: true,
            messages: [{ role: "user", content: `${terminal} late` }],
          }),
        });
        assert.equal(lateStream.status, 200);
        assert.equal(lateStream.headers.get("retry-after"), null);
        const frames = parseSseFrames(await lateStream.text());
        assert.equal(frames.includes("[DONE]"), false);
        const errors = frames
          .map(
            (frame) => JSON.parse(frame) as { error?: Record<string, unknown> },
          )
          .filter((frame) => frame.error !== undefined);
        assert.equal(errors.length, 1);
        assert.deepEqual(errors[0]?.error, {
          message: "Usage limit reached.",
          type: "rate_limit_error",
          param: null,
          code: "usage_limit_exceeded",
          x_codex: { reset_at: resetAt },
        });
        assert.equal(late.rateLimitReads(), 1);
      });
  } finally {
    vi.restoreAllMocks();
  }
});

/** Verifies nonquota terminal errors do not trigger quota lookup or remapping. */
test("nonquota turn errors retain the existing generic app-server failure", async () => {
  await withChatServer(async (origin, _proxy, useTransport) => {
    const fake = terminalFailureAppServer({
      terminal: "completed",
      codexErrorInfo: "sessionBudgetExceeded",
      resetAt: 2_000_000_060,
    });
    useTransport(fake);
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "not a quota error" }],
      }),
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: {
        message: "Usage limit reached.",
        type: "server_error",
        param: null,
        code: "app_server_error",
      },
    });
    assert.equal(fake.rateLimitReads(), 0);
  });
});

/** Verifies exhausted upstream capacity is a retryable failure, never an empty stream. */
test("model capacity failures are JSON 503 before streaming commits and typed SSE errors afterward", async () => {
  const capacity = {
    codexErrorInfo: "serverOverloaded" as const,
    message: "Selected model is at capacity. Please try a different model.",
    resetAt: 2_000_000_060,
  };
  const envelope = {
    message: capacity.message,
    type: "server_error",
    param: null,
    code: "server_overloaded",
  };
  for (const terminal of ["error", "completed"] as const)
    await withChatServer(async (origin, _proxy, useTransport) => {
      const immediate = terminalFailureAppServer({ ...capacity, terminal });
      useTransport(immediate);
      const stream = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          stream: true,
          messages: [{ role: "user", content: `${terminal} capacity` }],
        }),
      });
      assert.equal(stream.status, 503);
      assert.match(
        stream.headers.get("content-type") ?? "",
        /^application\/json/,
      );
      assert.deepEqual(await stream.json(), { error: envelope });
      // Capacity is an upstream condition, not the account's own quota.
      assert.equal(immediate.rateLimitReads(), 0);

      const aggregate = terminalFailureAppServer({ ...capacity, terminal });
      useTransport(aggregate);
      const nonStreaming = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: `${terminal} capacity json` }],
        }),
      });
      assert.equal(nonStreaming.status, 503);
      assert.deepEqual(await nonStreaming.json(), { error: envelope });

      const late = terminalFailureAppServer({
        ...capacity,
        terminal,
        emitContent: true,
      });
      useTransport(late);
      const lateStream = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          stream: true,
          messages: [{ role: "user", content: `${terminal} capacity late` }],
        }),
      });
      assert.equal(lateStream.status, 200);
      const frames = parseSseFrames(await lateStream.text());
      assert.equal(frames.includes("[DONE]"), false);
      const errors = frames
        .map(
          (frame) => JSON.parse(frame) as { error?: Record<string, unknown> },
        )
        .filter((frame) => frame.error !== undefined);
      assert.equal(errors.length, 1);
      assert.deepEqual(errors[0]?.error, envelope);
    });
});

/** Verifies the pre-commit rule covers every failure, not only classified ones. */
test("unclassified turn failures before output are JSON errors on a streaming request", async () => {
  await withChatServer(async (origin, _proxy, useTransport) => {
    const fake = terminalFailureAppServer({
      terminal: "error",
      codexErrorInfo: null,
      message: "turn failed",
      resetAt: 2_000_000_060,
    });
    useTransport(fake);
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        stream: true,
        messages: [{ role: "user", content: "fail before output" }],
      }),
    });
    assert.equal(response.status, 502);
    assert.match(
      response.headers.get("content-type") ?? "",
      /^application\/json/,
    );
    assert.deepEqual(await response.json(), {
      error: {
        message: "turn failed",
        type: "server_error",
        param: null,
        code: "app_server_error",
      },
    });
  });
});

test("initial SSE write failure disposes a primed streaming execution", async () => {
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
    useTransport(fakeAppServer({ complete: false }));
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
    assert.match(body, /"code":"request_timeout"/);
    assert.doesNotMatch(body, /\[DONE\]/);
  }, 50);
});

test("names the unsupported message fields it rejects", async () => {
  await withChatServer(async (origin) => {
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [
          { role: "user", content: "x" },
          { role: "assistant", content: "y", refusal: null, annotations: [] },
          { role: "user", content: "z" },
        ],
      }),
    });
    assert.equal(response.status, 400);
    const error = ((await response.json()) as { error: Record<string, string> })
      .error;
    assert.equal(error.code, "invalid_request");
    assert.equal(error.param, "messages.1");
    assert.equal(
      error.message,
      "This message contains unsupported fields: annotations, refusal.",
    );
  });
});

test("rejects ambiguous history and unknown continuation before app-server work", async () => {
  await withChatServer(async (origin) => {
    for (const body of [
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
          { role: "user", content: "x", reasoning_content: "not allowed" },
        ],
      },
      {
        model: "m",
        messages: [
          { role: "assistant", content: "x", reasoning_content: { t: "bad" } },
          { role: "user", content: "continue" },
        ],
      },
      {
        model: "m",
        messages: [
          { role: "assistant", content: null, tool_calls: [] },
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
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "duplicate",
                type: "function",
                function: { name: "commandExecution", arguments: "{}" },
              },
              {
                id: "duplicate",
                type: "function",
                function: { name: "webSearch", arguments: "{}" },
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
      fakeAppServer({
        complete: false,
        onInterrupt: () => {
          interrupted = true;
        },
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

test("unknown app-server events produce one transport-scoped plain diagnostic", async () => {
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
    assert.equal(diagnostics[0]?.method, "future/diagnostic");
    assert.equal(diagnostics[0]?.params_type, "object");
    assert.deepEqual(diagnostics[0]?.fields, ["detail"]);
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

    const indexes = parseSseChunks<{
      choices?: [{ delta?: { content?: string } }];
    }>(raw)
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

test("pending-record persistence failure rejects every captured responder", async () => {
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
        experimentalRawEvents: true,
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

      const defaultFake = policyCapturingAppServer();
      proxy.setTransport(defaultFake.rpc, UNRESTRICTED_POLICY_REQUIREMENTS);
      const defaulted = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "offline" }],
        }),
      });
      assert.equal(defaulted.status, 200);

      const disabledFake = policyCapturingAppServer();
      proxy.setTransport(disabledFake.rpc, UNRESTRICTED_POLICY_REQUIREMENTS);
      const disabledRequest = {
        model: "m",
        messages: [{ role: "user", content: "disabled" }],
        x_codex: { sandbox: "disabled" },
      };
      const disabled = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(disabledRequest),
      });
      assert.equal(disabled.status, 200);
      const disabledBody = (await disabled.json()) as { id: string };
      assert.deepEqual(
        disabledFake.messages.find(
          (message) => message.method === "thread/start",
        )?.params,
        {
          model: "m",
          ephemeral: false,
          experimentalRawEvents: true,
          cwd: root,
          sandbox: "read-only",
          approvalPolicy: "never",
          approvalsReviewer: "auto_review",
          config: { web_search: "disabled" },
          environments: [],
        },
      );
      assert.deepEqual(
        disabledFake.messages.find((message) => message.method === "turn/start")
          ?.params,
        {
          threadId: "thr_policy",
          model: "m",
          summary: "detailed",
          input: [{ type: "text", text: "disabled", text_elements: [] }],
          cwd: root,
          approvalPolicy: "never",
          approvalsReviewer: "auto_review",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          environments: [],
        },
      );

      // Omitting x_codex must behave exactly like explicit sandbox "disabled":
      // identical thread settings and turn overrides, differing only in input.
      assert.deepEqual(
        defaultFake.messages.find(
          (message) => message.method === "thread/start",
        )?.params,
        disabledFake.messages.find(
          (message) => message.method === "thread/start",
        )?.params,
      );
      assert.deepEqual(
        defaultFake.messages.find((message) => message.method === "turn/start")
          ?.params,
        {
          ...(disabledFake.messages.find(
            (message) => message.method === "turn/start",
          )?.params as Record<string, unknown>),
          input: [{ type: "text", text: "offline", text_elements: [] }],
        },
      );

      const continuedDisabled = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...disabledRequest,
          previous_response_id: disabledBody.id,
          messages: [{ role: "user", content: "continue disabled" }],
        }),
      });
      assert.equal(continuedDisabled.status, 200);
      const continuedDisabledBody = (await continuedDisabled.json()) as {
        id: string;
      };
      assert.deepEqual(
        disabledFake.messages.find(
          (message) => message.method === "thread/resume",
        )?.params,
        {
          threadId: "thr_policy",
          excludeTurns: true,
          cwd: root,
          sandbox: "read-only",
          approvalPolicy: "never",
          approvalsReviewer: "auto_review",
          config: { web_search: "disabled" },
        },
      );
      assert.deepEqual(
        disabledFake.messages
          .filter((message) => message.method === "turn/start")
          .at(-1)?.params,
        {
          threadId: "thr_policy",
          model: "m",
          summary: "detailed",
          input: [
            { type: "text", text: "continue disabled", text_elements: [] },
          ],
          cwd: root,
          approvalPolicy: "never",
          approvalsReviewer: "auto_review",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          environments: [],
        },
      );

      const beforeDisabledMismatch = disabledFake.messages.length;
      const changedDisabled = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...disabledRequest,
          previous_response_id: continuedDisabledBody.id,
          x_codex: { sandbox: "read-only" },
        }),
      });
      assert.equal(changedDisabled.status, 409);
      assert.equal(
        ((await changedDisabled.json()) as { error: { code: string } }).error
          .code,
        "continuation_policy_mismatch",
      );
      assert.equal(disabledFake.messages.length, beforeDisabledMismatch);

      const defaultDeniedFake = policyCapturingAppServer();
      proxy.setTransport(defaultDeniedFake.rpc, {
        ...UNRESTRICTED_POLICY_REQUIREMENTS,
        allowedSandboxModes: ["workspace-write"],
      });
      const defaultDenied = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "default denied" }],
        }),
      });
      assert.equal(defaultDenied.status, 400);
      assert.equal(
        ((await defaultDenied.json()) as { error: { code: string } }).error
          .code,
        "sandbox_not_allowed",
      );
      assert.deepEqual(defaultDeniedFake.messages, []);

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
