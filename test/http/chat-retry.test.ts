import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { ErrorNotification } from "../../protocol/generated/typescript/v2/ErrorNotification.js";
import { ResponseStore } from "../../src/continuation/state.js";
import { createLogger } from "../../src/core/logger.js";
import { EventNormalizer, type Usage } from "../../src/http/chat-normalize.js";
import {
  parseSseChunks,
  parseSseFrames,
  postChatCompletion,
  startProxyWithTransport,
} from "../support/http.js";
import {
  protocolNotification,
  protocolTurn,
} from "../support/protocol-fixtures.js";
import {
  retryAppServer,
  retryError,
  retryText,
  type RetryAppServer,
} from "../support/retry-app-server.js";
import { withTempDir } from "../support/temp.js";
import {
  completeTurn,
  sendTokenUsage,
  suspendWithTools,
  tokenUsageFixture,
} from "../support/transport.js";

/** One decoded streaming chunk with the fields these tests assert on. */
interface StreamedChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: Usage;
  x_codex?: { threadReused?: boolean };
}

/** Runs an HTTP assertion against a ready proxy served by one retry script. */
async function withRetryServer(
  fake: RetryAppServer,
  run: (origin: string) => Promise<void>,
  stateDir = join(tmpdir(), `codex-proxy-retry-tests-${process.pid}`),
): Promise<void> {
  const { origin, proxy } = await startProxyWithTransport(fake.rpc, {
    root: await realpath("."),
    stateDir,
  });
  try {
    await run(origin);
  } finally {
    proxy.setReady(false);
    proxy.setTransport(undefined);
    await proxy.close();
  }
}

test.each([false, undefined, null, "true", "false", 1, 0, {}, []])(
  "only boolean true marks an error as retrying (received %j)",
  (willRetry) => {
    const notification = retryError(false);
    const params: Record<string, unknown> = {
      ...notification.params,
      willRetry,
    };
    if (willRetry === undefined) delete params.willRetry;
    const events = new EventNormalizer().normalize(notification.method, params);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.terminalError?.code, "server_overloaded");
  },
);

test("retry errors preserve normalizer reasoning, tool indexes, and usage", () => {
  const normalizer = new EventNormalizer();
  normalizer.normalize("item/reasoning/summaryTextDelta", {
    itemId: "r",
    delta: "thought",
  });
  const first = normalizer.dynamicToolCall({
    callId: "a",
    name: "lookup",
    arguments: "{}",
  });
  const usage = protocolNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thr_retry",
      turnId: "turn_retry_1",
      tokenUsage: tokenUsageFixture(),
    },
  });
  normalizer.normalize(usage.method, usage.params);
  const retry = retryError(true);
  assert.deepEqual(normalizer.normalize(retry.method, retry.params), []);
  assert.equal(normalizer.usageSnapshot()?.total_tokens, 6);
  const second = normalizer.dynamicToolCall({
    callId: "b",
    name: "lookup",
    arguments: "{}",
  });
  assert.equal(first.delta?.tool_calls?.[0]?.index, 0);
  assert.equal(second.delta?.tool_calls?.[0]?.index, 1);
  assert.deepEqual(
    normalizer.normalize("item/completed", {
      item: {
        id: "r",
        type: "reasoning",
        summary: ["thought continued"],
        content: [],
      },
    }),
    [{ delta: { reasoning: " continued" } }],
  );
});

test("each retry notification is logged with its error kind", () => {
  const entries: Array<Record<string, unknown>> = [];
  const normalizer = new EventNormalizer(undefined, {
    log: createLogger("warn", (entry) => entries.push(entry)),
    requestId: "req_retry",
  });
  const variants = [
    "serverOverloaded",
    { httpConnectionFailed: { httpStatusCode: 502 } },
  ] as const;
  for (const codexErrorInfo of variants) {
    const retry = retryError(true, "turn_retry_1", codexErrorInfo);
    assert.deepEqual(normalizer.normalize(retry.method, retry.params), []);
  }
  assert.deepEqual(
    entries.map(({ event, request_id, error_kind, message }) => ({
      event,
      request_id,
      error_kind,
      message,
    })),
    ["serverOverloaded", "httpConnectionFailed"].map((kind) => ({
      event: "app_server_retry",
      request_id: "req_retry",
      error_kind: kind,
      message: "Synthetic upstream failure.",
    })),
  );
});

