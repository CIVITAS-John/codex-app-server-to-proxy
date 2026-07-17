import assert from "node:assert/strict";
import { test } from "vitest";
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
  postChatCompletion,
  responseErrorCode,
  startProxyWithTransport,
} from "../support/http.js";
import { withTempDir } from "../support/temp.js";
import {
  createFakeTransport,
  type FakeTransport,
} from "../support/transport.js";

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
  readonly transport: FakeTransport;
  readonly results: CapturedResult[] = [];
  readonly methods: string[] = [];
  #thread = "thr_dynamic_tools";
  #turn = 0;
  #toolRequestIds = new Set([901, 902]);

  constructor(
    private readonly toolsOnFirstTurn = true,
    private readonly failResume = false,
    private readonly resumedThreadId = "thr_dynamic_tools",
  ) {
    this.transport = createFakeTransport({
      fragmentCount: 3,
      onMessage: (message) => this.#receive(message),
    });
  }

  /** Sends one JSON-RPC value through the fragmented fake transport. */
  #send(value: unknown): void {
    this.transport.send(value);
  }

  /** Handles proxy requests and dynamic-tool responses. */
  #receive(message: Record<string, unknown>): void {
    if (typeof message.method === "string") {
      this.methods.push(message.method);
      const id = message.id as number;
      if (message.method === "thread/start")
        this.#send(
          protocolResponse(
            "thread/start",
            id,
            protocolThreadStartResponse(protocolThread(this.#thread)),
          ),
        );
      else if (message.method === "thread/read")
        this.#send(
          protocolResponse("thread/read", id, {
            thread: protocolThread(this.#thread),
          }),
        );
      else if (message.method === "thread/resume") {
        if (this.failResume) {
          // JSON-RPC failures intentionally have no generated success type.
          this.#send({
            id,
            error: { code: -32000, message: "thread changed" },
          });
        } else {
          this.#send(
            protocolResponse(
              "thread/resume",
              id,
              protocolThreadResumeResponse(
                protocolThread(this.resumedThreadId),
              ),
            ),
          );
        }
      } else if (message.method === "turn/start") {
        this.#turn += 1;
        const turnId = `turn_${this.#turn}`;
        this.#send(
          protocolResponse("turn/start", id, {
            turn: protocolTurn(turnId, "inProgress"),
          }),
        );
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
          this.#send(
            protocolServerRequest({
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
            }),
          );
          this.#send(
            protocolServerRequest({
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
            }),
          );
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

/** Starts an ephemeral ready proxy backed by the fake app-server transport. */
async function startProxy(
  stateDir: string,
  fake: ToolAppServer,
  toolTimeoutMs = 5_000,
) {
  const { origin, proxy } = await startProxyWithTransport(fake.transport.rpc, {
    root: process.cwd(),
    stateDir,
    toolTimeoutMs,
  });
  return { origin, proxy };
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
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer();
    const { origin, proxy } = await startProxy(directory, fake);
    try {
      const firstResponse = await postChatCompletion(origin, {
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

      const busy = await postChatCompletion(origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        previous_response_id: first.id,
        messages: [{ role: "user", content: "not results" }],
      });
      assert.equal(busy.status, 409);
      assert.equal(await responseErrorCode(busy), "tool_results_required");

      const continuedResponse = await postChatCompletion(origin, {
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

      const resumedResponse = await postChatCompletion(origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        previous_response_id: continued.id,
        messages: [
          { role: "user", content: "continue after observed results" },
        ],
      });
      assert.equal(resumedResponse.status, 200);
      const resumed = (await resumedResponse.json()) as CompletionBody;
      assert.equal(resumed.choices[0]!.message.content, "continued");
      assert.equal(
        fake.methods.filter((method) => method === "thread/resume").length,
        1,
      );

      const replay = await postChatCompletion(origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        previous_response_id: first.id,
        messages: toolTranscript(calls),
      });
      assert.equal(replay.status, 409);
      assert.equal(
        await responseErrorCode(replay),
        "superseded_previous_response_id",
      );
    } finally {
      await proxy.close();
    }
  }, "codex-dynamic-tools-");
});

