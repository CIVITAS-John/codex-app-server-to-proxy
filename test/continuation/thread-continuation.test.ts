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
import { createLogger, type Logger } from "../../src/core/logger.js";
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

/** A configurable fake app-server for continuation admission and fallback tests. */
class ContinuationAppServer {
  readonly transport: JsonRpcTransport;
  readonly methods: string[] = [];
  readonly responderErrors: Array<Record<string, unknown>> = [];
  /** Items each thread/inject_items call carried, in arrival order. */
  readonly injected: Array<{ threadId: string; items: unknown[] }> = [];
  /** Turn input lists, one entry per turn/start, in arrival order. */
  readonly turnInputs: Array<unknown[]> = [];
  readonly #fromServer = new PassThrough();
  readonly #toServer = new PassThrough();
  /** Thread of the most recent start or resume; each turn captures its own copy. */
  #threadId = "thr_continuation";
  /**
   * Thread ids already in play via a seeded record, read, resume, or an
   * earlier start.
   */
  readonly #knownThreads = new Set<string>();
  /** Count of thread/start calls, driving distinct fresh thread identifiers. */
  #starts = 0;
  #turn = 0;
  /** The tool-call turn currently awaiting its interrupt, if any. */
  #toolTurn: { threadId: string; turnId: string } | undefined;

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

  /** Records one thread id that is already in play on this transport. */
  #observeThreadId(params: Record<string, unknown>): void {
    this.#knownThreads.add(String(params.threadId));
  }

  /** Records one thread id a seeded store record already put in play. */
  observeSeededThread(threadId: string): void {
    // A seeded record's thread exists app-server-side before any request, so
    // a fallback's thread/start must never reuse its id: the fallback's own
    // success would supersede the seeded source record in the store.
    this.#knownThreads.add(threadId);
  }

  /**
   * Allocates one fresh thread id no seeded record, read, resume, or start
   * has used.
   */
  #allocateThreadId(): void {
    // Real app-server returns a new thread id per start and never recycles a
    // live thread's id, so a fallback's success supersedes only its own
    // thread's records and never collides with a resumed or seeded source.
    do {
      this.#starts += 1;
      this.#threadId =
        this.#starts === 1
          ? "thr_continuation"
          : `thr_continuation_${this.#starts}`;
    } while (this.#knownThreads.has(this.#threadId));
    this.#knownThreads.add(this.#threadId);
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
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (message.method === "thread/start") {
      this.#allocateThreadId();
      this.#send(
        protocolResponse("thread/start", id, {
          ...protocolThreadStartResponse(protocolThread(this.#threadId)),
          instructionSources: this.instructionSources,
        }),
      );
    } else if (message.method === "thread/read") {
      // The configurable unknown status is intentionally hostile protocol input.
      this.#observeThreadId(params);
      this.#send({
        id,
        result: {
          thread: { id: String(params.threadId), status: this.status },
        },
      });
    } else if (message.method === "thread/resume") {
      // Echo the requested thread so native continuation of a source thread
      // still works after fallbacks allocated new threads.
      this.#observeThreadId(params);
      this.#threadId = String(params.threadId);
      this.#send(
        protocolResponse("thread/resume", id, {
          ...protocolThreadResumeResponse(protocolThread(this.#threadId)),
          instructionSources: this.instructionSources,
        }),
      );
    } else if (message.method === "thread/inject_items") {
      this.injected.push({
        threadId: String(params.threadId),
        items: Array.isArray(params.items) ? params.items : [],
      });
      this.#send(protocolResponse("thread/inject_items", id, {}));
    } else if (message.method === "turn/start") {
      const turnId = `turn_continuation_${++this.#turn}`;
      // Each turn captures its thread at start, so a delayed completion stays
      // correlated after another request started or resumed a new thread.
      const threadId = this.#threadId;
      this.turnInputs.push((params.input ?? []) as unknown[]);
      this.#send(
        protocolResponse("turn/start", id, {
          turn: protocolTurn(turnId, "inProgress"),
        }),
      );
      if (this.requestTool) {
        this.#toolTurn = { threadId, turnId };
        this.#send(
          protocolServerRequest({
            id: 901,
            method: "item/tool/call",
            params: {
              threadId,
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
              threadId,
              turnId,
              responseId: `raw_${turnId}`,
              usage: null,
              usageMetadata: null,
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
              threadId,
              turn: protocolTurn(turnId, "completed"),
            },
          }),
        );
        this.#send(
          protocolNotification({
            method: "thread/status/changed",
            params: { threadId, status: { type: "idle" } },
          }),
        );
      };
      if (this.completionDelayMs)
        setTimeout(complete, this.completionDelayMs).unref();
      else complete();
    } else if (message.method === "turn/interrupt") {
      this.#send(protocolResponse("turn/interrupt", id, {}));
      const toolTurn = this.#toolTurn;
      if (!toolTurn) return;
      this.#toolTurn = undefined;
      this.#send(
        protocolNotification({
          method: "turn/completed",
          params: {
            threadId: toolTurn.threadId,
            turn: protocolTurn(toolTurn.turnId, "interrupted"),
          },
        }),
      );
      this.#send(
        protocolNotification({
          method: "thread/status/changed",
          params: {
            threadId: toolTurn.threadId,
            status: { type: "idle" },
          },
        }),
      );
    }
  }
}

