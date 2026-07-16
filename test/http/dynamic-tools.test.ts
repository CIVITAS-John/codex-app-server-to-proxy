import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { test } from "vitest";
import {
  parseServeOptions,
  resolveServeOptions,
} from "../../src/core/config.js";
import { JsonRpcTransport } from "../../src/app-server/json-rpc.js";
import { createLogger } from "../../src/core/logger.js";
import { createProxyServer, type ProxyServer } from "../../src/http/server.js";
import {
  protocolNotification,
  protocolTurn,
} from "../support/protocol-fixtures.js";
import { UNRESTRICTED_POLICY_REQUIREMENTS } from "../../src/core/policy.js";

/** Suppresses expected diagnostics in dynamic-tool HTTP tests. */
const silentLogger = createLogger("error", () => {});

/** Minimal parsed Chat Completions response used by the acceptance tests. */
interface CompletionBody {
  id: string;
  choices: Array<{
    finish_reason: string;
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
      tool_results?: Array<Record<string, unknown>>;
      reasoning?: string;
    };
  }>;
}

/** Result captured from a fake app-server dynamic-tool response. */
interface CapturedResult {
  id: number;
  text: string;
}

/** Scriptable fake app-server that exercises fragmented frames and parallel tools. */
class ToolAppServer {
  readonly transport: JsonRpcTransport;
  readonly results: CapturedResult[] = [];
  readonly methods: string[] = [];
  readonly #fromServer = new PassThrough();
  readonly #toServer = new PassThrough();
  #thread = "thr_dynamic_tools";
  #turn = 0;
  #toolRequestIds = new Set([901, 902]);

  constructor(
    private readonly toolsOnFirstTurn = true,
    private readonly failResume = false,
    private readonly resumedThreadId = "thr_dynamic_tools",
  ) {
    this.transport = new JsonRpcTransport(this.#fromServer, this.#toServer);
    createInterface({ input: this.#toServer }).on("line", (line) =>
      this.#receive(JSON.parse(line) as Record<string, unknown>),
    );
  }

  /** Writes every JSON-RPC frame in three pieces to exercise framing. */
  #send(value: unknown): void {
    const frame = `${JSON.stringify(value)}\n`;
    const one = Math.max(1, Math.floor(frame.length / 3));
    this.#fromServer.write(frame.slice(0, one));
    this.#fromServer.write(frame.slice(one, one * 2));
    this.#fromServer.write(frame.slice(one * 2));
  }

  /** Handles proxy requests and dynamic-tool responses. */
  #receive(message: Record<string, unknown>): void {
    if (typeof message.method === "string") {
      this.methods.push(message.method);
      const id = message.id as number;
      if (message.method === "thread/start")
        this.#send({ id, result: { thread: { id: this.#thread } } });
      else if (message.method === "thread/read")
        this.#send({
          id,
          result: { thread: { id: this.#thread, status: { type: "idle" } } },
        });
      else if (message.method === "thread/resume")
        this.#send(
          this.failResume
            ? { id, error: { code: -32000, message: "thread changed" } }
            : { id, result: { thread: { id: this.resumedThreadId } } },
        );
      else if (message.method === "turn/start") {
        this.#turn += 1;
        const turnId = `turn_${this.#turn}`;
        this.#send({ id, result: { turn: { id: turnId } } });
        if (this.toolsOnFirstTurn && this.#turn === 1) {
          this.#send(
            protocolNotification({
              method: "item/agentMessage/delta",
              params: {
                threadId: this.#thread,
                turnId,
                itemId: "pre_tool_text",
                delta: "before tools",
              },
            }),
          );
          // Deliberately issue call_b first; the proxy must preserve arrival order.
          this.#send({
            id: 902,
            method: "item/tool/call",
            params: {
              threadId: this.#thread,
              turnId,
              callId: "call_b",
              tool: "second",
              namespace: null,
              arguments: { fragment: "b" },
            },
          });
          this.#send({
            id: 901,
            method: "item/tool/call",
            params: {
              threadId: this.#thread,
              turnId,
              callId: "call_a",
              tool: "first",
              namespace: null,
              arguments: { fragment: "a" },
            },
          });
        } else this.#complete(turnId, "continued");
      }
      return;
    }
    const id = message.id as number;
    if (!this.#toolRequestIds.has(id)) return;
    const result = message.result as { contentItems: Array<{ text: string }> };
    this.results.push({ id, text: result.contentItems[0]!.text });
    this.#toolRequestIds.delete(id);
    if (this.#toolRequestIds.size === 0) {
      this.#send(
        protocolNotification({
          method: "item/started",
          params: {
            threadId: this.#thread,
            turnId: "turn_1",
            startedAtMs: 0,
            item: {
              type: "webSearch",
              id: "internal_after_results",
              query: "forecast",
              action: { type: "search", query: "forecast", queries: null },
            },
          },
        }),
      );
      this.#complete("turn_1", "after tools");
    }
  }

  /** Emits a typed assistant delta and successful turn completion. */
  #complete(turnId: string, text: string): void {
    this.#send(
      protocolNotification({
        method: "item/agentMessage/delta",
        params: {
          threadId: this.#thread,
          turnId,
          itemId: `item_${turnId}`,
          delta: text,
        },
      }),
    );
    this.#send(
      protocolNotification({
        method: "turn/completed",
        params: {
          threadId: this.#thread,
          turn: protocolTurn(turnId, "completed"),
        },
      }),
    );
  }
}

