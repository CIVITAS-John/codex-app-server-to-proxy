import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { test } from "vitest";
import { EventNormalizer, normalizeNotification } from "../src/chat.js";
import { JsonRpcTransport } from "../src/json-rpc.js";
import { createLogger } from "../src/logger.js";
import { parseServeOptions } from "../src/config.js";
import { createProxyServer } from "../src/server.js";

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
      send({
        method: "item/agentMessage/delta",
        params: {
          threadId: thread,
          turnId: "turn_test",
          itemId: "text",
          delta: "Hello",
        },
      });
      if (complete) {
        send({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: thread,
            turnId: "turn_test",
            tokenUsage: {
              last: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
            },
          },
        });
        send({
          method: "turn/completed",
          params: {
            threadId: thread,
            turnId: "turn_test",
            turn: { status: "completed" },
          },
        });
      }
    } else if (message.method === "turn/interrupt") {
      onInterrupt();
      send({ id: message.id, result: {} });
    }
  });
  return rpc;
}

/** Runs an HTTP assertion against an ephemeral, ready offline proxy. */
async function withChatServer(
  run: (
    origin: string,
    proxy: ReturnType<typeof createProxyServer>,
  ) => Promise<void>,
): Promise<void> {
  const proxy = createProxyServer(
    parseServeOptions(["--port", "0"]),
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
  assert.deepEqual(
    normalizer.normalize("item/agentMessage/delta", { delta: "a" }),
    [{ delta: { content: "a" } }],
  );
  assert.equal(
    normalizer.normalize("item/reasoning/summaryTextDelta", {
      itemId: "r",
      summaryIndex: 1,
      delta: "why",
    })[0]?.delta?.x_codex !== undefined,
    true,
  );
  const first = normalizer.normalize("item/started", {
    item: {
      type: "dynamicToolCall",
      id: "call_a",
      tool: "lookup",
      arguments: { id: 1 },
    },
  });
  const second = normalizer.normalize("item/started", {
    item: {
      type: "dynamicToolCall",
      id: "call_b",
      tool: "other",
      arguments: {},
    },
  });
  assert.equal(
    (first[0]?.delta?.tool_calls as Array<{ index: number }>)[0]?.index,
    0,
  );
  assert.equal(
    (second[0]?.delta?.tool_calls as Array<{ index: number }>)[0]?.index,
    1,
  );
  assert.deepEqual(
    normalizer.normalize("turn/completed", {
      turn: { status: "completed" },
    }),
    [{ finishReason: "tool_calls" }],
  );
  assert.deepEqual(
    normalizer.normalize("thread/tokenUsage/updated", {
      tokenUsage: {
        last: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cachedInputTokens: 2,
          reasoningOutputTokens: 1,
        },
      },
    }),
    [
      {
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      },
    ],
  );
  assert.deepEqual(
    normalizeNotification("turn/completed", {
      turn: { status: "interrupted" },
    }),
    [{ finishReason: "length" }],
  );
  assert.equal(
    normalizeNotification("error", { error: { message: "failed" } })[0]?.error,
    "failed",
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

test("rejects ambiguous history and unsupported continuation before app-server work", async () => {
  await withChatServer(async (origin) => {
    for (const body of [
      {
        model: "m",
        messages: [{ role: "assistant", content: "not a user turn" }],
      },
      {
        model: "m",
        messages: [{ role: "user", content: "x" }],
        previous_response_id: "chatcmpl_old",
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