test("missing, foreign, and duplicate tool result IDs fail without consuming the suspension", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer();
    const { origin, proxy } = await startProxy(directory, fake);
    try {
      const initial = (await (
        await postChatCompletion(origin, {
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
        const response = await postChatCompletion(origin, {
          model: "m",
          tools: [
            { type: "function", function: { name: "first", parameters: {} } },
            { type: "function", function: { name: "second", parameters: {} } },
          ],
          previous_response_id: initial.id,
          messages,
        });
        assert.equal(response.status, 400);
        assert.equal(await responseErrorCode(response), "invalid_request");
      }
      const success = await postChatCompletion(origin, {
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
    }
  }, "codex-tool-results-invalid-");
});

test("a pending tool tombstone returns an HTTP expiry after proxy restart", async () => {
  await withTempDir(async (directory) => {
    const firstFake = new ToolAppServer();
    const firstServer = await startProxy(directory, firstFake);
    let responseId = "";
    let calls: CompletionBody["choices"][number]["message"]["tool_calls"];
    try {
      const initial = (await (
        await postChatCompletion(firstServer.origin, {
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
      const expired = await postChatCompletion(secondServer.origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        previous_response_id: responseId,
        messages: toolTranscript(calls),
      });
      assert.equal(expired.status, 410);
      assert.equal(
        await responseErrorCode(expired),
        "expired_tool_continuation",
      );
      assert.equal(secondFake.methods.length, 0);
    } finally {
      await secondServer.proxy.close();
    }
  }, "codex-tool-restart-");
});

test("completed continuations survive restart, supersede old responses, and reject a resume race", async () => {
  await withTempDir(async (directory) => {
    const firstFake = new ToolAppServer(false);
    const firstServer = await startProxy(directory, firstFake);
    let firstId = "";
    try {
      const first = (await (
        await postChatCompletion(firstServer.origin, {
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
      const response = await postChatCompletion(resumedServer.origin, {
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
      const superseded = await postChatCompletion(resumedServer.origin, {
        model: "m",
        previous_response_id: firstId,
        messages: [{ role: "user", content: "branch" }],
      });
      assert.equal(superseded.status, 409);
      assert.equal(
        await responseErrorCode(superseded),
        "superseded_previous_response_id",
      );
    } finally {
      await resumedServer.proxy.close();
    }

    const raceFake = new ToolAppServer(false, true);
    const raceServer = await startProxy(directory, raceFake);
    try {
      const raced = await postChatCompletion(raceServer.origin, {
        model: "m",
        previous_response_id: secondId,
        messages: [{ role: "user", content: "race" }],
      });
      assert.equal(raced.status, 409);
      assert.equal(await responseErrorCode(raced), "thread_not_resumable");
      assert.deepEqual(raceFake.methods, ["thread/read", "thread/resume"]);
    } finally {
      await raceServer.proxy.close();
    }
  }, "codex-continuation-ready-");
});

test("a mismatched resumed thread is rejected without starting a turn or leaking ownership", async () => {
  await withTempDir(async (directory) => {
    const firstFake = new ToolAppServer(false);
    const firstServer = await startProxy(directory, firstFake);
    let responseId = "";
    try {
      const first = (await (
        await postChatCompletion(firstServer.origin, {
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
        const response = await postChatCompletion(server.origin, {
          model: "m",
          previous_response_id: responseId,
          messages: [{ role: "user", content }],
        });
        assert.equal(response.status, 409);
        assert.equal(await responseErrorCode(response), "thread_not_resumable");
      }
      assert.deepEqual(fake.methods, [
        "thread/read",
        "thread/resume",
        "thread/read",
        "thread/resume",
      ]);
    } finally {
      await server.proxy.close();
    }
  }, "codex-resume-id-");
});

test("a suspension timeout expires the HTTP continuation without sending tool results", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer();
    const { origin, proxy } = await startProxy(directory, fake, 20);
    try {
      const initial = (await (
        await postChatCompletion(origin, {
          model: "m",
          tools: [
            { type: "function", function: { name: "first", parameters: {} } },
            { type: "function", function: { name: "second", parameters: {} } },
          ],
          messages: [{ role: "user", content: "tools" }],
        })
      ).json()) as CompletionBody;
      await new Promise((resolve) => setTimeout(resolve, 40));
      const expired = await postChatCompletion(origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        previous_response_id: initial.id,
        messages: toolTranscript(initial.choices[0]!.message.tool_calls),
      });
      assert.equal(expired.status, 410);
      assert.equal(
        await responseErrorCode(expired),
        "expired_tool_continuation",
      );
      assert.deepEqual(fake.results, []);
    } finally {
      await proxy.close();
    }
  }, "codex-tool-timeout-");
});

test("implicit tool continuation must repeat the original x_codex policy", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer();
    const { origin, proxy } = await startProxy(directory, fake);
    const tools = [
      { type: "function", function: { name: "first", parameters: {} } },
      { type: "function", function: { name: "second", parameters: {} } },
    ];
    try {
      const first = (await (
        await postChatCompletion(origin, {
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
      const dropped = await postChatCompletion(origin, {
        model: "m",
        tools,
        messages: toolTranscript(calls),
      });
      assert.equal(dropped.status, 409);
      assert.equal(
        await responseErrorCode(dropped),
        "continuation_policy_mismatch",
      );
      assert.equal(fake.results.length, 0);

      // Repeating the original x_codex on the implicit continuation matches the
      // suspension and delivers the results.
      const repeated = await postChatCompletion(origin, {
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
    }
  }, "codex-dynamic-tools-");
});