/** One response mapping startProxy seeds into the continuation store. */
type SeededRecord = Parameters<ResponseStore["put"]>[0];

/** Starts a ready proxy and returns its effective cwd binding. */
async function startProxy(
  directory: string,
  fake: ContinuationAppServer,
  seed?: SeededRecord | SeededRecord[],
  log?: Logger,
): Promise<{ origin: string; proxy: ProxyServer; root: string }> {
  const configuredRoot = join(directory, "workspace");
  await mkdir(configuredRoot, { recursive: true });
  const root = await realpath(configuredRoot);
  const records = Array.isArray(seed) ? seed : seed ? [seed] : [];
  for (const record of records) {
    const defaultHash = defaultPolicyHash(configuredRoot);
    new ResponseStore(directory).put({
      ...record,
      cwd: record.cwd === configuredRoot ? root : record.cwd,
      policyHash:
        record.policyHash === defaultHash
          ? defaultPolicyHash(root)
          : record.policyHash,
    });
    // The seeded thread already exists app-server-side, so the fake must
    // treat it as in play before any request: a fallback allocating the same
    // id would supersede the seeded source record when it records its own
    // completed response.
    fake.observeSeededThread(record.threadId);
  }
  const running = await startProxyWithTransport(fake.transport, {
    root,
    stateDir: directory,
    ...(log ? { log } : {}),
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

/** Asserts one response executed on a fresh thread without source RPC. */
async function assertFreshFallback(
  response: Response,
  fake: ContinuationAppServer,
): Promise<void> {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(
    ((await response.json()) as { x_codex?: { threadReused?: boolean } })
      .x_codex?.threadReused,
    false,
  );
  assert.deepEqual(fake.methods, ["thread/start", "turn/start"]);
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

test("model, reasoning, cwd, tool, and policy binding mismatches select a fresh thread before any source RPC", async () => {
  const cases = [
    { name: "model", patch: { model: "other" } },
    { name: "reasoning", patch: { reasoningEffort: "high" } },
    { name: "cwd", patch: { cwd: "/different" } },
    { name: "tools", patch: { toolsHash: bindingHash([{ name: "other" }]) } },
    {
      name: "policy",
      patch: { policyHash: bindingHash({ sandbox: "read-only" }) },
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
        await assertFreshFallback(await post(running.origin, responseId), fake);
      } finally {
        await running.proxy.close();
      }
    }, `codex-continuation-${item.name}-`);
  }
  // Each case now completes one fresh turn, whose idle-usage grace costs
  // about a second, so the loop needs more than the default budget.
}, 20_000);

test("a record without reasoning effort falls back to a fresh thread for an explicit effort", async () => {
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
      await assertFreshFallback(response, fake);
    } finally {
      await running.proxy.close();
    }
  }, "codex-continuation-omitted-reasoning-");
});

test("expired and superseded mappings execute the transcript on a fresh thread", async () => {
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
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(
          response.headers.get("content-type"),
          "text/event-stream; charset=utf-8",
        );
        const chunks = parseSseChunks(await response.text());
        assert.deepEqual(chunks[0]?.x_codex, {
          instructionSources: [],
          threadReused: false,
        });
        assert.deepEqual(fake.methods, ["thread/start", "turn/start"]);
      } finally {
        await running.proxy.close();
      }
    }, `codex-continuation-${state}-`);
  }
});

test("an unknown explicit selector executes on a fresh thread", async () => {
  await withTempDir(async (directory) => {
    const fake = new ContinuationAppServer();
    const running = await startProxy(directory, fake);
    try {
      await assertFreshFallback(
        await post(running.origin, "chatcmpl_missing"),
        fake,
      );
    } finally {
      await running.proxy.close();
    }
  }, "codex-unknown-selector-");
});

