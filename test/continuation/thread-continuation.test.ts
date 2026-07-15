import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { test } from "vitest";
import { parseServeOptions } from "../../src/core/config.js";
import { JsonRpcTransport } from "../../src/app-server/json-rpc.js";
import { createLogger } from "../../src/core/logger.js";
import { createProxyServer, type ProxyServer } from "../../src/http/server.js";
import { bindingHash, ResponseStore } from "../../src/continuation/state.js";
import {
  protocolNotification,
  protocolTurn,
} from "../support/protocol-fixtures.js";

/** Suppresses expected diagnostics from rejected continuation requests. */
const silentLogger = createLogger("error", () => {});

/** A configurable fake used to prove continuation preflight never starts a thread. */
class ContinuationAppServer {
  readonly transport: JsonRpcTransport;
  readonly methods: string[] = [];
  readonly responderErrors: Array<Record<string, unknown>> = [];
  readonly #fromServer = new PassThrough();
  readonly #toServer = new PassThrough();
  readonly #threadId = "thr_continuation";
  #turn = 0;

  constructor(
    private readonly status: unknown = { type: "idle" },
    private readonly completionDelayMs = 0,
    private readonly requestTool = false,
  ) {
    this.transport = new JsonRpcTransport(this.#fromServer, this.#toServer);
    createInterface({ input: this.#toServer }).on("line", (line) =>
      this.#receive(JSON.parse(line) as Record<string, unknown>),
    );
  }

  /** Sends one complete JSON-RPC frame. */
  #send(value: unknown): void {
    this.#fromServer.write(`${JSON.stringify(value)}\n`);
  }

  /** Implements only the calls needed by continuation tests. */
  #receive(message: Record<string, unknown>): void {
    if (typeof message.method !== "string") {
      if (message.id === 901 && message.error)
        this.responderErrors.push(message.error as Record<string, unknown>);
      return;
    }
    this.methods.push(message.method);
    const id = message.id as number;
    if (message.method === "thread/start") {
      this.#send({ id, result: { thread: { id: this.#threadId } } });
    } else if (message.method === "thread/read") {
      this.#send({
        id,
        result: { thread: { id: this.#threadId, status: this.status } },
      });
    } else if (message.method === "thread/resume") {
      this.#send({ id, result: { thread: { id: this.#threadId } } });
    } else if (message.method === "turn/start") {
      const turnId = `turn_continuation_${++this.#turn}`;
      this.#send({ id, result: { turn: { id: turnId } } });
      if (this.requestTool) {
        this.#send({
          id: 901,
          method: "item/tool/call",
          params: {
            threadId: this.#threadId,
            turnId,
            callId: "call_weather",
            tool: "weather",
            namespace: null,
            arguments: { city: "Chicago", units: "metric" },
          },
        });
        return;
      }
      const complete = (): void => {
        this.#send(
          protocolNotification({
            method: "turn/completed",
            params: {
              threadId: this.#threadId,
              turn: protocolTurn(turnId, "completed"),
            },
          }),
        );
      };
      if (this.completionDelayMs)
        setTimeout(complete, this.completionDelayMs).unref();
      else complete();
    }
  }
}

/** Starts a ready proxy and returns its effective cwd binding. */
async function startProxy(
  directory: string,
  fake: ContinuationAppServer,
  record?: Parameters<ResponseStore["put"]>[0],
): Promise<{ origin: string; proxy: ProxyServer; root: string }> {
  const root = join(directory, "workspace");
  const options = parseServeOptions([
    "--port",
    "0",
    "--root",
    root,
    "--state-dir",
    directory,
  ]);
  if (record) new ResponseStore(directory).put(record);
  const proxy = createProxyServer(options, silentLogger);
  proxy.setTransport(fake.transport);
  proxy.setReady(true);
  const address = await proxy.listen();
  const host = address.address.includes(":")
    ? `[${address.address}]`
    : address.address;
  return {
    origin: `http://${host}:${address.port}`,
    proxy,
    root: options.root,
  };
}

