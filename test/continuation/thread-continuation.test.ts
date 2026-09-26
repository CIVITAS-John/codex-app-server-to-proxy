import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  /** All JSON-RPC responses to tool callbacks, including settled source callbacks. */
  readonly callbackResponses: Array<Record<string, unknown>> = [];
  /** Emits a source callback during thread/read before fallback preflight resolves. */
  emitSourceCallbackOnRead = false;
  /** Source status notifications emitted while a fresh thread starts. */
  sourceFloodCount = 0;
  /** Thread the source status flood claims to come from. */
  sourceFloodThreadId = "thr_continuation";
  /** Injects one synthetic RPC outcome at a specific continuation stage. */
  readonly faults: Partial<
    Record<
      "thread/read" | "thread/resume" | "thread/inject_items" | "turn/start",
      "error" | "malformed" | "wrong_thread"
    >
  > = {};
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
    public status: unknown = { type: "idle" },
    private readonly completionDelayMs = 0,
    public requestTool = false,
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
      if (message.id === 901 || message.id === 902)
        this.callbackResponses.push(message);
      if (message.id === 901 && message.error)
        this.responderErrors.push(message.error as Record<string, unknown>);
      return;
    }
    this.methods.push(message.method);
    const id = message.id as number;
    const params = (message.params ?? {}) as Record<string, unknown>;
    const fault = this.faults[message.method as keyof typeof this.faults];
    if (fault === "error") {
      this.#send({
        id,
        error: { code: -32000, message: "synthetic RPC failure" },
      });
      return;
    }
    if (fault === "malformed") {
      this.#send({ id, result: { unrelated: true } });
      return;
    }
    if (message.method === "thread/start") {
      this.#allocateThreadId();
      this.#send(
        protocolResponse("thread/start", id, {
          ...protocolThreadStartResponse(protocolThread(this.#threadId)),
          instructionSources: this.instructionSources,
        }),
      );
      for (let index = 0; index < this.sourceFloodCount; index += 1)
        this.#send(
          protocolNotification({
            method: "thread/status/changed",
            params: {
              threadId: this.sourceFloodThreadId,
              status: { type: "active", activeFlags: [] },
            },
          }),
        );
    } else if (message.method === "thread/read") {
      // The configurable unknown status is intentionally hostile protocol input.
      this.#observeThreadId(params);
      if (this.emitSourceCallbackOnRead)
        this.#send(
          protocolServerRequest({
            id: 902,
            method: "item/tool/call",
            params: {
              threadId: String(params.threadId),
              turnId: "turn_source_pending",
              callId: "call_source",
              tool: "weather",
              namespace: null,
              arguments: { city: "Chicago" },
            },
          }),
        );
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
      this.#threadId =
        fault === "wrong_thread" ? "thr_unexpected" : String(params.threadId);
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

/** Reads the persisted continuation records without disturbing the live store. */
function persistedRecords(stateDir: string): Array<Record<string, unknown>> {
  const state = JSON.parse(
    readFileSync(join(stateDir, "continuations.json"), "utf8"),
  ) as { records?: Array<Record<string, unknown>> };
  return state.records ?? [];
}

/** Assistant message declaring exactly the seeded pending `weather` call. */
const weatherAssistantMessage = {
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: "call_x",
      type: "function",
      function: { name: "weather", arguments: '{"city":"Chicago"}' },
    },
  ],
};

/**
 * Builds one live pending-tool record for the seeded weather call. The tools
 * hash defaults to the tools-less binding a plain continuation request uses;
 * passing a different hash selects the binding-mismatch fallback.
 */
function pendingWeatherRecord(
  directory: string,
  responseId: string,
  toolsHash = bindingHash([]),
): SeededRecord {
  return {
    responseId,
    threadId: "thr_continuation",
    state: "pending_tool",
    model: "m",
    cwd: join(directory, "workspace"),
    toolsHash,
    policyHash: defaultPolicyHash(join(directory, "workspace")),
    pendingCalls: [
      { callId: "call_x", name: "weather", arguments: '{"city":"Chicago"}' },
    ],
  };
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
});

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