test("fallback transcripts with orphan results or unanswered calls fail before any RPC", async () => {
  const transcripts = [
    {
      name: "orphan_result",
      messages: [
        { role: "tool", tool_call_id: "call_x", content: "r" },
        { role: "user", content: "go" },
      ],
    },
    {
      name: "unanswered_call",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              type: "function",
              id: "call_x",
              function: { name: "weather", arguments: '{"city":"Chicago"}' },
            },
          ],
        },
        { role: "user", content: "go" },
      ],
    },
  ] as const;
  for (const transcript of transcripts) {
    await withTempDir(async (directory) => {
      const fake = new ContinuationAppServer();
      const running = await startProxy(directory, fake);
      try {
        const response = await postChatCompletion(running.origin, {
          model: "m",
          previous_response_id: "chatcmpl_missing",
          messages: transcript.messages,
        });
        assert.equal(response.status, 400);
        const body = (await response.json()) as {
          error: { code: string; param: string | null };
        };
        assert.equal(body.error.code, "invalid_request");
        assert.equal(body.error.param, "messages");
        assert.deepEqual(fake.methods, []);
      } finally {
        await running.proxy.close();
      }
    }, `codex-fallback-pairing-${transcript.name}-`);
  }
});

test("implicit tool results without any pending record execute on a fresh thread", async () => {
  await withTempDir(async (directory) => {
    const fake = new ContinuationAppServer();
    const running = await startProxy(directory, fake);
    try {
      const response = await postChatCompletion(running.origin, {
        model: "m",
        messages: [
          { role: "user", content: "weather please" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                type: "function",
                id: "call_x",
                function: { name: "weather", arguments: '{"city":"Chicago"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_x", content: "sunny" },
        ],
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(
        ((await response.json()) as { x_codex?: { threadReused?: boolean } })
          .x_codex?.threadReused,
        false,
      );
      assert.deepEqual(fake.methods, [
        "thread/start",
        "thread/inject_items",
        "turn/start",
      ]);
      // The complete assistant call/result pair is injected as thread history.
      assert.deepEqual(fake.injected, [
        {
          threadId: "thr_continuation",
          items: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "weather please" }],
            },
            {
              type: "function_call",
              name: "weather",
              arguments: '{"city":"Chicago"}',
              call_id: "call_x",
            },
            {
              type: "function_call_output",
              call_id: "call_x",
              output: "sunny",
            },
          ],
        },
      ]);
      // The terminal tool block is injected history, so the turn input is empty.
      assert.deepEqual(fake.turnInputs, [[]]);
    } finally {
      await running.proxy.close();
    }
  }, "codex-implicit-fallback-");
});

