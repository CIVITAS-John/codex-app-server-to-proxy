import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { test } from "vitest";
import { JsonRpcTransport } from "../../src/app-server/json-rpc.js";
import type { ProxyServer } from "../../src/http/server.js";
import { ResponseStore } from "../../src/continuation/state.js";
import { bindingHash } from "../../src/core/canonical.js";
import { policyBindingHash } from "../../src/core/policy.js";
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
  parseSseChunks,
  postChatCompletion,
  responseErrorCode,
  startProxyWithTransport,
} from "../support/http.js";
import { withTempDir } from "../support/temp.js";

/** Returns the Stage 06 safe-default continuation policy binding. */
function defaultPolicyHash(cwd: string): string {
  return policyBindingHash({
    cwd,
    sandbox: "disabled",
    threadSandbox: "read-only",
    webSearch: "disabled",
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  });
}

/** A configurable fake used to prove continuation preflight never starts a thread. */
class ContinuationAppServer {
  readonly transport: JsonRpcTransport;
  readonly methods: string[] = [];
  readonly responderErrors: Array<Record<string, unknown>> = [];
  readonly #fromServer = new PassThrough();
  readonly #toServer = new PassThrough();
  readonly #threadId = "thr_continuation";
  #turn = 0;
  /** The tool-call turn currently awaiting its interrupt, if any. */
  #toolTurnId: string | undefined;

  constructor(
    private readonly status: unknown = { type: "idle" },
    private readonly completionDelayMs = 0,
    private readonly requestTool = false,
    private readonly instructionSources: string[] = [],
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
      this.#send(
        protocolResponse("thread/start", id, {
          ...protocolThreadStartResponse(protocolThread(this.#threadId)),
          instructionSources: this.instructionSources,
        }),
      );
    } else if (message.method === "thread/read") {
      // The configurable unknown status is intentionally hostile protocol input.
      this.#send({
        id,
        result: { thread: { id: this.#threadId, status: this.status } },
      });
    } else if (message.method === "thread/resume") {
      this.#send(
        protocolResponse("thread/resume", id, {
          ...protocolThreadResumeResponse(protocolThread(this.#threadId)),
          instructionSources: this.instructionSources,
        }),
      );
    } else if (message.method === "turn/start") {
      const turnId = `turn_continuation_${++this.#turn}`;
      this.#send(
        protocolResponse("turn/start", id, {
          turn: protocolTurn(turnId, "inProgress"),
        }),
      );
      if (this.requestTool) {
        this.#toolTurnId = turnId;
        this.#send(
          protocolServerRequest({
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
          }),
        );
        this.#send(
          protocolNotification({
            method: "rawResponse/completed",
            params: {
              threadId: this.#threadId,
              turnId,
              responseId: `raw_${turnId}`,
              usage: null,
            },
          }),
        );
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
        this.#send(
          protocolNotification({
            method: "thread/status/changed",
            params: { threadId: this.#threadId, status: { type: "idle" } },
          }),
        );
      };
      if (this.completionDelayMs)
        setTimeout(complete, this.completionDelayMs).unref();
      else complete();
    } else if (message.method === "turn/interrupt") {
      this.#send(protocolResponse("turn/interrupt", id, {}));
      const turnId = this.#toolTurnId;
      if (!turnId) return;
      this.#toolTurnId = undefined;
      this.#send(
        protocolNotification({
          method: "turn/completed",
          params: {
            threadId: this.#threadId,
            turn: protocolTurn(turnId, "interrupted"),
          },
        }),
      );
      this.#send(
        protocolNotification({
          method: "thread/status/changed",
          params: { threadId: this.#threadId, status: { type: "idle" } },
        }),
      );
    }
  }
}