test.each([false, true])(
  "retry success preserves one response and exact usage (stream: %s)",
  async (stream) => {
    for (const position of ["before", "between"] as const) {
      const fake = retryAppServer((send, turnId) => {
        // Foreign terminal failures must remain isolated from this turn.
        send(retryError(false, "foreign_turn"));
        send(retryError(false, turnId, null, "foreign_thread"));
        if (position === "before") send(retryError(true, turnId));
        retryText(send, turnId, "Hello");
        sendTokenUsage(send, "thr_retry", turnId, tokenUsageFixture());
        send(retryError(true, turnId, "usageLimitExceeded"));
        retryText(send, turnId, " world");
        completeTurn(send, "thr_retry", turnId, { reasoningOutputTokens: 3 });
      });
      await withRetryServer(fake, async (origin) => {
        const response = await postChatCompletion(origin, {
          model: "m",
          stream,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: position }],
        });
        assert.equal(response.status, 200);
        let usage: Usage | undefined;
        if (stream) {
          const frames = parseSseFrames(await response.text());
          assert.equal(frames.filter((frame) => frame === "[DONE]").length, 1);
          const chunks = frames.slice(0, -1).map(
            (frame) =>
              JSON.parse(frame) as StreamedChunk & {
                id: string;
                error?: unknown;
              },
          );
          assert.equal(new Set(chunks.map((chunk) => chunk.id)).size, 1);
          assert.equal(
            chunks.some((chunk) => chunk.error),
            false,
          );
          assert.equal(
            chunks
              .map((chunk) => chunk.choices?.[0]?.delta?.content ?? "")
              .join(""),
            "Hello world",
          );
          assert.equal(
            chunks.filter(
              (chunk) => chunk.choices?.[0]?.finish_reason === "stop",
            ).length,
            1,
          );
          assert.equal(chunks.filter((chunk) => chunk.usage).length, 1);
          usage = chunks.find((chunk) => chunk.usage)?.usage;
        } else {
          const body = (await response.json()) as {
            choices: Array<{
              message: { content: string };
              finish_reason: string;
            }>;
            usage: Usage;
          };
          assert.equal(body.choices[0]?.message.content, "Hello world");
          assert.equal(body.choices[0]?.finish_reason, "stop");
          usage = body.usage;
        }
        assert.deepEqual(usage, {
          prompt_tokens: 4,
          completion_tokens: 5,
          total_tokens: 9,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 3 },
        });
        assert.equal(
          fake.methods.filter((method) => method === "turn/start").length,
          1,
        );
        assert.equal(fake.methods.includes("account/rateLimits/read"), false);
        assert.equal(fake.methods.includes("turn/interrupt"), false);
      });
    }
  },
);

test("a retry notification leaves streaming headers uncommitted", async () => {
  let turnStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    turnStarted = resolve;
  });
  const fake = retryAppServer((send, turnId) => {
    send(retryError(true, turnId));
    turnStarted();
  });
  await withRetryServer(fake, async (origin) => {
    let responded = false;
    const pending = postChatCompletion(origin, {
      model: "m",
      stream: true,
      messages: [{ role: "user", content: "wait for retry" }],
    }).then((response) => {
      responded = true;
      return response;
    });
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(responded, false);
    fake.send(retryError(false));
    const response = await pending;
    assert.equal(response.status, 503);
    assert.match(
      response.headers.get("content-type") ?? "",
      /application\/json/,
    );
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      "server_overloaded",
    );
  });
});

test.each([
  ["usageLimitExceeded", 429, "usage_limit_exceeded", "error"],
  ["serverOverloaded", 503, "server_overloaded", "error"],
  ["serverOverloaded", 503, "server_overloaded", "failed"],
  [null, 502, "app_server_error", "error"],
  ["tooManyDenials", 502, "app_server_error", "interrupted"],
] as const)(
  "retry followed by %s (%s, %s, %s) preserves terminal HTTP and SSE mappings",
  async (classification, status, code, terminalKind) => {
    for (const mode of ["aggregate", "uncommitted", "committed"] as const)
      await withTempDir(async (directory) => {
        const emitContent = mode === "committed";
        const fake = retryAppServer((send, turnId) => {
          send(retryError(true, turnId));
          if (emitContent) retryText(send, turnId, "partial");
          const terminal = retryError(false, turnId, classification);
          if (terminalKind !== "error")
            send(
              protocolNotification({
                method: "turn/completed",
                params: {
                  threadId: "thr_retry",
                  turn: {
                    ...protocolTurn(turnId, terminalKind),
                    error: (terminal.params as ErrorNotification).error,
                  },
                },
              }),
            );
          else {
            send(terminal);
            send(terminal);
          }
        });
        await withRetryServer(
          fake,
          async (origin) => {
            const response = await postChatCompletion(origin, {
              model: "m",
              stream: mode !== "aggregate",
              messages: [{ role: "user", content: "eventual failure" }],
            });
            if (!emitContent) {
              assert.equal(response.status, status);
              assert.match(
                response.headers.get("content-type") ?? "",
                /application\/json/,
              );
              assert.equal(
                ((await response.json()) as { error: { code: string } }).error
                  .code,
                code,
              );
            } else {
              assert.equal(response.status, 200);
              const frames = parseSseFrames(await response.text());
              assert.equal(frames.includes("[DONE]"), false);
              const chunks = frames.map(
                (frame) =>
                  JSON.parse(frame) as {
                    id?: string;
                    error?: { code: string };
                    choices?: Array<{ finish_reason?: string }>;
                  },
              );
              assert.equal(chunks.filter((chunk) => chunk.error).length, 1);
              assert.equal(
                chunks.find((chunk) => chunk.error)?.error?.code,
                code,
              );
              assert.equal(
                chunks.some((chunk) => chunk.choices?.[0]?.finish_reason),
                false,
              );
              assert.equal(
                new ResponseStore(directory).get(chunks[0]!.id!),
                undefined,
              );
            }
            assert.equal(
              fake.methods.filter(
                (method) => method === "account/rateLimits/read",
              ).length,
              classification === "usageLimitExceeded" ? 1 : 0,
            );
            assert.equal(
              fake.methods.filter((method) => method === "turn/start").length,
              1,
            );
          },
          directory,
        );
      }, "codex-retry-terminal-");
  },
);