/** Starts an ephemeral ready proxy with a caller-owned state directory. */
async function startProxy(
  stateDir: string,
  fake: ToolAppServer,
  toolTimeoutMs = 5_000,
): Promise<{ origin: string; proxy: ProxyServer }> {
  const proxy = createProxyServer(
    await resolveServeOptions(
      parseServeOptions([
        "--port",
        "0",
        "--state-dir",
        stateDir,
        "--tool-timeout",
        `${toolTimeoutMs}ms`,
      ]),
    ),
    silentLogger,
  );
  proxy.setTransport(fake.transport, UNRESTRICTED_POLICY_REQUIREMENTS);
  proxy.setReady(true);
  const address = await proxy.listen();
  const host = address.address.includes(":")
    ? `[${address.address}]`
    : address.address;
  return { origin: `http://${host}:${address.port}`, proxy };
}

/** Posts one JSON Chat Completions request. */
function post(
  origin: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Returns the stable OpenAI error code from a response. */
async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

/** Builds the exact assistant/tool transcript required for a pending batch. */
function toolTranscript(
  calls: CompletionBody["choices"][number]["message"]["tool_calls"],
  result = "ok",
): Array<Record<string, unknown>> {
  return [
    {
      role: "assistant",
      content: null,
      tool_calls: calls?.map((call) => ({
        id: call.id,
        type: "function",
        function: call.function,
      })),
    },
    ...(calls ?? [])
      .slice()
      .reverse()
      .map((call, index) => ({
        role: "tool",
        tool_call_id: call.id,
        content: index === 0 ? "x".repeat(256 * 1024) : result,
      })),
  ];
}

test("parallel fragmented tool calls accept out-of-order large results and answer responders deterministically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-dynamic-tools-"));
  const fake = new ToolAppServer();
  const { origin, proxy } = await startProxy(directory, fake);
  try {
    const firstResponse = await post(origin, {
      model: "m",
      tools: [
        { type: "function", function: { name: "first", parameters: {} } },
        { type: "function", function: { name: "second", parameters: {} } },
      ],
      messages: [{ role: "user", content: "use tools" }],
    });
    assert.equal(firstResponse.status, 200);
    const first = (await firstResponse.json()) as CompletionBody;
    assert.equal(first.choices[0]!.message.content, "before tools");
    const calls = first.choices[0]!.message.tool_calls;
    assert.deepEqual(
      calls?.map((call) => call.id),
      ["call_b", "call_a"],
    );
    assert.deepEqual(
      calls?.map((call) => call.function.arguments),
      ['{"fragment":"b"}', '{"fragment":"a"}'],
    );
    assert.equal(first.choices[0]!.message.tool_results, undefined);

    const busy = await post(origin, {
      model: "m",
      tools: [
        { type: "function", function: { name: "first", parameters: {} } },
        { type: "function", function: { name: "second", parameters: {} } },
      ],
      previous_response_id: first.id,
      messages: [{ role: "user", content: "not results" }],
    });
    assert.equal(busy.status, 409);
    assert.equal(await errorCode(busy), "tool_results_required");

    const continuedResponse = await post(origin, {
      model: "m",
      tools: [
        { type: "function", function: { name: "first", parameters: {} } },
        { type: "function", function: { name: "second", parameters: {} } },
      ],
      previous_response_id: first.id,
      messages: toolTranscript(calls),
    });
    assert.equal(continuedResponse.status, 200);
    const continued = (await continuedResponse.json()) as CompletionBody;
    assert.equal(continued.choices[0]!.message.content, "after tools");
    assert.deepEqual(
      continued.choices[0]!.message.tool_results?.map((result) => result.id),
      ["call_b", "call_a"],
    );
    assert.deepEqual(
      continued.choices[0]!.message.tool_calls?.map((call) => call.id),
      ["call_b", "call_a", "internal_after_results"],
    );
    assert.deepEqual(
      fake.results.map((result) => result.id),
      [902, 901],
    );
    assert.equal(fake.results[0]!.text, "ok");
    assert.equal(fake.results[1]!.text.length, 256 * 1024);

    const resumedResponse = await post(origin, {
      model: "m",
      tools: [
        { type: "function", function: { name: "first", parameters: {} } },
        { type: "function", function: { name: "second", parameters: {} } },
      ],
      previous_response_id: continued.id,
      messages: [{ role: "user", content: "continue after observed results" }],
    });
    assert.equal(resumedResponse.status, 200);
    const resumed = (await resumedResponse.json()) as CompletionBody;
    assert.equal(resumed.choices[0]!.message.content, "continued");
    assert.equal(
      fake.methods.filter((method) => method === "thread/resume").length,
      1,
    );

    const replay = await post(origin, {
      model: "m",
      tools: [
        { type: "function", function: { name: "first", parameters: {} } },
        { type: "function", function: { name: "second", parameters: {} } },
      ],
      previous_response_id: first.id,
      messages: toolTranscript(calls),
    });
    assert.equal(replay.status, 409);
    assert.equal(await errorCode(replay), "superseded_previous_response_id");
  } finally {
    await proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing, foreign, and duplicate tool result IDs fail without consuming the suspension", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "codex-tool-results-invalid-"),
  );
  const fake = new ToolAppServer();
  const { origin, proxy } = await startProxy(directory, fake);
  try {
    const initial = (await (
      await post(origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        messages: [{ role: "user", content: "tools" }],
      })
    ).json()) as CompletionBody;
    const calls = initial.choices[0]!.message.tool_calls!;
    const assistant = {
      role: "assistant",
      content: null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function",
        function: call.function,
      })),
    };
    const cases = [
      [
        assistant,
        { role: "tool", tool_call_id: "call_a", content: "only one" },
      ],
      [
        assistant,
        { role: "tool", tool_call_id: "foreign", content: "x" },
        { role: "tool", tool_call_id: "call_b", content: "y" },
      ],
      [
        assistant,
        { role: "tool", tool_call_id: "call_a", content: "x" },
        { role: "tool", tool_call_id: "call_a", content: "again" },
        { role: "tool", tool_call_id: "call_b", content: "y" },
      ],
    ];
    for (const messages of cases) {
      const response = await post(origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        previous_response_id: initial.id,
        messages,
      });
      assert.equal(response.status, 400);
      assert.equal(await errorCode(response), "invalid_request");
    }
    const success = await post(origin, {
      model: "m",
      tools: [
        { type: "function", function: { name: "first", parameters: {} } },
        { type: "function", function: { name: "second", parameters: {} } },
      ],
      previous_response_id: initial.id,
      messages: toolTranscript(calls, "final"),
    });
    assert.equal(success.status, 200);
  } finally {
    await proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a pending tool tombstone returns an HTTP expiry after proxy restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-tool-restart-"));
  const firstFake = new ToolAppServer();
  const firstServer = await startProxy(directory, firstFake);
  let responseId = "";
  let calls: CompletionBody["choices"][number]["message"]["tool_calls"];
  try {
    const initial = (await (
      await post(firstServer.origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        messages: [{ role: "user", content: "tools" }],
      })
    ).json()) as CompletionBody;
    responseId = initial.id;
    calls = initial.choices[0]!.message.tool_calls;
  } finally {
    await firstServer.proxy.close();
  }
  const secondFake = new ToolAppServer(false);
  const secondServer = await startProxy(directory, secondFake);
  try {
    const expired = await post(secondServer.origin, {
      model: "m",
      tools: [
        { type: "function", function: { name: "first", parameters: {} } },
        { type: "function", function: { name: "second", parameters: {} } },
      ],
      previous_response_id: responseId,
      messages: toolTranscript(calls),
    });
    assert.equal(expired.status, 410);
    assert.equal(await errorCode(expired), "expired_tool_continuation");
    assert.equal(secondFake.methods.length, 0);
  } finally {
    await secondServer.proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("completed continuations survive restart, supersede old responses, and reject a resume race", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-continuation-ready-"));
  const firstServer = await startProxy(directory, new ToolAppServer(false));
  let firstId = "";
  try {
    const first = (await (
      await post(firstServer.origin, {
        model: "m",
        messages: [{ role: "user", content: "first" }],
      })
    ).json()) as CompletionBody;
    firstId = first.id;
    assert.equal(first.choices[0]!.message.content, "continued");
  } finally {
    await firstServer.proxy.close();
  }

  const resumedFake = new ToolAppServer(false);
  const resumedServer = await startProxy(directory, resumedFake);
  let secondId = "";
  try {
    const response = await post(resumedServer.origin, {
      model: "m",
      previous_response_id: firstId,
      messages: [{ role: "user", content: "second" }],
    });
    assert.equal(response.status, 200);
    const second = (await response.json()) as CompletionBody;
    secondId = second.id;
    assert.deepEqual(resumedFake.methods.slice(0, 3), [
      "thread/read",
      "thread/resume",
      "turn/start",
    ]);
    const superseded = await post(resumedServer.origin, {
      model: "m",
      previous_response_id: firstId,
      messages: [{ role: "user", content: "branch" }],
    });
    assert.equal(superseded.status, 409);
    assert.equal(
      await errorCode(superseded),
      "superseded_previous_response_id",
    );
  } finally {
    await resumedServer.proxy.close();
  }

  const raceFake = new ToolAppServer(false, true);
  const raceServer = await startProxy(directory, raceFake);
  try {
    const raced = await post(raceServer.origin, {
      model: "m",
      previous_response_id: secondId,
      messages: [{ role: "user", content: "race" }],
    });
    assert.equal(raced.status, 409);
    assert.equal(await errorCode(raced), "thread_not_resumable");
    assert.deepEqual(raceFake.methods, ["thread/read", "thread/resume"]);
  } finally {
    await raceServer.proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a mismatched resumed thread is rejected without starting a turn or leaking ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-resume-id-"));
  const firstServer = await startProxy(directory, new ToolAppServer(false));
  let responseId = "";
  try {
    const first = (await (
      await post(firstServer.origin, {
        model: "m",
        messages: [{ role: "user", content: "first" }],
      })
    ).json()) as CompletionBody;
    responseId = first.id;
  } finally {
    await firstServer.proxy.close();
  }

  const fake = new ToolAppServer(false, false, "thr_unexpected");
  const server = await startProxy(directory, fake);
  try {
    for (const content of ["resume", "retry"]) {
      const response = await post(server.origin, {
        model: "m",
        previous_response_id: responseId,
        messages: [{ role: "user", content }],
      });
      assert.equal(response.status, 409);
      assert.equal(await errorCode(response), "thread_not_resumable");
    }
    assert.deepEqual(fake.methods, [
      "thread/read",
      "thread/resume",
      "thread/read",
      "thread/resume",
    ]);
  } finally {
    await server.proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a suspension timeout expires the HTTP continuation without sending tool results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-tool-timeout-"));
  const fake = new ToolAppServer();
  const { origin, proxy } = await startProxy(directory, fake, 20);
  try {
    const initial = (await (
      await post(origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        messages: [{ role: "user", content: "tools" }],
      })
    ).json()) as CompletionBody;
    await new Promise((resolve) => setTimeout(resolve, 40));
    const expired = await post(origin, {
      model: "m",
      tools: [
        { type: "function", function: { name: "first", parameters: {} } },
        { type: "function", function: { name: "second", parameters: {} } },
      ],
      previous_response_id: initial.id,
      messages: toolTranscript(initial.choices[0]!.message.tool_calls),
    });
    assert.equal(expired.status, 410);
    assert.equal(await errorCode(expired), "expired_tool_continuation");
    assert.deepEqual(fake.results, []);
  } finally {
    await proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("implicit tool continuation must repeat the original x_codex policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-dynamic-tools-"));
  const fake = new ToolAppServer();
  const { origin, proxy } = await startProxy(directory, fake);
  const tools = [
    { type: "function", function: { name: "first", parameters: {} } },
    { type: "function", function: { name: "second", parameters: {} } },
  ];
  try {
    const first = (await (
      await post(origin, {
        model: "m",
        tools,
        x_codex: { sandbox: "workspace-write" },
        messages: [{ role: "user", content: "use tools" }],
      })
    ).json()) as CompletionBody;
    const calls = first.choices[0]!.message.tool_calls;

    // Implicit continuation (no previous_response_id) that drops x_codex resolves
    // to the default read-only policy, so its binding no longer matches the
    // suspension and the tool results are rejected without being delivered.
    const dropped = await post(origin, {
      model: "m",
      tools,
      messages: toolTranscript(calls),
    });
    assert.equal(dropped.status, 409);
    assert.equal(await errorCode(dropped), "continuation_policy_mismatch");
    assert.equal(fake.results.length, 0);

    // Repeating the original x_codex on the implicit continuation matches the
    // suspension and delivers the results.
    const repeated = await post(origin, {
      model: "m",
      tools,
      x_codex: { sandbox: "workspace-write" },
      messages: toolTranscript(calls),
    });
    assert.equal(repeated.status, 200);
    assert.deepEqual(
      fake.results.map((result) => result.id),
      [902, 901],
    );
  } finally {
    await proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
});