/** Starts a ready proxy and returns its effective cwd binding. */
async function startProxy(
  directory: string,
  fake: ContinuationAppServer,
  record?: Parameters<ResponseStore["put"]>[0],
): Promise<{ origin: string; proxy: ProxyServer; root: string }> {
  const configuredRoot = join(directory, "workspace");
  await mkdir(configuredRoot, { recursive: true });
  const root = await realpath(configuredRoot);
  if (record) {
    const defaultHash = defaultPolicyHash(configuredRoot);
    new ResponseStore(directory).put({
      ...record,
      cwd: record.cwd === configuredRoot ? root : record.cwd,
      policyHash:
        record.policyHash === defaultHash
          ? defaultPolicyHash(root)
          : record.policyHash,
    });
  }
  const running = await startProxyWithTransport(fake.transport, {
    root,
    stateDir: directory,
  });
  return {
    origin: running.origin,
    proxy: running.proxy,
    root: running.options.root,
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
  return postChatCompletion(origin, {
    model,
    previous_response_id: previousResponseId,
    ...(tools ? { tools } : {}),
    ...(stream ? { stream: true } : {}),
    messages: [{ role: "user", content: "continue" }],
  });
}

test("ready continuations report resumed instruction sources and thread reuse", async () => {
  await withTempDir(async (directory) => {
    const instructionSources = [
      "synthetic/project/AGENTS.md",
      "synthetic/project/src/AGENTS.override.md",
    ];
    const fake = new ContinuationAppServer(
      { type: "idle" },
      0,
      false,
      instructionSources,
    );
    const responseId = "response_instruction_sources";
    const running = await startProxy(directory, fake, {
      responseId,
      threadId: "thr_continuation",
      state: "ready",
      model: "m",
      cwd: join(directory, "workspace"),
      toolsHash: bindingHash([]),
      policyHash: defaultPolicyHash(join(directory, "workspace")),
    });
    try {
      const response = await post(running.origin, responseId);
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(
        (
          (await response.json()) as {
            x_codex?: {
              instructionSources?: string[];
              threadReused?: boolean;
            };
          }
        ).x_codex,
        { instructionSources, threadReused: true },
      );
      assert.deepEqual(fake.methods.slice(0, 3), [
        "thread/read",
        "thread/resume",
        "turn/start",
      ]);
    } finally {
      await running.proxy.close();
    }
  }, "codex-continuation-instruction-sources-");
});

test("streaming continuations report thread reuse on the first chunk", async () => {
  await withTempDir(async (directory) => {
    const fake = new ContinuationAppServer();
    const responseId = "response_streaming_thread_reuse";
    const running = await startProxy(directory, fake, {
      responseId,
      threadId: "thr_continuation",
      state: "ready",
      model: "m",
      cwd: join(directory, "workspace"),
      toolsHash: bindingHash([]),
      policyHash: defaultPolicyHash(join(directory, "workspace")),
    });
    try {
      const response = await post(
        running.origin,
        responseId,
        "m",
        undefined,
        true,
      );
      assert.equal(response.status, 200, await response.clone().text());
      const chunks = parseSseChunks(await response.text());
      assert.deepEqual(chunks[0]?.x_codex, {
        instructionSources: [],
        threadReused: true,
      });
      assert.equal(
        chunks.slice(1).some((chunk) => chunk.x_codex !== undefined),
        false,
      );
    } finally {
      await running.proxy.close();
    }
  }, "codex-streaming-thread-reuse-");
});

test("model, reasoning, cwd, tool, and policy binding mismatches fail before thread/read", async () => {
  const cases = [
    {
      name: "model",
      patch: { model: "other" },
      code: "continuation_model_mismatch",
    },
    {
      name: "reasoning",
      patch: { reasoningEffort: "high" },
      code: "continuation_reasoning_effort_mismatch",
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
    await withTempDir(async (directory) => {
      const fake = new ContinuationAppServer();
      const responseId = `response_${item.name}`;
      const running = await startProxy(directory, fake, {
        responseId,
        threadId: "thr_continuation",
        state: "ready",
        model: "m",
        cwd: join(directory, "workspace"),
        toolsHash: bindingHash([]),
        policyHash: defaultPolicyHash(join(directory, "workspace")),
        ...item.patch,
      });
      try {
        const response = await post(running.origin, responseId);
        assert.equal(response.status, 409, await response.clone().text());
        assert.equal(await responseErrorCode(response), item.code);
        assert.deepEqual(fake.methods, []);
      } finally {
        await running.proxy.close();
      }
    }, `codex-continuation-${item.name}-`);
  }
});

test("a record without reasoning effort rejects an explicit effort", async () => {
  await withTempDir(async (directory) => {
    const configuredRoot = join(directory, "workspace");
    await mkdir(configuredRoot, { recursive: true });
    const root = await realpath(configuredRoot);
    const responseId = "response_omitted_reasoning";
    await writeFile(
      join(directory, "continuations.json"),
      JSON.stringify({
        version: 0,
        records: [
          {
            responseId,
            threadId: "thr_continuation",
            state: "ready",
            model: "m",
            cwd: root,
            toolsHash: bindingHash([]),
            policyHash: defaultPolicyHash(root),
            createdAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          },
        ],
      }),
    );
    const fake = new ContinuationAppServer();
    const running = await startProxy(directory, fake);
    try {
      const response = await postChatCompletion(running.origin, {
        model: "m",
        reasoning_effort: "high",
        previous_response_id: responseId,
        messages: [{ role: "user", content: "continue" }],
      });
      assert.equal(response.status, 409, await response.clone().text());
      assert.equal(
        await responseErrorCode(response),
        "continuation_reasoning_effort_mismatch",
      );
      assert.deepEqual(fake.methods, []);
    } finally {
      await running.proxy.close();
    }
  }, "codex-continuation-omitted-reasoning-");
});

test("terminal mappings fail as JSON before streaming headers or thread work", async () => {
  for (const state of ["expired", "superseded"] as const) {
    await withTempDir(async (directory) => {
      const fake = new ContinuationAppServer();
      const responseId = `response_${state}`;
      const running = await startProxy(directory, fake, {
        responseId,
        threadId: "thr_continuation",
        state,
        model: "m",
        cwd: join(directory, "workspace"),
        toolsHash: bindingHash([]),
        policyHash: defaultPolicyHash(join(directory, "workspace")),
      });
      try {
        const response = await post(
          running.origin,
          responseId,
          undefined,
          undefined,
          true,
        );
        assert.equal(response.status, state === "expired" ? 410 : 409);
        assert.equal(
          response.headers.get("content-type"),
          "application/json; charset=utf-8",
        );
        assert.equal(
          await responseErrorCode(response),
          state === "expired"
            ? "expired_previous_response_id"
            : "superseded_previous_response_id",
        );
        assert.deepEqual(fake.methods, []);
      } finally {
        await running.proxy.close();
      }
    }, `codex-continuation-${state}-`);
  }
});

test("ready continuation rejects trailing tool results before thread work", async () => {
  await withTempDir(async (directory) => {
    const fake = new ContinuationAppServer();
    const responseId = "response_ready_tool";
    const running = await startProxy(directory, fake, {
      responseId,
      threadId: "thr_continuation",
      state: "ready",
      model: "m",
      cwd: join(directory, "workspace"),
      toolsHash: bindingHash([]),
      policyHash: defaultPolicyHash(join(directory, "workspace")),
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
        await responseErrorCode(response),
        "tool_results_without_pending_call",
      );
      assert.deepEqual(fake.methods, []);
    } finally {
      await running.proxy.close();
    }
  }, "codex-ready-tool-");
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
    await withTempDir(async (directory) => {
      const fake = new ContinuationAppServer(status);
      const responseId = `response_status_${index}`;
      const running = await startProxy(directory, fake, {
        responseId,
        threadId: "thr_continuation",
        state: "ready",
        model: "m",
        cwd: join(directory, "workspace"),
        toolsHash: bindingHash([]),
        policyHash: defaultPolicyHash(join(directory, "workspace")),
      });
      try {
        const response = await post(running.origin, responseId);
        assert.equal(response.status, 409);
        assert.equal(
          await responseErrorCode(response),
          status && (status as { type?: string }).type === "active"
            ? "thread_busy"
            : "thread_not_resumable",
        );
        assert.deepEqual(fake.methods, ["thread/read"]);
      } finally {
        await running.proxy.close();
      }
    }, "codex-thread-status-");
  }
});

test("concurrent ordinary requests for one active thread return an immediate 409", async () => {
  await withTempDir(async (directory) => {
    const fake = new ContinuationAppServer({ type: "idle" }, 100);
    const running = await startProxy(directory, fake, {
      responseId: "response_busy",
      threadId: "thr_continuation",
      state: "ready",
      model: "m",
      cwd: join(directory, "workspace"),
      toolsHash: bindingHash([]),
      policyHash: defaultPolicyHash(join(directory, "workspace")),
    });
    try {
      const first = post(running.origin, "response_busy");
      while (!fake.methods.includes("turn/start"))
        await new Promise<void>((resolve) => setImmediate(resolve));
      const second = await post(running.origin, "response_busy");
      assert.equal(second.status, 409);
      assert.equal(await responseErrorCode(second), "thread_busy");
      assert.equal((await first).status, 200);
      assert.equal(
        fake.methods.filter((method) => method === "thread/read").length,
        1,
      );
      assert.ok(!fake.methods.includes("thread/start"));
    } finally {
      await running.proxy.close();
    }
  }, "codex-thread-busy-");
});

test("streaming dynamic tools use standard argument deltas and interrupt at the batch", async () => {
  await withTempDir(async (directory) => {
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
      const chunks = parseSseChunks(await response.text());
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

      // The interrupt cancelled the captured request app-server side, so the
      // proxy never answers it; nothing stays pending, so replacing the
      // transport later has no responders left to cancel either.
      assert.deepEqual(fake.responderErrors, []);
      running.proxy.setTransport(undefined);
      assert.deepEqual(fake.responderErrors, []);
    } finally {
      await running.proxy.close();
    }
  }, "codex-sse-tool-");
});