test("fresh history drops orphan results and unanswered calls with a warning", async () => {
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
      const entries: Array<Record<string, unknown>> = [];
      const fake = new ContinuationAppServer();
      const running = await startProxy(
        directory,
        fake,
        undefined,
        createLogger("warn", (entry) => entries.push(entry)),
      );
      try {
        const response = await postChatCompletion(running.origin, {
          model: "m",
          previous_response_id: "chatcmpl_missing",
          messages: transcript.messages,
        });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(
          ((await response.json()) as { x_codex?: { threadReused?: boolean } })
            .x_codex?.threadReused,
          false,
        );
        assert.deepEqual(fake.methods, ["thread/start", "turn/start"]);
        assert.deepEqual(fake.turnInputs, [
          [{ type: "text", text: "go", text_elements: [] }],
        ]);
        assert.deepEqual(
          entries
            .filter(
              (entry) => entry.event === "unpaired_history_tool_items_dropped",
            )
            .map((entry) => [entry.unanswered_calls, entry.orphan_results]),
          [transcript.name === "orphan_result" ? [0, 1] : [1, 0]],
        );
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

test("explicit tool results with a user suffix for an expired pending record report a tool fallback", async () => {
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
        previous_response_id: "response_tombstone",
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
          { role: "user", content: "continue" },
        ],
      });
      assert.equal(response.status, 200, await response.clone().text());
      // The same record-state view that correlates a pending batch classifies
      // the expired one, so a user suffix does not hide its tool results.
      const fallbacks = entries.filter(
        (entry) => entry.event === "continuation_fresh_fallback",
      );
      assert.equal(fallbacks.length, 1);
      assert.equal(fallbacks[0]?.reason, "expired_tool_continuation");
    } finally {
      await running.proxy.close();
    }
  }, "codex-explicit-expired-suffix-");
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

test("ready continuation with a foreign tool result starts fresh", async () => {
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
      for (const trailingUser of [false, true]) {
        const response = await postChatCompletion(running.origin, {
          model: "m",
          previous_response_id: responseId,
          messages: [
            { role: "tool", tool_call_id: "call_stale", content: "result" },
            ...(trailingUser
              ? [{ role: "user", content: "next question" }]
              : []),
          ],
        });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(
          ((await response.json()) as { x_codex?: { threadReused?: boolean } })
            .x_codex?.threadReused,
          false,
        );
        assert.deepEqual(fake.methods, ["thread/start", "turn/start"]);
        assert.deepEqual(fake.turnInputs, [
          trailingUser
            ? [{ type: "text", text: "next question", text_elements: [] }]
            : [],
        ]);
        fake.methods.length = 0;
        fake.turnInputs.length = 0;
      }
      assert.equal(
        persistedRecords(directory).find(
          (record) => record.responseId === responseId,
        )?.state,
        "ready",
      );
    } finally {
      await running.proxy.close();
    }
  }, "codex-ready-tool-");
});

test("pending tool results followed by user messages resume the source thread natively", async () => {
  await withTempDir(async (directory) => {
    const fake = new ContinuationAppServer();
    const responseId = "response_pending_users";
    const running = await startProxy(
      directory,
      fake,
      pendingWeatherRecord(directory, responseId),
    );
    try {
      const response = await postChatCompletion(running.origin, {
        model: "m",
        previous_response_id: responseId,
        messages: [
          weatherAssistantMessage,
          { role: "tool", tool_call_id: "call_x", content: "sunny" },
          { role: "user", content: "earlier" },
          { role: "user", content: "final" },
        ],
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(
        ((await response.json()) as { x_codex?: { threadReused?: boolean } })
          .x_codex?.threadReused,
        true,
      );
      // One native continuation sequence: no thread/start ever runs.
      assert.deepEqual(fake.methods, [
        "thread/read",
        "thread/resume",
        "thread/inject_items",
        "turn/start",
      ]);
      // The recorded pair is injected first, then every suffix user except
      // the last, each keeping its own message as a Responses history item.
      assert.deepEqual(fake.injected, [
        {
          threadId: "thr_continuation",
          items: [
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
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "earlier" }],
            },
          ],
        },
      ]);
      // The final suffix user is the new turn's input, exactly once.
      assert.deepEqual(fake.turnInputs, [
        [{ type: "text", text: "final", text_elements: [] }],
      ]);
    } finally {
      await running.proxy.close();
    }
  }, "codex-pending-suffix-users-");
});