/** Posts one ordinary continuation request. */
function post(
  origin: string,
  previousResponseId: string,
  model = "m",
  tools?: unknown[],
  stream = false,
): Promise<Response> {
  return fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      previous_response_id: previousResponseId,
      ...(tools ? { tools } : {}),
      ...(stream ? { stream: true } : {}),
      messages: [{ role: "user", content: "continue" }],
    }),
  });
}

/** Extracts the stable OpenAI-shaped error code. */
async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

test("model, cwd, tool, and policy binding mismatches fail before thread/read", async () => {
  const cases = [
    {
      name: "model",
      patch: { model: "other" },
      code: "continuation_model_mismatch",
    },
    {
      name: "cwd",
      patch: { cwd: "/different" },
      code: "continuation_cwd_mismatch",
    },
    {
      name: "tools",
      patch: { toolsHash: bindingHash([{ name: "other" }]) },
      code: "continuation_tools_mismatch",
    },
    {
      name: "policy",
      patch: { policyHash: bindingHash({ sandbox: "read-only" }) },
      code: "continuation_policy_mismatch",
    },
  ] as const;
  for (const item of cases) {
    const directory = await mkdtemp(
      join(tmpdir(), `codex-continuation-${item.name}-`),
    );
    const fake = new ContinuationAppServer();
    const responseId = `response_${item.name}`;
    const running = await startProxy(directory, fake, {
      responseId,
      threadId: "thr_continuation",
      state: "ready",
      model: "m",
      cwd: join(directory, "workspace"),
      toolsHash: bindingHash([]),
      policyHash: bindingHash({}),
      ...item.patch,
    });
    try {
      const response = await post(running.origin, responseId);
      assert.equal(response.status, 409);
      assert.equal(await errorCode(response), item.code);
      assert.deepEqual(fake.methods, []);
    } finally {
      await running.proxy.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("terminal mappings fail as JSON before streaming headers or thread work", async () => {
  for (const state of ["expired", "superseded", "corrupt"] as const) {
    const directory = await mkdtemp(
      join(tmpdir(), `codex-continuation-${state}-`),
    );
    const fake = new ContinuationAppServer();
    const responseId = `response_${state}`;
    const running = await startProxy(directory, fake, {
      responseId,
      threadId: "thr_continuation",
      state,
      model: "m",
      cwd: join(directory, "workspace"),
      toolsHash: bindingHash([]),
      policyHash: bindingHash({}),
    });
    try {
      const response = await post(
        running.origin,
        responseId,
        undefined,
        undefined,
        true,
      );
      assert.equal(
        response.status,
        state === "expired" ? 410 : state === "superseded" ? 409 : 500,
      );
      assert.equal(
        response.headers.get("content-type"),
        "application/json; charset=utf-8",
      );
      assert.equal(
        await errorCode(response),
        state === "expired"
          ? "expired_previous_response_id"
          : state === "superseded"
            ? "superseded_previous_response_id"
            : "corrupt_response_state",
      );
      assert.deepEqual(fake.methods, []);
    } finally {
      await running.proxy.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("ready continuation rejects trailing tool results before thread work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-ready-tool-"));
  const fake = new ContinuationAppServer();
  const responseId = "response_ready_tool";
  const running = await startProxy(directory, fake, {
    responseId,
    threadId: "thr_continuation",
    state: "ready",
    model: "m",
    cwd: join(directory, "workspace"),
    toolsHash: bindingHash([]),
    policyHash: bindingHash({}),
  });
  try {
    const response = await fetch(`${running.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        previous_response_id: responseId,
        messages: [
          { role: "tool", tool_call_id: "call_stale", content: "result" },
        ],
      }),
    });
    assert.equal(response.status, 409);
    assert.equal(
      await errorCode(response),
      "tool_results_without_pending_call",
    );
    assert.deepEqual(fake.methods, []);
  } finally {
    await running.proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("non-resumable thread/read states fail closed without resume, turn, or replacement thread", async () => {
  const states: unknown[] = [
    { type: "active" },
    { type: "systemError" },
    { type: "archived" },
    { type: "deleted" },
    { type: "futureStatus" },
    {},
    null,
  ];
  for (const [index, status] of states.entries()) {
    const directory = await mkdtemp(join(tmpdir(), "codex-thread-status-"));
    const fake = new ContinuationAppServer(status);
    const responseId = `response_status_${index}`;
    const running = await startProxy(directory, fake, {
      responseId,
      threadId: "thr_continuation",
      state: "ready",
      model: "m",
      cwd: join(directory, "workspace"),
      toolsHash: bindingHash([]),
      policyHash: bindingHash({}),
    });
    try {
      const response = await post(running.origin, responseId);
      assert.equal(response.status, 409);
      assert.equal(
        await errorCode(response),
        status && (status as { type?: string }).type === "active"
          ? "thread_busy"
          : "thread_not_resumable",
      );
      assert.deepEqual(fake.methods, ["thread/read"]);
    } finally {
      await running.proxy.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("concurrent ordinary requests for one active thread return an immediate 409", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-thread-busy-"));
  const fake = new ContinuationAppServer({ type: "idle" }, 100);
  const running = await startProxy(directory, fake, {
    responseId: "response_busy",
    threadId: "thr_continuation",
    state: "ready",
    model: "m",
    cwd: join(directory, "workspace"),
    toolsHash: bindingHash([]),
    policyHash: bindingHash({}),
  });
  try {
    const first = post(running.origin, "response_busy");
    while (!fake.methods.includes("turn/start"))
      await new Promise<void>((resolve) => setImmediate(resolve));
    const second = await post(running.origin, "response_busy");
    assert.equal(second.status, 409);
    assert.equal(await errorCode(second), "thread_busy");
    assert.equal((await first).status, 200);
    assert.equal(
      fake.methods.filter((method) => method === "thread/read").length,
      1,
    );
    assert.ok(!fake.methods.includes("thread/start"));
  } finally {
    await running.proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("streaming dynamic tools use standard argument deltas and survive through explicit disposal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-sse-tool-"));
  const fake = new ContinuationAppServer({ type: "idle" }, 0, true);
  const running = await startProxy(directory, fake);
  try {
    const response = await fetch(`${running.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        stream: true,
        tools: [
          {
            type: "function",
            function: { name: "weather", parameters: { type: "object" } },
          },
        ],
        messages: [{ role: "user", content: "weather" }],
      }),
    });
    assert.equal(response.status, 200);
    const frames = (await response.text())
      .split("\n\n")
      .filter(Boolean)
      .map((frame) => frame.slice("data: ".length));
    assert.equal(frames.at(-1), "[DONE]");
    const chunks = frames
      .slice(0, -1)
      .map((frame) => JSON.parse(frame) as Record<string, unknown>);
    const choices = chunks.map(
      (chunk) =>
        (
          chunk.choices as Array<{
            delta: Record<string, unknown>;
            finish_reason: string | null;
          }>
        )[0]!,
    );
    const toolDelta = choices.find((choice) => choice.delta.tool_calls);
    assert.deepEqual(toolDelta?.delta, {
      tool_calls: [
        {
          index: 0,
          id: "call_weather",
          type: "function",
          function: {
            name: "weather",
            arguments: '{"city":"Chicago","units":"metric"}',
          },
        },
      ],
    });
    assert.equal(choices.at(-1)?.finish_reason, "tool_calls");

    // Ending the originating HTTP stream does not cancel a suspended tool call;
    // replacing its transport is the explicit lifecycle cancellation boundary.
    assert.deepEqual(fake.responderErrors, []);
    running.proxy.setTransport(undefined);
    assert.deepEqual(fake.responderErrors, [
      {
        code: -32000,
        message: "App-server transport is being replaced",
      },
    ]);
  } finally {
    await running.proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
});