test.each([false, true])(
  "retry inside a bounded tool batch and its continuation preserves calls (stream: %s)",
  async (stream) => {
    await withTempDir(async (directory) => {
      const fake = retryAppServer((send, turnId, number) => {
        if (number === 1) {
          suspendWithTools(
            send,
            "thr_retry",
            turnId,
            [
              {
                id: 9201,
                callId: "call_a",
                tool: "lookup",
                arguments: { key: "a" },
              },
            ],
            { completeRawResponse: false },
          );
          // The retry lies inside the captured batch, between its callbacks
          // and the authoritative raw-response completion.
          send(retryError(true, turnId));
          suspendWithTools(
            send,
            "thr_retry",
            turnId,
            [
              {
                id: 9202,
                callId: "call_b",
                tool: "lookup",
                arguments: { key: "b" },
              },
            ],
            { rawUsage: tokenUsageFixture().last },
          );
        } else {
          retryText(send, turnId, "Resumed");
          send(retryError(true, turnId));
          retryText(send, turnId, " once");
          completeTurn(send, "thr_retry", turnId, { priorRequests: 1 });
        }
      });
      await withRetryServer(
        fake,
        async (origin) => {
          const tools = [
            { type: "function", function: { name: "lookup", parameters: {} } },
          ];
          const response = await postChatCompletion(origin, {
            model: "m",
            tools,
            stream,
            stream_options: { include_usage: true },
            messages: [{ role: "user", content: "look up both keys" }],
          });
          assert.equal(response.status, 200);
          let id: string;
          let calls: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
          if (stream) {
            const chunks = parseSseChunks<{
              id: string;
              choices: Array<{
                delta: { tool_calls?: typeof calls };
                finish_reason: string | null;
              }>;
              error?: unknown;
              usage?: Usage;
            }>(await response.text());
            id = chunks[0]!.id;
            calls = chunks.flatMap(
              (chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? [],
            );
            assert.equal(
              chunks.some((chunk) => chunk.error),
              false,
            );
            assert.equal(
              chunks.filter(
                (chunk) => chunk.choices?.[0]?.finish_reason === "tool_calls",
              ).length,
              1,
            );
            assert.equal(
              chunks.find((chunk) => chunk.usage)?.usage?.total_tokens,
              6,
            );
          } else {
            const body = (await response.json()) as {
              id: string;
              choices: Array<{
                message: { tool_calls: typeof calls };
                finish_reason: string;
              }>;
              usage: Usage;
            };
            id = body.id;
            calls = body.choices[0]!.message.tool_calls;
            assert.equal(body.choices[0]?.finish_reason, "tool_calls");
            assert.equal(body.usage.total_tokens, 6);
          }
          assert.deepEqual(
            calls.map((call) => call.id),
            ["call_a", "call_b"],
          );
          assert.equal(
            new ResponseStore(directory).get(id)?.state,
            "pending_tool",
          );
          const continued = await postChatCompletion(origin, {
            model: "m",
            tools,
            stream: true,
            stream_options: { include_usage: true },
            previous_response_id: id,
            messages: [
              { role: "user", content: "look up both keys" },
              {
                role: "assistant",
                content: null,
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: call.function,
                })),
              },
              ...calls.map((call) => ({
                role: "tool",
                tool_call_id: call.id,
                content: "result",
              })),
            ],
          });
          assert.equal(continued.status, 200);
          const chunks = parseSseChunks<StreamedChunk>(await continued.text());
          assert.equal(chunks[0]?.x_codex?.threadReused, true);
          assert.equal(
            chunks
              .map((chunk) => chunk.choices?.[0]?.delta?.content ?? "")
              .join(""),
            "Resumed once",
          );
          assert.equal(
            chunks.find((chunk) => chunk.usage)?.usage?.total_tokens,
            6,
          );
          assert.equal(
            chunks.filter(
              (chunk) => chunk.choices?.[0]?.finish_reason === "stop",
            ).length,
            1,
          );
          assert.equal(
            fake.methods.filter((method) => method === "turn/start").length,
            2,
          );
          assert.equal(
            fake.methods.filter((method) => method === "thread/start").length,
            1,
          );
          assert.equal(
            fake.methods.filter((method) => method === "thread/resume").length,
            1,
          );
          assert.equal(
            fake.methods.filter((method) => method === "thread/inject_items")
              .length,
            1,
          );
          assert.equal(
            fake.methods.filter((method) => method === "turn/interrupt").length,
            1,
          );
          assert.deepEqual(fake.responderErrors, []);
        },
        directory,
      );
    }, "codex-retry-tools-");
  },
);