test("partial explicit batch with trailing user falls back over SSE and keeps complete supplied history", async () => {
  await withTempDir(async (directory) => {
    const entries: Array<Record<string, unknown>> = [];
    const fake = new ContinuationAppServer();
    const responseId = "response_partial_batch";
    const seed = pendingWeatherRecord(directory, responseId);
    seed.pendingCalls = [
      { callId: "call_x", name: "weather", arguments: '{"city":"Chicago"}' },
      { callId: "call_y", name: "weather", arguments: '{"city":"Phoenix"}' },
    ];
    const running = await startProxy(
      directory,
      fake,
      seed,
      createLogger("warn", (entry) => entries.push(entry)),
    );
    const assistant = {
      role: "assistant",
      content: "checking both cities",
      tool_calls: seed.pendingCalls.map((call) => ({
        id: call.callId,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
    try {
      const response = await postChatCompletion(running.origin, {
        model: "m",
        previous_response_id: responseId,
        stream: true,
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Prior question" },
          assistant,
          { role: "tool", tool_call_id: "call_x", content: "sunny" },
          { role: "user", content: "Next question" },
        ],
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(
        (
          parseSseChunks(await response.text())[0]?.x_codex as
            { threadReused?: boolean } | undefined
        )?.threadReused,
        false,
      );
      assert.deepEqual(fake.methods, [
        "thread/start",
        "thread/inject_items",
        "turn/start",
      ]);
      assert.deepEqual(fake.injected, [
        {
          threadId: "thr_continuation_2",
          items: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Prior question" }],
            },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "checking both cities" }],
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
      assert.deepEqual(fake.turnInputs, [
        [{ type: "text", text: "Next question", text_elements: [] }],
      ]);
      assert.deepEqual(
        entries
          .filter(
            (entry) => entry.event === "unpaired_history_tool_items_dropped",
          )
          .map((entry) => [entry.unanswered_calls, entry.orphan_results]),
        [[1, 0]],
      );
      assert.equal(
        persistedRecords(directory).find(
          (record) => record.responseId === responseId,
        )?.state,
        "pending_tool",
      );
      fake.methods.length = 0;
      const matching = await postChatCompletion(running.origin, {
        model: "m",
        previous_response_id: responseId,
        messages: [
          assistant,
          { role: "tool", tool_call_id: "call_x", content: "sunny" },
          { role: "tool", tool_call_id: "call_y", content: "warm" },
        ],
      });
      assert.equal(matching.status, 200, await matching.clone().text());
      assert.equal(
        ((await matching.json()) as { x_codex?: { threadReused?: boolean } })
          .x_codex?.threadReused,
        true,
      );
      assert.deepEqual(fake.methods, [
        "thread/read",
        "thread/resume",
        "thread/inject_items",
        "turn/start",
      ]);
    } finally {
      await running.proxy.close();
    }
  }, "codex-partial-tool-batch-");
});

test("pending continuations without results execute fresh and remain consumable", async () => {
  for (const stream of [false, true]) {
    for (const includeUnansweredCall of [false, true]) {
      await withTempDir(async (directory) => {
        const fake = new ContinuationAppServer();
        const entries: Array<Record<string, unknown>> = [];
        const responseId = "response_pending_missing_results";
        const running = await startProxy(
          directory,
          fake,
          pendingWeatherRecord(directory, responseId),
          createLogger("info", (entry) => entries.push(entry)),
        );
        const source = persistedRecords(directory).find(
          (record) => record.responseId === responseId,
        );
        try {
          const response = await postChatCompletion(running.origin, {
            model: "m",
            stream,
            previous_response_id: responseId,
            messages: [
              ...(includeUnansweredCall
                ? [
                    { role: "user", content: "earlier question" },
                    { ...weatherAssistantMessage, content: "checking weather" },
                  ]
                : []),
              { role: "user", content: "new question" },
            ],
          });
          assert.equal(response.status, 200, await response.clone().text());
          if (stream) {
            const text = await response.text();
            const chunks = parseSseChunks(text);
            assert.deepEqual(chunks[0]?.x_codex, {
              instructionSources: [],
              threadReused: false,
            });
            assert.ok(text.includes("data: [DONE]"));
          } else {
            assert.equal(
              (
                (await response.json()) as {
                  x_codex: { threadReused: boolean };
                }
              ).x_codex.threadReused,
              false,
            );
          }
          assert.deepEqual(fake.methods, [
            "thread/start",
            ...(includeUnansweredCall ? ["thread/inject_items"] : []),
            "turn/start",
          ]);
          assert.deepEqual(fake.turnInputs, [
            [{ type: "text", text: "new question", text_elements: [] }],
          ]);
          assert.deepEqual(
            fake.injected.flatMap((injection) => injection.items),
            includeUnansweredCall
              ? [
                  {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "earlier question" }],
                  },
                  {
                    type: "message",
                    role: "assistant",
                    content: [
                      { type: "output_text", text: "checking weather" },
                    ],
                  },
                ]
              : [],
          );
          assert.deepEqual(
            persistedRecords(directory).find(
              (record) => record.responseId === responseId,
            ),
            source,
          );
          assert.deepEqual(
            entries
              .filter((entry) => entry.event === "continuation_fresh_fallback")
              .map((entry) => entry.reason),
            ["tool_results_required"],
          );
          assert.equal(
            entries.filter(
              (entry) => entry.event === "unpaired_history_tool_items_dropped",
            ).length,
            includeUnansweredCall ? 1 : 0,
          );
          // Starting independently must not claim or consume the pending source.
          fake.methods.length = 0;
          const continued = await postChatCompletion(running.origin, {
            model: "m",
            previous_response_id: responseId,
            messages: [
              weatherAssistantMessage,
              { role: "tool", tool_call_id: "call_x", content: "sunny" },
            ],
          });
          assert.equal(continued.status, 200, await continued.clone().text());
          assert.equal(
            ((await continued.json()) as { x_codex: { threadReused: boolean } })
              .x_codex.threadReused,
            true,
          );
          assert.deepEqual(fake.methods, [
            "thread/read",
            "thread/resume",
            "thread/inject_items",
            "turn/start",
          ]);
        } finally {
          await running.proxy.close();
        }
      }, "codex-pending-no-results-");
    }
  }
}, 15_000);

test("incompatible pending batches execute fresh and preserve their source checkpoint", async () => {
  await withTempDir(async (directory) => {
    const fake = new ContinuationAppServer();
    const responseId = "response_pending_users";
    const running = await startProxy(
      directory,
      fake,
      pendingWeatherRecord(directory, responseId),
    );
    const cases = [
      {
        name: "orphan history",
        messages: [
          { role: "tool", tool_call_id: "call_orphan", content: "orphan" },
          { role: "assistant", content: "earlier reply" },
          { role: "user", content: "go" },
        ],
      },
      {
        name: "changed arguments",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_x",
                type: "function",
                function: { name: "weather", arguments: '{"city":"Tampa"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_x", content: "r" },
          { role: "user", content: "go" },
        ],
      },
      {
        name: "reformatted JSON",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_x",
                type: "function",
                function: {
                  name: "weather",
                  arguments: '{ "city": "Chicago" }',
                },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_x", content: "r" },
          { role: "user", content: "go" },
        ],
      },
      {
        name: "changed name",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_x",
                type: "function",
                function: { name: "forecast", arguments: '{"city":"Chicago"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_x", content: "r" },
          { role: "user", content: "go" },
        ],
      },
      {
        name: "changed ID",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_y",
                type: "function",
                function: { name: "weather", arguments: '{"city":"Chicago"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_y", content: "r" },
          { role: "user", content: "go" },
        ],
      },
      {
        name: "earlier completed round",
        messages: [
          { role: "user", content: "history" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_x",
                type: "function",
                function: { name: "weather", arguments: '{"city":"Miami"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_x", content: "old result" },
          { role: "user", content: "go" },
        ],
      },
      {
        name: "result without assistant",
        messages: [
          { role: "tool", tool_call_id: "call_x", content: "r" },
          { role: "user", content: "go" },
        ],
      },
      {
        name: "split result block",
        messages: [
          weatherAssistantMessage,
          { role: "tool", tool_call_id: "call_x", content: "r" },
          { role: "user", content: "split" },
          { role: "tool", tool_call_id: "call_x", content: "again" },
        ],
      },
      {
        name: "foreign result",
        messages: [
          weatherAssistantMessage,
          { role: "tool", tool_call_id: "foreign", content: "x" },
          { role: "user", content: "go" },
        ],
      },
    ];
    try {
      for (const testCase of cases) {
        const response = await postChatCompletion(running.origin, {
          model: "m",
          previous_response_id: responseId,
          messages: testCase.messages,
        });
        assert.equal(
          response.status,
          200,
          `${testCase.name}: ${await response.clone().text()}`,
        );
        assert.equal(
          ((await response.json()) as { x_codex?: { threadReused?: boolean } })
            .x_codex?.threadReused,
          false,
          testCase.name,
        );
        assert.equal(
          fake.methods.includes("thread/read"),
          false,
          testCase.name,
        );
        assert.equal(
          fake.methods.includes("thread/resume"),
          false,
          testCase.name,
        );
        assert.equal(
          persistedRecords(directory).find(
            (record) => record.responseId === responseId,
          )?.state,
          "pending_tool",
          testCase.name,
        );
      }
      fake.methods.length = 0;
      // The exact original batch still consumes the unchanged source natively.
      const fixed = await postChatCompletion(running.origin, {
        model: "m",
        previous_response_id: responseId,
        messages: [
          weatherAssistantMessage,
          { role: "tool", tool_call_id: "call_x", content: "fixed result" },
          { role: "user", content: "fixed question" },
        ],
      });
      assert.equal(fixed.status, 200, await fixed.clone().text());
      assert.equal(
        ((await fixed.json()) as { x_codex?: { threadReused?: boolean } })
          .x_codex?.threadReused,
        true,
      );
    } finally {
      await running.proxy.close();
    }
  }, "codex-pending-suffix-fallback-");
}, 20_000);

test("duplicate IDs within the selected pending batch remain ambiguous input", async () => {
  await withTempDir(async (directory) => {
    const fake = new ContinuationAppServer();
    const responseId = "response_duplicate_selected";
    const running = await startProxy(
      directory,
      fake,
      pendingWeatherRecord(directory, responseId),
    );
    try {
      const response = await postChatCompletion(running.origin, {
        model: "m",
        previous_response_id: responseId,
        messages: [
          weatherAssistantMessage,
          { role: "tool", tool_call_id: "call_x", content: "first" },
          { role: "tool", tool_call_id: "call_x", content: "second" },
        ],
      });
      assert.equal(response.status, 400);
      assert.equal(await responseErrorCode(response), "duplicate_tool_call_id");
      assert.deepEqual(fake.methods, []);
      assert.equal(
        persistedRecords(directory).find(
          (record) => record.responseId === responseId,
        )?.state,
        "pending_tool",
      );
    } finally {
      await running.proxy.close();
    }
  }, "codex-selected-duplicate-");
});

test("a binding-mismatched pending suffix selector executes the transcript on a fresh thread", async () => {
  await withTempDir(async (directory) => {
    const fake = new ContinuationAppServer();
    const responseId = "response_pending_mismatch";
    const running = await startProxy(
      directory,
      fake,
      pendingWeatherRecord(
        directory,
        responseId,
        bindingHash([{ name: "other" }]),
      ),
    );
    try {
      const response = await postChatCompletion(running.origin, {
        model: "m",
        previous_response_id: responseId,
        messages: [
          weatherAssistantMessage,
          { role: "tool", tool_call_id: "call_x", content: "sunny" },
          { role: "user", content: "earlier" },
          { role: "user", content: "final" },
        ],
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(
        ((await response.json()) as { x_codex?: { threadReused?: boolean } })
          .x_codex?.threadReused,
        false,
      );
      // The mismatch is detected locally: one fresh execution of the
      // complete transcript and no source RPC at all.
      assert.deepEqual(fake.methods, [
        "thread/start",
        "thread/inject_items",
        "turn/start",
      ]);
      // The fresh thread never recycles the seeded source id, and it carries
      // the pair plus every suffix user except the final one.
      assert.deepEqual(fake.injected, [
        {
          threadId: "thr_continuation_2",
          items: [
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
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "earlier" }],
            },
          ],
        },
      ]);
      assert.deepEqual(fake.turnInputs, [
        [{ type: "text", text: "final", text_elements: [] }],
      ]);
      // The bypassed source is never consumed by the fallback.
      assert.equal(
        persistedRecords(directory).find(
          (record) => record.responseId === responseId,
        )?.state,
        "pending_tool",
      );
    } finally {
      await running.proxy.close();
    }
  }, "codex-pending-suffix-fallback-");
});

test("a completed tool round then a user message stays fresh with implicit continuation disabled", async () => {
  await withTempDir(async (directory) => {
    const fake = new ContinuationAppServer();
    // The local startProxy helper does not expose the implicit-continuation
    // flag, so this test boots the proxy exactly as the helper does.
    const configuredRoot = join(directory, "workspace");
    await mkdir(configuredRoot, { recursive: true });
    const root = await realpath(configuredRoot);
    const running = await startProxyWithTransport(fake.transport, {
      root,
      stateDir: directory,
      implicitToolContinuation: false,
    });
    try {
      const response = await postChatCompletion(running.origin, {
        model: "m",
        messages: [
          { role: "user", content: "use tools" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_old",
                type: "function",
                function: { name: "first", arguments: '{"old":1}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_old", content: "old result" },
          { role: "user", content: "continue" },
        ],
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(
        ((await response.json()) as { x_codex?: { threadReused?: boolean } })
          .x_codex?.threadReused,
        false,
      );
      // The completed round is ordinary replayed history, never a tool
      // continuation: one fresh thread, one injection, one turn.
      assert.deepEqual(fake.methods, [
        "thread/start",
        "thread/inject_items",
        "turn/start",
      ]);
      assert.deepEqual(fake.injected, [
        {
          threadId: "thr_continuation",
          items: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "use tools" }],
            },
            {
              type: "function_call",
              name: "first",
              arguments: '{"old":1}',
              call_id: "call_old",
            },
            {
              type: "function_call_output",
              call_id: "call_old",
              output: "old result",
            },
          ],
        },
      ]);
      // The trailing user message is the new turn's input.
      assert.deepEqual(fake.turnInputs, [
        [{ type: "text", text: "continue", text_elements: [] }],
      ]);
    } finally {
      await running.proxy.close();
    }
  }, "codex-implicit-disabled-history-");
});

test("busy and non-resumable thread/read states start one fresh thread", async () => {
  const states: unknown[] = [
    { type: "active" },
    { type: "systemError" },
    { type: "archived" },
    { type: "deleted" },
    { type: "futureStatus" },
  ];
  for (const [index, status] of states.entries()) {
    await withTempDir(async (directory) => {
      const entries: Array<Record<string, unknown>> = [];
      const fake = new ContinuationAppServer(status);
      const responseId = `response_status_${index}`;
      const running = await startProxy(
        directory,
        fake,
        {
          responseId,
          threadId: "thr_continuation",
          state: "ready",
          model: "m",
          cwd: join(directory, "workspace"),
          toolsHash: bindingHash([]),
          policyHash: defaultPolicyHash(join(directory, "workspace")),
        },
        createLogger("info", (entry) => entries.push(entry)),
      );
      try {
        const response = await post(running.origin, responseId);
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(
          ((await response.json()) as { x_codex?: { threadReused?: boolean } })
            .x_codex?.threadReused,
          false,
        );
        assert.deepEqual(fake.methods, [
          "thread/read",
          "thread/start",
          "turn/start",
        ]);
        // Remote activity is reported apart from local lease contention.
        assert.deepEqual(
          entries
            .filter((entry) => entry.event === "continuation_fresh_fallback")
            .map((entry) => entry.reason),
          [index === 0 ? "thread_active" : "thread_not_resumable"],
        );
        assert.equal(
          persistedRecords(directory).find(
            (record) => record.responseId === responseId,
          )?.state,
          "ready",
        );
      } finally {
        await running.proxy.close();
      }
    }, "codex-thread-status-");
  }
}, 15_000);

test("read and resume RPC errors or a different resumed thread select fresh execution", async () => {
  for (const [method, fault] of [
    ["thread/read", "error"],
    ["thread/resume", "error"],
    ["thread/resume", "wrong_thread"],
  ] as const) {
    await withTempDir(async (directory) => {
      const fake = new ContinuationAppServer();
      fake.faults[method] = fault;
      if (fault === "wrong_thread") {
        // The thread app-server resumed in the source's place must not
        // overflow fresh startup ingress with its own late events.
        fake.sourceFloodThreadId = "thr_unexpected";
        fake.sourceFloodCount = 1_200;
      }
      const responseId = `response_preflight_${method}_${fault}`;
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
        assert.equal(
          ((await response.json()) as { x_codex?: { threadReused?: boolean } })
            .x_codex?.threadReused,
          false,
        );
        assert.deepEqual(fake.methods, [
          "thread/read",
          ...(method === "thread/resume" ? ["thread/resume"] : []),
          "thread/start",
          "turn/start",
        ]);
        assert.equal(
          persistedRecords(directory).find(
            (record) => record.responseId === responseId,
          )?.state,
          "ready",
        );
      } finally {
        await running.proxy.close();
      }
    }, "codex-preflight-rpc-");
  }
}, 12_000);

test("malformed preflight envelopes and failed fresh injection or turn start never retry", async () => {
  for (const [method, fault, expectedMethods] of [
    ["thread/read", "malformed", ["thread/read"]],
    ["thread/resume", "malformed", ["thread/read", "thread/resume"]],
    ["thread/inject_items", "error", ["thread/start", "thread/inject_items"]],
    ["turn/start", "error", ["thread/start", "turn/start"]],
  ] as const) {
    await withTempDir(async (directory) => {
      const fake = new ContinuationAppServer();
      fake.faults[method] = fault;
      const responseId = `response_failure_${method}_${fault}`;
      const seed =
        method === "thread/read" || method === "thread/resume"
          ? {
              responseId,
              threadId: "thr_continuation",
              state: "ready" as const,
              model: "m",
              cwd: join(directory, "workspace"),
              toolsHash: bindingHash([]),
              policyHash: defaultPolicyHash(join(directory, "workspace")),
            }
          : undefined;
      const running = await startProxy(directory, fake, seed);
      try {
        const response = await postChatCompletion(running.origin, {
          model: "m",
          ...(seed ? { previous_response_id: responseId } : {}),
          messages:
            method === "thread/inject_items"
              ? [
                  { role: "user", content: "history" },
                  { role: "user", content: "new question" },
                ]
              : [{ role: "user", content: "new question" }],
        });
        assert.notEqual(response.status, 200);
        assert.deepEqual(fake.methods, expectedMethods);
        assert.equal(
          fake.methods.filter((value) => value === "thread/start").length <= 1,
          true,
        );
      } finally {
        await running.proxy.close();
      }
    }, "codex-no-retry-");
  }
}, 12_000);

test("preflight fallback settles source callbacks, ignores late source events, and accepts fresh callbacks", async () => {
  await withTempDir(async (directory) => {
    const fake = new ContinuationAppServer();
    const tools = [
      {
        type: "function",
        function: { name: "weather", parameters: { type: "object" } },
      },
    ];
    const running = await startProxy(directory, fake);
    try {
      const initial = await postChatCompletion(running.origin, {
        model: "m",
        tools,
        messages: [{ role: "user", content: "initial" }],
      });
      assert.equal(initial.status, 200, await initial.clone().text());
      const responseId = ((await initial.json()) as { id: string }).id;
      fake.methods.length = 0;
      fake.status = { type: "active" };
      fake.requestTool = true;
      fake.emitSourceCallbackOnRead = true;
      fake.sourceFloodCount = 1_200;
      const response = await post(running.origin, responseId, "m", tools);
      assert.equal(response.status, 200, await response.clone().text());
      const body = (await response.json()) as {
        x_codex?: { threadReused?: boolean };
        choices?: Array<{
          finish_reason?: string;
          message?: { tool_calls?: unknown[] };
        }>;
      };
      assert.equal(body.x_codex?.threadReused, false);
      assert.equal(body.choices?.[0]?.finish_reason, "tool_calls");
      assert.equal(body.choices?.[0]?.message?.tool_calls?.length, 1);
      assert.deepEqual(fake.methods.slice(0, 3), [
        "thread/read",
        "thread/start",
        "turn/start",
      ]);
      assert.ok(fake.methods.includes("turn/interrupt"));
      assert.ok(
        fake.callbackResponses.some((item) => item.id === 902 && item.error),
      );
      assert.equal(
        persistedRecords(directory).find(
          (record) => record.responseId === responseId,
        )?.state,
        "ready",
      );

      // The source lease was released before fresh startup. Once it reports
      // idle, the same selector can still resume its original thread.
      fake.status = { type: "idle" };
      fake.emitSourceCallbackOnRead = false;
      fake.sourceFloodCount = 0;
      fake.methods.length = 0;
      const matching = await post(running.origin, responseId, "m", tools);
      assert.equal(matching.status, 200, await matching.clone().text());
      assert.equal(
        ((await matching.json()) as { x_codex?: { threadReused?: boolean } })
          .x_codex?.threadReused,
        true,
      );
      assert.deepEqual(fake.methods.slice(0, 3), [
        "thread/read",
        "thread/resume",
        "turn/start",
      ]);
    } finally {
      await running.proxy.close();
    }
  }, "codex-source-callback-fallback-");
}, 10_000);

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