test("implicit tool results for one expired pending record execute on a fresh thread", async () => {
  await withTempDir(async (directory) => {
    const entries: Array<Record<string, unknown>> = [];
    const fake = new ContinuationAppServer();
    const running = await startProxy(
      directory,
      fake,
      {
        responseId: "response_tombstone",
        threadId: "thr_continuation",
        state: "expired",
        model: "m",
        cwd: join(directory, "workspace"),
        toolsHash: bindingHash([]),
        policyHash: defaultPolicyHash(join(directory, "workspace")),
        pendingCalls: [
          { callId: "call_tombstone", name: "t", arguments: "{}" },
        ],
      },
      createLogger("info", (entry) => entries.push(entry)),
    );
    try {
      const response = await postChatCompletion(running.origin, {
        model: "m",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                type: "function",
                id: "call_tombstone",
                function: { name: "t", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_tombstone", content: "r" },
        ],
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(
        ((await response.json()) as { x_codex?: { threadReused?: boolean } })
          .x_codex?.threadReused,
        false,
      );
      assert.deepEqual(fake.methods, [
        "thread/start",
        "thread/inject_items",
        "turn/start",
      ]);
      // The complete call/result pair is injected as history on a fresh
      // thread that is not the seeded source, so the tombstoned record is
      // never superseded by the fallback's own success.
      assert.deepEqual(fake.injected, [
        {
          threadId: "thr_continuation_2",
          items: [
            {
              type: "function_call",
              name: "t",
              arguments: "{}",
              call_id: "call_tombstone",
            },
            {
              type: "function_call_output",
              call_id: "call_tombstone",
              output: "r",
            },
          ],
        },
      ]);
      // The terminal tool block is injected history, so the turn input is empty.
      assert.deepEqual(fake.turnInputs, [[]]);
      const fallbacks = entries.filter(
        (entry) => entry.event === "continuation_fresh_fallback",
      );
      assert.equal(fallbacks.length, 1);
      assert.equal(fallbacks[0]?.reason, "expired_tool_continuation");
    } finally {
      await running.proxy.close();
    }
  }, "codex-implicit-expired-");
});

test("implicit tool results matching two expired records execute on a fresh thread", async () => {
  await withTempDir(async (directory) => {
    const entries: Array<Record<string, unknown>> = [];
    const fake = new ContinuationAppServer();
    const binding = {
      model: "m",
      cwd: join(directory, "workspace"),
      toolsHash: bindingHash([]),
      policyHash: defaultPolicyHash(join(directory, "workspace")),
    };
    const running = await startProxy(
      directory,
      fake,
      [
        {
          responseId: "response_ambiguous_a",
          threadId: "thr_ambiguous_a",
          state: "expired",
          ...binding,
          pendingCalls: [{ callId: "call_shared", name: "t", arguments: "{}" }],
        },
        {
          responseId: "response_ambiguous_b",
          threadId: "thr_ambiguous_b",
          state: "expired",
          ...binding,
          pendingCalls: [{ callId: "call_shared", name: "t", arguments: "{}" }],
        },
      ],
      createLogger("info", (entry) => entries.push(entry)),
    );
    try {
      const response = await postChatCompletion(running.origin, {
        model: "m",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                type: "function",
                id: "call_shared",
                function: { name: "t", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_shared", content: "r" },
        ],
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(
        ((await response.json()) as { x_codex?: { threadReused?: boolean } })
          .x_codex?.threadReused,
        false,
      );
      assert.deepEqual(fake.methods, [
        "thread/start",
        "thread/inject_items",
        "turn/start",
      ]);
      const fallbacks = entries.filter(
        (entry) => entry.event === "continuation_fresh_fallback",
      );
      assert.equal(fallbacks.length, 1);
      assert.equal(fallbacks[0]?.reason, "ambiguous_tool_call_id");
    } finally {
      await running.proxy.close();
    }
  }, "codex-implicit-ambiguous-");
});

test("implicit duplicate tool result IDs fail before any RPC", async () => {
  await withTempDir(async (directory) => {
    const fake = new ContinuationAppServer();
    const running = await startProxy(directory, fake);
    try {
      const response = await postChatCompletion(running.origin, {
        model: "m",
        messages: [
          { role: "user", content: "weather please" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                type: "function",
                id: "call_x",
                function: { name: "weather", arguments: '{"city":"Chicago"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_x", content: "sunny" },
          { role: "tool", tool_call_id: "call_x", content: "again" },
        ],
      });
      assert.equal(response.status, 400);
      assert.equal(await responseErrorCode(response), "duplicate_tool_call_id");
      assert.deepEqual(fake.methods, []);
    } finally {
      await running.proxy.close();
    }
  }, "codex-implicit-duplicate-");
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

test("a request contending with an active thread falls back to a fresh execution", async () => {
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
      assert.equal(second.status, 200, await second.clone().text());
      assert.equal(
        ((await second.json()) as { x_codex?: { threadReused?: boolean } })
          .x_codex?.threadReused,
        false,
      );
      // The source request keeps its lease and turn; only its lifecycle RPCs
      // appear, and the contending request starts exactly one fresh thread.
      const firstResponse = await first;
      assert.equal(firstResponse.status, 200);
      assert.equal(
        (
          (await firstResponse.json()) as {
            x_codex?: { threadReused?: boolean };
          }
        ).x_codex?.threadReused,
        true,
      );
      assert.deepEqual(fake.methods, [
        "thread/read",
        "thread/resume",
        "turn/start",
        "thread/start",
        "turn/start",
      ]);
      assert.ok(!fake.methods.includes("thread/fork"));
    } finally {
      await running.proxy.close();
    }
  }, "codex-thread-busy-");
});

test("a fresh fallback logs one bounded diagnostic", async () => {
  await withTempDir(async (directory) => {
    const entries: Array<Record<string, unknown>> = [];
    const fake = new ContinuationAppServer();
    const running = await startProxy(
      directory,
      fake,
      undefined,
      createLogger("info", (entry) => entries.push(entry)),
    );
    try {
      const response = await post(running.origin, "chatcmpl_missing");
      assert.equal(response.status, 200, await response.clone().text());
      const fallbacks = entries.filter(
        (entry) => entry.event === "continuation_fresh_fallback",
      );
      assert.equal(fallbacks.length, 1);
      const [fallback] = fallbacks;
      assert.ok(fallback);
      assert.equal(fallback.level, "info");
      assert.equal(typeof fallback.request_id, "string");
      assert.equal(fallback.reason, "unknown_previous_response_id");
      // The entry carries nothing beyond the shared log envelope: no
      // transcript, tool arguments, or thread identifiers.
      assert.deepEqual(Object.keys(fallback).sort(), [
        "event",
        "level",
        "reason",
        "request_id",
        "time",
      ]);
    } finally {
      await running.proxy.close();
    }
  }, "codex-fallback-diagnostic-");
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
