import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, vi } from "vitest";
import { ResponseStore } from "../../src/continuation/state.js";
import { createLogger, type Logger } from "../../src/core/logger.js";
import {
  protocolNotification,
  protocolResponse,
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
import {
  createFakeTransport,
  completeTurn,
  interruptTurn,
  sendTokenUsage,
  suspendWithTools,
  tokenUsageFixture,
  type FakeTransport,
  type ToolUsageWireOrder,
} from "../support/transport.js";

/** Standard usage object as the acceptance tests observe it. */
interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

/** Minimal parsed Chat Completions response used by the acceptance tests. */
interface CompletionBody {
  id: string;
  x_codex?: { threadReused?: boolean };
  usage?: CompletionUsage;
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

/** One JSON-RPC error rejection observed on an issued dynamic tool request. */
interface CapturedRejection {
  id: number;
  code: number;
}

/** Token-usage reporting scripted by one fake app-server run. */
interface ToolAppServerUsage {
  /** Wire position of the tool-call turn's usage, if it reports any. */
  suspendOrder?: ToolUsageWireOrder;
  /** Whether turns that run to completion report usage and an idle boundary. */
  onCompletion?: boolean;
  reasoningOutputTokens?: number;
}

/** Scripted failure injection for the interrupt and injection RPCs. */
interface ToolAppServerFailures {
  interruptError?: boolean;
  /** One-shot: only the first `thread/inject_items` fails; later ones succeed. */
  injectError?: boolean;
  duplicateToolCallId?: boolean;
  /** One-shot: only the first `thread/start` fails; later ones succeed. */
  failThreadStart?: boolean;
  /** Fails the turn/start whose 1-based turn number matches; 0 never fails. */
  failTurnStartOnTurn?: number;
}

/**
 * Counts every `thread/start` across all fake instances, like a real
 * app-server's globally unique thread ids. Restart tests share one
 * continuation store, so a repeated id would let one thread's success
 * supersede another thread's durable records.
 */
let startedThreadCount = 0;

/**
 * Scriptable fake app-server that exercises fragmented frames and parallel
 * tools. Every `thread/start` allocates a distinct thread id; thread reads and
 * resumes echo the requested id unless a test overrides the resumed identity.
 */
class ToolAppServer {
  readonly transport: FakeTransport;
  /** Rejections the proxy sent to the issued `item/tool/call` requests. */
  readonly rejections: CapturedRejection[] = [];
  /** Whether interrupt acknowledgment is followed by one cancelled late call. */
  sendLateToolCallAfterInterrupt = false;
  /** Whether the interrupted turn dispatches a stale call during continuation. */
  sendLateToolCallDuringContinuation = false;
  /** Whether a result continuation replays one call before requesting a new one. */
  replayAndRequestNewToolOnContinuation = false;
  /** Delay between callbacks from one parallel model response. */
  parallelToolGapMs = 0;
  /** Whether raw calls precede only the first serialized client callback. */
  serializeParallelCallbacksFromRawBatch = false;
  /** Whether a result turn replays raw history before one newly issued call. */
  replayRawHistoryWithNewCallAfterResults = false;
  /** Raw Responses items received via thread/inject_items, in wire order. */
  readonly injected: Array<Record<string, unknown>> = [];
  /** The `input` array of every turn/start, in call order. */
  readonly turnInputs: unknown[][] = [];
  readonly methods: string[] = [];
  #thread = "thr_dynamic_tools";
  #turn = 0;
  /** The tool-call turn currently awaiting its interrupt, if any. */
  #toolTurnId: string | undefined;
  /** Thread of the tool-call turn currently awaiting its interrupt. */
  #toolTurnThread: string | undefined;
  /** Interrupted turn whose delayed callback is emitted on the next turn. */
  #delayedToolTurnId: string | undefined;
  /** Thread of the delayed turn; its stale callback must cite it. */
  #delayedToolTurnThread: string | undefined;
  #toolRequestIds = new Set([901, 902]);
  #rawResponseBoundaries = false;
  // Counts the model requests app-server has already attributed to each
  // thread, so a later turn's cumulative `total` covers every earlier request
  // on that thread only — a fallback's fresh thread starts from zero.
  readonly #requestsByThread = new Map<string, number>();

  constructor(
    private readonly toolsOnFirstTurn = true,
    private readonly failResume = false,
    private readonly resumedThreadId: string | undefined = undefined,
    private readonly internalBeforeTools = false,
    private readonly usage: ToolAppServerUsage = {},
    private readonly failures: ToolAppServerFailures = {},
  ) {
    this.transport = createFakeTransport({
      fragmentCount: 3,
      onMessage: (message) => this.#receive(message),
    });
  }

  /** Returns the model requests app-server already attributed to one thread. */
  #attributedRequests(threadId: string): number {
    return this.#requestsByThread.get(threadId) ?? 0;
  }

  /** Records one attributed model request for its owning thread. */
  #attributeRequest(threadId: string): void {
    this.#requestsByThread.set(
      threadId,
      this.#attributedRequests(threadId) + 1,
    );
  }

  /**
   * Emits usage covering every model request the thread has already run. Tests
   * call it once the suspended response has been read, which is the only
   * deterministic way to place usage strictly after a response ends.
   */
  sendUsage(turnId = "turn_1"): void {
    sendTokenUsage(
      this.transport.send,
      this.#thread,
      turnId,
      tokenUsageFixture(
        this.usage.reasoningOutputTokens ?? 0,
        Math.max(this.#attributedRequests(this.#thread) - 1, 0),
      ),
    );
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
      if (message.method === "thread/start") {
        if (this.failures.failThreadStart) {
          // One-shot knob: the first start is rejected and later ones succeed.
          this.failures.failThreadStart = false;
          // JSON-RPC failures intentionally have no generated success type.
          this.#send({
            id,
            error: { code: -32000, message: "thread start rejected" },
          });
          return;
        }
        const params = message.params as Record<string, unknown>;
        this.#rawResponseBoundaries = params.experimentalRawEvents === true;
        if (!this.#rawResponseBoundaries)
          throw new Error("thread did not opt into raw response events");
        startedThreadCount += 1;
        this.#thread =
          startedThreadCount === 1
            ? "thr_dynamic_tools"
            : `thr_dynamic_tools_${startedThreadCount}`;
        this.#send(
          protocolResponse(
            "thread/start",
            id,
            protocolThreadStartResponse(protocolThread(this.#thread)),
          ),
        );
      } else if (message.method === "thread/read")
        this.#send(
          protocolResponse("thread/read", id, {
            thread: protocolThread(
              String((message.params as { threadId?: unknown }).threadId),
            ),
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
          // The constructor override exists for identity-mismatch tests; a
          // real app-server resumes the requested thread id.
          const threadId =
            this.resumedThreadId ??
            String((message.params as { threadId?: unknown }).threadId);
          this.#send(
            protocolResponse(
              "thread/resume",
              id,
              protocolThreadResumeResponse(protocolThread(threadId)),
            ),
          );
        }
      } else if (message.method === "thread/inject_items") {
        if (this.failures.injectError) {
          // One-shot knob: only the first injection fails, so a retry that
          // isolates on a fresh thread can inject its own history.
          this.failures.injectError = false;
          this.#send({
            id,
            error: { code: -32000, message: "injection rejected" },
          });
          return;
        }
        const params = message.params as {
          items?: Array<Record<string, unknown>>;
        };
        this.injected.push(...(params.items ?? []));
        this.#send(protocolResponse("thread/inject_items", id, {}));
      } else if (message.method === "turn/interrupt") {
        if (this.failures.interruptError) {
          this.#send({
            id,
            error: { code: -32000, message: "interrupt rejected" },
          });
          return;
        }
        this.#send(protocolResponse("turn/interrupt", id, {}));
        const turnId = this.#toolTurnId;
        const threadId = this.#toolTurnThread;
        if (!turnId || !threadId) return;
        this.#toolTurnId = undefined;
        this.#toolTurnThread = undefined;
        if (this.sendLateToolCallDuringContinuation) {
          this.#delayedToolTurnId = turnId;
          this.#delayedToolTurnThread = threadId;
        }
        if (this.sendLateToolCallAfterInterrupt) {
          this.#toolRequestIds.add(903);
          suspendWithTools(
            this.transport.send,
            threadId,
            turnId,
            [
              {
                id: 903,
                callId: "call_late",
                tool: "first",
                arguments: { fragment: "late" },
              },
            ],
            {
              completeRawResponse: this.#rawResponseBoundaries,
            },
          );
        }
        // Live app-server flushes the interrupted turn's usage within
        // milliseconds of the interrupt, before completion and idle.
        interruptTurn(this.transport.send, threadId, turnId, {
          reasoningOutputTokens: this.usage.reasoningOutputTokens ?? 0,
          priorRequests: this.#attributedRequests(threadId) - 1,
          includeUsage: (this.usage.suspendOrder ?? "never") === "on_interrupt",
        });
      } else if (message.method === "turn/start") {
        this.#turn += 1;
        if (this.failures.failTurnStartOnTurn === this.#turn) {
          // JSON-RPC failures intentionally have no generated success type.
          this.#send({
            id,
            error: { code: -32000, message: "turn start rejected" },
          });
          return;
        }
        const turnId = `turn_${this.#turn}`;
        const turnParams = (message.params ?? {}) as {
          threadId?: unknown;
          input?: unknown[];
        };
        // Every emission of this turn cites the thread that started it, so a
        // fallback turn on a fresh thread cannot cite the superseded source.
        const threadId = String(turnParams.threadId);
        const input = turnParams.input ?? [];
        this.turnInputs.push(input);
        this.#send(
          protocolResponse("turn/start", id, {
            turn: protocolTurn(turnId, "inProgress"),
          }),
        );
        const delayedToolTurnId = this.#delayedToolTurnId;
        const delayedToolTurnThread = this.#delayedToolTurnThread;
        if (delayedToolTurnId && delayedToolTurnThread) {
          this.#delayedToolTurnId = undefined;
          this.#delayedToolTurnThread = undefined;
          this.#toolRequestIds.add(905);
          suspendWithTools(
            this.transport.send,
            delayedToolTurnThread,
            delayedToolTurnId,
            [
              {
                id: 905,
                callId: "call_delayed",
                tool: "first",
                arguments: { fragment: "delayed" },
              },
            ],
            { completeRawResponse: this.#rawResponseBoundaries },
          );
        }
        if (this.toolsOnFirstTurn && this.#turn === 1) {
          if (this.internalBeforeTools)
            this.#send(
              protocolNotification({
                method: "item/started",
                params: {
                  threadId,
                  turnId,
                  startedAtMs: 0,
                  item: {
                    type: "webSearch",
                    id: "internal_before_tools",
                    query: "weather",
                    action: {
                      type: "search",
                      query: "weather",
                      queries: null,
                    },
                    results: null,
                  },
                },
              }),
            );
          this.#send(
            protocolNotification({
              method: "item/agentMessage/delta",
              params: {
                threadId,
                turnId,
                itemId: "pre_tool_text",
                delta: "before tools",
              },
            }),
          );
          // Deliberately issue call_b first; the proxy must preserve arrival order.
          const suspendOrder = this.usage.suspendOrder ?? "never";
          const parallelCalls = [
            {
              id: 902,
              callId: "call_b",
              tool: "second",
              arguments: { fragment: "b" },
            },
            {
              id: 901,
              callId: this.failures.duplicateToolCallId ? "call_b" : "call_a",
              tool: "first",
              arguments: { fragment: "a" },
            },
          ];
          const usageOptions = {
            usageOrder: suspendOrder,
            reasoningOutputTokens: this.usage.reasoningOutputTokens ?? 0,
            priorRequests: this.#attributedRequests(threadId),
          };
          this.#toolTurnId = turnId;
          this.#toolTurnThread = threadId;
          if (this.serializeParallelCallbacksFromRawBatch) {
            for (const call of parallelCalls)
              this.#send(
                protocolNotification({
                  method: "rawResponseItem/completed",
                  params: {
                    threadId,
                    turnId,
                    item: {
                      type: "function_call",
                      call_id: call.callId,
                      name: call.tool,
                      arguments: JSON.stringify(call.arguments),
                    },
                  },
                }),
              );
            suspendWithTools(
              this.transport.send,
              threadId,
              turnId,
              [parallelCalls[0]!],
              {
                ...usageOptions,
                completeRawResponse: this.#rawResponseBoundaries,
              },
            );
          } else if (this.parallelToolGapMs > 0) {
            suspendWithTools(
              this.transport.send,
              threadId,
              turnId,
              [parallelCalls[0]!],
              { ...usageOptions, completeRawResponse: false },
            );
            setTimeout(
              () =>
                suspendWithTools(
                  this.transport.send,
                  threadId,
                  turnId,
                  [parallelCalls[1]!],
                  {
                    completeRawResponse: this.#rawResponseBoundaries,
                  },
                ),
              this.parallelToolGapMs,
            );
          } else
            suspendWithTools(
              this.transport.send,
              threadId,
              turnId,
              parallelCalls,
              {
                ...usageOptions,
                completeRawResponse: this.#rawResponseBoundaries,
              },
            );
          // The model request behind these calls ran whether or not app-server
          // attributed it, so every later cumulative total must include it.
          this.#attributeRequest(threadId);
        } else if (input.length === 0) {
          // A tool-result continuation starts its turn with no user input; the
          // injected function_call_output pairs are the model-visible input.
          if (this.replayRawHistoryWithNewCallAfterResults) {
            this.replayRawHistoryWithNewCallAfterResults = false;
            const rawCalls = [
              {
                callId: "call_b",
                tool: "second",
                arguments: { fragment: "b" },
              },
              {
                callId: "call_a",
                tool: "first",
                arguments: { fragment: "a" },
              },
              {
                callId: "call_new",
                tool: "first",
                arguments: { fragment: "new" },
              },
            ];
            for (const call of rawCalls)
              this.#send(
                protocolNotification({
                  method: "rawResponseItem/completed",
                  params: {
                    threadId,
                    turnId,
                    item: {
                      type: "function_call",
                      call_id: call.callId,
                      name: call.tool,
                      arguments: JSON.stringify(call.arguments),
                    },
                  },
                }),
              );
            this.#toolRequestIds.add(904);
            suspendWithTools(
              this.transport.send,
              threadId,
              turnId,
              [
                {
                  id: 904,
                  callId: "call_new",
                  tool: "first",
                  arguments: { fragment: "new" },
                },
              ],
              { completeRawResponse: this.#rawResponseBoundaries },
            );
            this.#toolTurnId = turnId;
            this.#toolTurnThread = threadId;
            return;
          }
          if (this.replayAndRequestNewToolOnContinuation) {
            this.#emitReplayedDynamicToolLifecycle(threadId, turnId);
            // The next tool-result continuation must finish so transcript
            // correlation tests prove the third request does not loop.
            this.replayAndRequestNewToolOnContinuation = false;
            this.#toolRequestIds.add(904);
            suspendWithTools(
              this.transport.send,
              threadId,
              turnId,
              [
                {
                  id: 904,
                  callId: "call_new",
                  tool: "first",
                  arguments: { fragment: "new" },
                },
              ],
              {
                completeRawResponse: this.#rawResponseBoundaries,
              },
            );
            this.#toolTurnId = turnId;
            this.#toolTurnThread = threadId;
            return;
          }
          this.#send(
            protocolNotification({
              method: "item/started",
              params: {
                threadId,
                turnId,
                startedAtMs: 0,
                item: {
                  type: "webSearch",
                  id: "internal_after_results",
                  query: "forecast",
                  action: { type: "search", query: "forecast", queries: null },
                  results: null,
                },
              },
            }),
          );
          this.#complete(threadId, turnId, "after tools");
        } else this.#complete(threadId, turnId, "continued");
      }
      return;
    }
    // Response frames from the proxy: the only ones a maintained run produces
    // are the post-interrupt rejections of the issued tool requests.
    const id = message.id as number;
    if (!this.#toolRequestIds.has(id)) return;
    const error = message.error as { code: number } | undefined;
    if (!error) return;
    this.rejections.push({ id, code: error.code });
    this.#toolRequestIds.delete(id);
  }

  /** Replays the client-owned output app-server reports on a continuation. */
  #emitReplayedDynamicToolLifecycle(threadId: string, turnId: string): void {
    const item = {
      type: "dynamicToolCall" as const,
      id: "call_b",
      namespace: null,
      tool: "second",
      arguments: { fragment: "b" },
      success: true,
    };
    this.#send(
      protocolNotification({
        method: "item/started",
        params: {
          threadId,
          turnId,
          startedAtMs: 0,
          item: {
            ...item,
            status: "inProgress",
            contentItems: null,
            durationMs: null,
          },
        },
      }),
    );
    this.#send(
      protocolNotification({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          completedAtMs: 1,
          item: {
            ...item,
            status: "completed",
            contentItems: [
              {
                type: "inputText",
                text: '{"_oracle":true,"message":"Tool set-research not executed in replay mode."}',
              },
            ],
            durationMs: 1,
          },
        },
      }),
    );
  }

  /** Emits a typed assistant delta and successful turn completion. */
  #complete(threadId: string, turnId: string, text: string): void {
    this.#send(
      protocolNotification({
        method: "item/agentMessage/delta",
        params: {
          threadId,
          turnId,
          itemId: `item_${turnId}`,
          delta: text,
        },
      }),
    );
    if (this.usage.onCompletion) {
      // A completed turn reaches its idle boundary, so the shared builder emits
      // usage, completion, and the lifecycle transition in wire order.
      completeTurn(this.transport.send, threadId, turnId, {
        reasoningOutputTokens: this.usage.reasoningOutputTokens ?? 0,
        priorRequests: this.#attributedRequests(threadId),
      });
      this.#attributeRequest(threadId);
      return;
    }
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
        params: {
          threadId,
          status: { type: "idle" },
        },
      }),
    );
  }
}

/** Starts an ephemeral ready proxy backed by the fake app-server transport. */
async function startProxy(stateDir: string, fake: ToolAppServer, log?: Logger) {
  const { origin, proxy } = await startProxyWithTransport(fake.transport.rpc, {
    root: process.cwd(),
    stateDir,
    log,
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

test("parallel fragmented tool calls interrupt the turn and continue by injecting result pairs", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer();
    // Separate the callbacks beyond the retired quiet-period heuristic. The
    // raw completion still keeps both in one upstream response batch.
    fake.parallelToolGapMs = 75;
    fake.sendLateToolCallAfterInterrupt = true;
    fake.sendLateToolCallDuringContinuation = true;
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
      assert.equal(first.choices[0]!.finish_reason, "tool_calls");
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
      assert.equal(continued.choices[0]!.finish_reason, "stop");
      // Client-owned outputs are injected into the Codex thread only. They
      // must not be re-announced as observational provider tool results.
      assert.equal(continued.choices[0]!.message.tool_results, undefined);
      assert.deepEqual(
        continued.choices[0]!.message.tool_calls?.map((call) => call.id),
        ["internal_after_results"],
      );
      // The turn was interrupted at the batch, which cancels both its captured
      // requests and both fake late callbacks app-server side, including one
      // dispatched during the continuation; the proxy answers none of them.
      assert.equal(
        fake.methods.filter((method) => method === "turn/interrupt").length,
        1,
      );
      assert.deepEqual(fake.rejections, []);
      // Results reach the model as complete call/output pairs in batch order.
      assert.deepEqual(
        fake.injected.map((item) => [item.type, item.call_id]),
        [
          ["function_call", "call_b"],
          ["function_call_output", "call_b"],
          ["function_call", "call_a"],
          ["function_call_output", "call_a"],
        ],
      );
      assert.equal(fake.injected[0]!.arguments, '{"fragment":"b"}');
      assert.equal(fake.injected[1]!.output, "ok");
      assert.equal((fake.injected[3]!.output as string).length, 256 * 1024);
      // The continuation turn started with no user input: the injected pairs
      // are the model-visible input.
      assert.deepEqual(fake.turnInputs.at(-1), []);

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
      // Both the tool-result continuation and the later ready continuation
      // resume the idle thread.
      assert.equal(
        fake.methods.filter((method) => method === "thread/resume").length,
        2,
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
      assert.equal(replay.status, 200);
      const replayed = (await replay.json()) as CompletionBody;
      // The consumed selector is superseded, so its complete transcript
      // executes on one fresh thread instead of being rejected. The source
      // mapping is never mutated and no fork is ever attempted.
      assert.equal(replayed.x_codex?.threadReused, false);
      assert.equal(
        fake.methods.filter((method) => method === "thread/start").length,
        2,
      );
      assert.equal(fake.methods.includes("thread/fork"), false);
      // The never-mutated claim is durable state, not just RPC shape: the
      // source record stays superseded by the successful native continuation
      // instead of being rewritten again by this fallback.
      assert.equal(
        persistedRecords(directory).find(
          (record) => record.responseId === first.id,
        )?.state,
        "superseded",
      );
      assert.deepEqual(
        fake.injected.slice(4).map((item) => [item.type, item.call_id]),
        [
          ["function_call", "call_b"],
          ["function_call_output", "call_b"],
          ["function_call", "call_a"],
          ["function_call_output", "call_a"],
        ],
      );
      // The fallback turn also starts with no user input: the injected pairs
      // are the model-visible input.
      assert.deepEqual(fake.turnInputs.at(-1), []);
    } finally {
      await proxy.close();
    }
  }, "codex-dynamic-tools-");
});

test("raw direct calls preserve a parallel batch when callbacks are serialized", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer();
    fake.serializeParallelCallbacksFromRawBatch = true;
    fake.replayRawHistoryWithNewCallAfterResults = true;
    const { origin, proxy } = await startProxy(directory, fake);
    try {
      const response = await postChatCompletion(origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        messages: [{ role: "user", content: "use both tools" }],
      });
      assert.equal(response.status, 200);
      const completion = (await response.json()) as CompletionBody;
      assert.equal(completion.choices[0]!.finish_reason, "tool_calls");
      assert.deepEqual(
        completion.choices[0]!.message.tool_calls?.map((call) => [
          call.id,
          call.function.name,
          call.function.arguments,
        ]),
        [
          ["call_b", "second", '{"fragment":"b"}'],
          ["call_a", "first", '{"fragment":"a"}'],
        ],
      );
      assert.equal(
        fake.methods.filter((method) => method === "turn/interrupt").length,
        1,
      );

      const continuedResponse = await postChatCompletion(origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        previous_response_id: completion.id,
        messages: toolTranscript(completion.choices[0]!.message.tool_calls),
      });
      assert.equal(continuedResponse.status, 200);
      const continued = (await continuedResponse.json()) as CompletionBody;
      assert.deepEqual(
        continued.choices[0]!.message.tool_calls?.map((call) => [
          call.id,
          call.function.name,
          call.function.arguments,
        ]),
        [["call_new", "first", '{"fragment":"new"}']],
      );
    } finally {
      await proxy.close();
    }
  }, "codex-tool-raw-parallel-test-");
});

test("streaming continuations hide replayed client calls but expose new calls", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer();
    fake.replayAndRequestNewToolOnContinuation = true;
    const { origin, proxy } = await startProxy(directory, fake);
    const tools = [
      { type: "function", function: { name: "first", parameters: {} } },
      { type: "function", function: { name: "second", parameters: {} } },
    ];
    const oracleOutput =
      '{"_oracle":true,"message":"Tool set-research not executed in replay mode."}';
    try {
      const initialResponse = await postChatCompletion(origin, {
        model: "m",
        tools,
        messages: [{ role: "user", content: "use tools" }],
      });
      const initial = (await initialResponse.json()) as CompletionBody;
      const calls = initial.choices[0]!.message.tool_calls;

      const continuedResponse = await postChatCompletion(origin, {
        model: "m",
        stream: true,
        tools,
        previous_response_id: initial.id,
        messages: toolTranscript(calls, oracleOutput),
      });
      assert.equal(continuedResponse.status, 200);
      const chunks = parseSseChunks(await continuedResponse.text());
      const choices = chunks.flatMap(
        (chunk) =>
          (chunk.choices as
            | Array<{
                delta: Record<string, unknown>;
                finish_reason: string | null;
              }>
            | undefined) ?? [],
      );
      const toolCalls = choices.flatMap(
        (choice) =>
          (choice.delta.tool_calls as Array<{ id: string }> | undefined) ?? [],
      );
      assert.deepEqual(
        toolCalls.map((call) => call.id),
        ["call_new"],
      );
      assert.equal(
        choices.some((choice) => choice.delta.tool_results !== undefined),
        false,
      );
      assert.equal(choices.at(-1)?.finish_reason, "tool_calls");
      assert.doesNotMatch(
        JSON.stringify(chunks),
        /Tool set-research not executed in replay mode/,
      );
    } finally {
      await proxy.close();
    }
  }, "codex-dynamic-tools-replay-sse-");
});

test("third full-history tool continuation correlates only its terminal result batch", async () => {
  for (const explicitPreviousResponseId of [false, true]) {
    await withTempDir(async (directory) => {
      // This correlation case is unrelated to missing usage. Match the live
      // terminal flush so six requests do not each pay the fallback grace.
      const fake = new ToolAppServer(true, false, undefined, false, {
        suspendOrder: "on_interrupt",
        onCompletion: true,
      });
      fake.replayAndRequestNewToolOnContinuation = true;
      const { origin, proxy } = await startProxy(directory, fake);
      const tools = [
        { type: "function", function: { name: "first", parameters: {} } },
        { type: "function", function: { name: "second", parameters: {} } },
      ];
      try {
        const initial = (await (
          await postChatCompletion(origin, {
            model: "m",
            tools,
            messages: [{ role: "user", content: "use tools" }],
          })
        ).json()) as CompletionBody;
        const initialCalls = initial.choices[0]!.message.tool_calls;
        const second = (await (
          await postChatCompletion(origin, {
            model: "m",
            tools,
            previous_response_id: initial.id,
            messages: toolTranscript(initialCalls, "first result"),
          })
        ).json()) as CompletionBody;
        const secondCalls = second.choices[0]!.message.tool_calls;
        assert.deepEqual(
          secondCalls?.map((call) => call.id),
          ["call_new"],
        );

        const thirdResponse = await postChatCompletion(origin, {
          model: "m",
          tools,
          ...(explicitPreviousResponseId
            ? { previous_response_id: second.id }
            : {}),
          messages: [
            ...toolTranscript(initialCalls, "first result"),
            ...toolTranscript(secondCalls, "second result"),
          ],
        });
        assert.equal(
          thirdResponse.status,
          200,
          await thirdResponse.clone().text(),
        );
        const third = (await thirdResponse.json()) as CompletionBody;
        assert.equal(third.choices[0]!.message.content, "after tools");
        assert.equal(third.choices[0]!.finish_reason, "stop");
        // The historical A result remains replay context. Only B's terminal
        // result is paired and injected on the third continuation.
        assert.deepEqual(
          fake.injected.slice(4).map((item) => [item.type, item.call_id]),
          [
            ["function_call", "call_new"],
            ["function_call_output", "call_new"],
          ],
        );
      } finally {
        await proxy.close();
      }
    }, "codex-terminal-tool-results-");
  }
});

/** Replays one transcript into a fresh thread and reports what it received. */
async function replayFreshThread(
  messages: Array<Record<string, unknown>>,
): Promise<{
  injected: Array<Record<string, unknown>>;
  turnInputs: unknown[][];
}> {
  return await withTempDir(async (directory) => {
    const fake = new ToolAppServer(false);
    const { origin, proxy } = await startProxy(directory, fake);
    try {
      const response = await postChatCompletion(origin, {
        model: "m",
        messages,
      });
      assert.equal(response.status, 200);
      return { injected: fake.injected, turnInputs: fake.turnInputs };
    } finally {
      await proxy.close();
    }
  }, "codex-history-replay-");
}

test("a completed historical tool round replays into fresh-thread history", async () => {
  const replay = await replayFreshThread([
    { role: "user", content: "use tools" },
    {
      role: "assistant",
      content: "calling out",
      tool_calls: [
        {
          id: "call_old",
          type: "function",
          function: { name: "first", arguments: '{"a":1}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_old", content: "old result" },
    { role: "user", content: "continue" },
  ]);
  // The earlier round is history, not a continuation: it is injected as the
  // complete pair app-server needs, and the trailing user message is input.
  assert.deepEqual(replay.injected, [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "use tools" }],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "calling out" }],
    },
    {
      type: "function_call",
      name: "first",
      arguments: '{"a":1}',
      call_id: "call_old",
    },
    {
      type: "function_call_output",
      call_id: "call_old",
      output: "old result",
    },
  ]);
  assert.deepEqual(replay.turnInputs, [
    [{ type: "text", text: "continue", text_elements: [] }],
  ]);
});

test("historical parallel tool replay preserves assistant call order", async () => {
  const replay = await replayFreshThread([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_b",
          type: "function",
          function: { name: "second", arguments: '{"order":"b"}' },
        },
        {
          id: "call_a",
          type: "function",
          function: { name: "first", arguments: '{"order":"a"}' },
        },
      ],
    },
    // Client results may arrive out of order, but replayed calls retain
    // the authoritative order of the assistant's tool-call batch.
    { role: "tool", tool_call_id: "call_a", content: "result a" },
    { role: "tool", tool_call_id: "call_b", content: "result b" },
    { role: "user", content: "continue" },
  ]);
  assert.deepEqual(replay.injected, [
    {
      type: "function_call",
      name: "second",
      arguments: '{"order":"b"}',
      call_id: "call_b",
    },
    {
      type: "function_call_output",
      call_id: "call_b",
      output: "result b",
    },
    {
      type: "function_call",
      name: "first",
      arguments: '{"order":"a"}',
      call_id: "call_a",
    },
    {
      type: "function_call_output",
      call_id: "call_a",
      output: "result a",
    },
  ]);
});

test("a later historical batch cannot answer an earlier incomplete batch", async () => {
  const replay = await replayFreshThread([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_reused",
          type: "function",
          function: { name: "first", arguments: '{"round":1}' },
        },
      ],
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_reused",
          type: "function",
          function: { name: "second", arguments: '{"round":2}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_reused", content: "round two" },
    { role: "user", content: "continue" },
  ]);
  // The result belongs only to its immediately preceding assistant batch;
  // the incomplete earlier declaration is dropped instead of fabricated.
  assert.deepEqual(replay.injected, [
    {
      type: "function_call",
      name: "second",
      arguments: '{"round":2}',
      call_id: "call_reused",
    },
    {
      type: "function_call_output",
      call_id: "call_reused",
      output: "round two",
    },
  ]);
});

test("unpairable historical tool items stay out of fresh-thread history", async () => {
  const replay = await replayFreshThread([
    // An unanswered call would describe work the thread never finished,
    // and app-server ignores an output whose call it never received.
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_unanswered",
          type: "function",
          function: { name: "first", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_orphan", content: "orphan" },
    { role: "user", content: "continue" },
  ]);
  assert.deepEqual(replay.injected, []);
  assert.deepEqual(replay.turnInputs, [
    [{ type: "text", text: "continue", text_elements: [] }],
  ]);
});

test("replayed internal activity stays out of fresh-thread history", async () => {
  const replay = await replayFreshThread([
    {
      role: "assistant",
      content: "ran a command",
      tool_calls: [
        {
          id: "internal_command",
          type: "function",
          function: { name: "commandExecution", arguments: "{}" },
        },
      ],
      // Self-correlated results mark app-server-owned activity, which the
      // fresh thread must not replay under Codex's internal tool names.
      tool_results: [
        {
          id: "internal_command",
          type: "function",
          function: { name: "commandExecution", arguments: "{}" },
          result: { status: "completed" },
        },
      ],
    },
    { role: "user", content: "continue" },
  ]);
  assert.deepEqual(replay.injected, [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "ran a command" }],
    },
  ]);
});

test("verbatim mixed internal and dynamic calls resolve only the pending batch", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer(true, false, undefined, true);
    const { origin, proxy } = await startProxy(directory, fake);
    const tools = [
      { type: "function", function: { name: "first", parameters: {} } },
      { type: "function", function: { name: "second", parameters: {} } },
    ];
    try {
      const initialResponse = await postChatCompletion(origin, {
        model: "m",
        tools,
        messages: [{ role: "user", content: "use tools" }],
      });
      assert.equal(initialResponse.status, 200);
      const initial = (await initialResponse.json()) as CompletionBody;
      const calls = initial.choices[0]!.message.tool_calls!;
      assert.deepEqual(
        calls.map((call) => call.id),
        ["internal_before_tools", "call_b", "call_a"],
      );

      const continued = await postChatCompletion(origin, {
        model: "m",
        tools,
        previous_response_id: initial.id,
        messages: [
          {
            role: "assistant",
            content: initial.choices[0]!.message.content,
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: "function",
              function: call.function,
            })),
          },
          { role: "tool", tool_call_id: "call_b", content: "second result" },
          { role: "tool", tool_call_id: "call_a", content: "first result" },
        ],
      });
      assert.equal(continued.status, 200, await continued.clone().text());
      // Only the pending dynamic batch is injected; the observational internal
      // call in the replayed assistant message never reaches thread history.
      assert.deepEqual(
        fake.injected.map((item) => [item.type, item.call_id]),
        [
          ["function_call", "call_b"],
          ["function_call_output", "call_b"],
          ["function_call", "call_a"],
          ["function_call_output", "call_a"],
        ],
      );
    } finally {
      await proxy.close();
    }
  }, "codex-mixed-tool-replay-");
});

test("missing, foreign, and duplicate tool result IDs and changed tool call arguments fail without consuming the pending batch", async () => {
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
      // Repeating the pending call IDs and names is not enough: the persisted
      // arguments are byte-identical to what the tool-call response emitted,
      // so an altered batch is a different batch even with complete results.
      const tamperedAssistant = {
        role: "assistant",
        content: null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.function.name,
            arguments: '{"fragment":"tampered"}',
          },
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
        [
          tamperedAssistant,
          { role: "tool", tool_call_id: "call_a", content: "x" },
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

test("tool results followed by user messages continue natively with the final user as input", async () => {
  const suffixes = [
    ["only question"],
    ["earlier note", "final question"],
    ["first note", "second note", "final question"],
  ];
  for (const suffix of suffixes) {
    for (const stream of [false, true]) {
      await withTempDir(async (directory) => {
        // The suffix behavior is unrelated to usage accounting. Match the
        // live terminal flush so the loop's twelve requests do not each
        // pay the trailing idle grace.
        const fake = new ToolAppServer(true, false, undefined, false, {
          suspendOrder: "on_interrupt",
          onCompletion: true,
        });
        const { origin, proxy } = await startProxy(directory, fake);
        const tools = [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ];
        try {
          const firstResponse = await postChatCompletion(origin, {
            model: "m",
            tools,
            messages: [{ role: "user", content: "use tools" }],
          });
          assert.equal(firstResponse.status, 200);
          const first = (await firstResponse.json()) as CompletionBody;
          assert.equal(first.choices[0]!.finish_reason, "tool_calls");
          assert.deepEqual(
            first.choices[0]!.message.tool_calls?.map((call) => call.id),
            ["call_b", "call_a"],
          );
          const calls = first.choices[0]!.message.tool_calls;

          const continuedResponse = await postChatCompletion(origin, {
            model: "m",
            tools,
            previous_response_id: first.id,
            ...(stream ? { stream: true } : {}),
            messages: [
              ...toolTranscript(calls, "res"),
              ...suffix.map((content) => ({ role: "user", content })),
            ],
          });
          assert.equal(
            continuedResponse.status,
            200,
            await continuedResponse.clone().text(),
          );
          if (stream) {
            const chunks = parseSseChunks(await continuedResponse.text());
            // Reuse is reported exactly once, on the first chunk, the same
            // way a ready continuation reports it.
            assert.deepEqual(chunks[0]?.x_codex, {
              instructionSources: [],
              threadReused: true,
            });
            assert.equal(
              chunks.slice(1).some((chunk) => chunk.x_codex !== undefined),
              false,
            );
            const choices = chunks.flatMap(
              (chunk) =>
                (chunk.choices as
                  | Array<{
                      delta: Record<string, unknown>;
                      finish_reason: string | null;
                    }>
                  | undefined) ?? [],
            );
            assert.equal(
              choices.map((choice) => choice.delta.content ?? "").join(""),
              "continued",
            );
            // The replayed client calls and results are injected thread
            // history, never new delta activity.
            assert.equal(
              choices.some((choice) => choice.delta.tool_calls !== undefined),
              false,
            );
            assert.equal(
              choices.some((choice) => choice.delta.tool_results !== undefined),
              false,
            );
            assert.equal(choices.at(-1)?.finish_reason, "stop");
          } else {
            const continued =
              (await continuedResponse.json()) as CompletionBody;
            assert.equal(continued.x_codex?.threadReused, true);
            assert.equal(continued.choices[0]!.message.content, "continued");
            assert.equal(continued.choices[0]!.finish_reason, "stop");
            // The replayed batch is not re-announced as new activity.
            assert.equal(continued.choices[0]!.message.tool_calls, undefined);
            assert.equal(continued.choices[0]!.message.tool_results, undefined);
          }
          // The suspension's start/turn/interrupt, then exactly one native
          // read/resume/inject/start sequence and no second thread/start.
          assert.deepEqual(fake.methods, [
            "thread/start",
            "turn/start",
            "turn/interrupt",
            "thread/read",
            "thread/resume",
            "thread/inject_items",
            "turn/start",
          ]);
          // The pending pairs are injected first, in recorded call order.
          assert.deepEqual(
            fake.injected.slice(0, 4).map((item) => [item.type, item.call_id]),
            [
              ["function_call", "call_b"],
              ["function_call_output", "call_b"],
              ["function_call", "call_a"],
              ["function_call_output", "call_a"],
            ],
          );
          assert.equal(fake.injected[1]!.output, "res");
          assert.equal(fake.injected[3]!.output, "x".repeat(256 * 1024));
          // Every suffix user except the last is then injected, each keeping
          // its own message and order as a Responses user-history item.
          assert.deepEqual(
            fake.injected.slice(4),
            suffix.slice(0, -1).map((text) => ({
              type: "message",
              role: "user",
              content: [{ type: "input_text", text }],
            })),
          );
          // The final suffix user is the turn input, exactly once: the
          // suspension's own prompt is the only other recorded turn.
          assert.deepEqual(fake.turnInputs, [
            [{ type: "text", text: "use tools", text_elements: [] }],
            [{ type: "text", text: suffix.at(-1), text_elements: [] }],
          ]);
        } finally {
          await proxy.close();
        }
      }, "codex-tool-suffix-users-");
    }
  }
});

test("an explicit pending suffix continuation ignores an earlier completed round reusing a pending call ID", async () => {
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
          messages: [{ role: "user", content: "use tools" }],
        })
      ).json()) as CompletionBody;
      const calls = first.choices[0]!.message.tool_calls!;
      const response = await postChatCompletion(origin, {
        model: "m",
        tools,
        previous_response_id: first.id,
        messages: [
          { role: "user", content: "history prompt" },
          // The earlier completed round reuses the pending call_b ID with
          // older arguments, so only positional selection can pick the
          // final batch instead of this same-ID predecessor.
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_b",
                type: "function",
                function: { name: "second", arguments: '{"round":1}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_b", content: "old result" },
          ...toolTranscript(calls, "res"),
          { role: "user", content: "final" },
        ],
      });
      assert.equal(response.status, 200, await response.clone().text());
      const continued = (await response.json()) as CompletionBody;
      assert.equal(continued.x_codex?.threadReused, true);
      assert.equal(continued.choices[0]!.message.content, "continued");
      // Exactly one native continuation sequence follows the suspension.
      assert.deepEqual(fake.methods, [
        "thread/start",
        "turn/start",
        "turn/interrupt",
        "thread/read",
        "thread/resume",
        "thread/inject_items",
        "turn/start",
      ]);
      // Only the selected final batch is injected: the earlier round is
      // already native history, and an older batch reusing a pending call
      // ID is still never selected or injected.
      assert.deepEqual(fake.injected, [
        {
          type: "function_call",
          name: "second",
          arguments: '{"fragment":"b"}',
          call_id: "call_b",
        },
        { type: "function_call_output", call_id: "call_b", output: "res" },
        {
          type: "function_call",
          name: "first",
          arguments: '{"fragment":"a"}',
          call_id: "call_a",
        },
        {
          type: "function_call_output",
          call_id: "call_a",
          output: "x".repeat(256 * 1024),
        },
      ]);
      // The final user message is the turn input, not injected history.
      assert.deepEqual(fake.turnInputs.at(-1), [
        { type: "text", text: "final", text_elements: [] },
      ]);
    } finally {
      await proxy.close();
    }
  }, "codex-tool-suffix-history-");
});

test("invalid suffix continuations fail before any RPC and leave the pending batch consumable", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer();
    const { origin, proxy } = await startProxy(directory, fake);
    const tools = [
      { type: "function", function: { name: "first", parameters: {} } },
      { type: "function", function: { name: "second", parameters: {} } },
    ];
    try {
      const initial = (await (
        await postChatCompletion(origin, {
          model: "m",
          tools,
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
      // Repeating the pending call IDs and names is not enough: the persisted
      // arguments are byte-identical to what the tool-call response emitted,
      // so an altered batch is a different batch even with complete results.
      const tamperedAssistant = {
        role: "assistant",
        content: null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.function.name,
            arguments: '{"fragment":"tampered"}',
          },
        })),
      };
      // The persisted name must match exactly, like the arguments.
      const renamedAssistant = {
        role: "assistant",
        content: null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.id === "call_b" ? "third" : call.function.name,
            arguments: call.function.arguments,
          },
        })),
      };
      const cases = [
        // A partial result block cannot satisfy the parallel batch.
        [
          assistant,
          { role: "tool", tool_call_id: "call_b", content: "only" },
          { role: "user", content: "go" },
        ],
        // A result for a call the batch never issued is foreign.
        [
          assistant,
          { role: "tool", tool_call_id: "foreign", content: "x" },
          { role: "tool", tool_call_id: "call_b", content: "y" },
          { role: "user", content: "go" },
        ],
        // Two results for one call are ambiguous even with the others present.
        [
          assistant,
          { role: "tool", tool_call_id: "call_a", content: "x" },
          { role: "tool", tool_call_id: "call_a", content: "again" },
          { role: "tool", tool_call_id: "call_b", content: "y" },
          { role: "user", content: "go" },
        ],
        // Changed arguments invalidate the batch even with complete results.
        [
          tamperedAssistant,
          { role: "tool", tool_call_id: "call_a", content: "x" },
          { role: "tool", tool_call_id: "call_b", content: "y" },
          { role: "user", content: "go" },
        ],
        // A changed call name invalidates the batch like changed arguments.
        [
          renamedAssistant,
          { role: "tool", tool_call_id: "call_a", content: "x" },
          { role: "tool", tool_call_id: "call_b", content: "y" },
          { role: "user", content: "go" },
        ],
      ];
      // The suspension's own RPCs are the baseline: admission failures must
      // add nothing, not even a thread/read of the source.
      const afterSuspension = fake.methods.slice();
      for (const messages of cases) {
        const response = await postChatCompletion(origin, {
          model: "m",
          tools,
          previous_response_id: initial.id,
          messages,
        });
        assert.equal(response.status, 400);
        assert.equal(await responseErrorCode(response), "invalid_request");
        assert.deepEqual(fake.methods, afterSuspension);
      }
      // A user message splitting the result block leaves the final result
      // group without its assistant message, so the separated blocks cannot
      // be merged to satisfy the batch.
      const split = await postChatCompletion(origin, {
        model: "m",
        tools,
        previous_response_id: initial.id,
        messages: [
          assistant,
          { role: "tool", tool_call_id: "call_b", content: "x" },
          { role: "user", content: "split" },
          { role: "tool", tool_call_id: "call_a", content: "y" },
        ],
      });
      assert.equal(split.status, 400);
      const splitBody = (await split.json()) as {
        error: { code: string; message: string };
      };
      assert.equal(splitBody.error.code, "invalid_request");
      assert.equal(
        splitBody.error.message,
        "The assistant tool-call message is required.",
      );
      assert.deepEqual(fake.methods, afterSuspension);
      // No rejection consumed the source: its record is still pending and a
      // corrected request continues it natively.
      assert.equal(
        persistedRecords(directory).find(
          (record) => record.responseId === initial.id,
        )?.state,
        "pending_tool",
      );
      const success = await postChatCompletion(origin, {
        model: "m",
        tools,
        previous_response_id: initial.id,
        messages: [
          ...toolTranscript(calls, "final"),
          { role: "user", content: "fixed" },
        ],
      });
      assert.equal(success.status, 200, await success.clone().text());
      const continued = (await success.json()) as CompletionBody;
      assert.equal(continued.x_codex?.threadReused, true);
    } finally {
      await proxy.close();
    }
  }, "codex-tool-suffix-invalid-");
});

test("a pending tool continuation falls back to a fresh thread after proxy restart", async () => {
  for (const selection of ["explicit", "implicit"] as const) {
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
              {
                type: "function",
                function: { name: "second", parameters: {} },
              },
            ],
            messages: [{ role: "user", content: "tools" }],
          })
        ).json()) as CompletionBody;
        responseId = initial.id;
        calls = initial.choices[0]!.message.tool_calls;
      } finally {
        await firstServer.proxy.close();
      }
      // The restarted proxy cannot prove raw-response capability for a thread
      // of the previous transport, so a tool-bearing continuation executes the
      // full transcript on one fresh thread before any source RPC.
      const secondFake = new ToolAppServer(false);
      const secondServer = await startProxy(directory, secondFake);
      try {
        const continuedResponse = await postChatCompletion(
          secondServer.origin,
          {
            model: "m",
            tools: [
              {
                type: "function",
                function: { name: "first", parameters: {} },
              },
              {
                type: "function",
                function: { name: "second", parameters: {} },
              },
            ],
            // The explicit selector names the response; the implicit one is
            // resolved from the terminal tool results alone.
            ...(selection === "explicit"
              ? { previous_response_id: responseId }
              : {}),
            messages: toolTranscript(calls),
          },
        );
        assert.equal(continuedResponse.status, 200);
        const continued = (await continuedResponse.json()) as CompletionBody;
        assert.equal(continued.x_codex?.threadReused, false);
        assert.deepEqual(secondFake.methods, [
          "thread/start",
          "thread/inject_items",
          "turn/start",
        ]);
        assert.deepEqual(
          secondFake.injected.map((item) => [item.type, item.call_id]),
          [
            ["function_call", "call_b"],
            ["function_call_output", "call_b"],
            ["function_call", "call_a"],
            ["function_call_output", "call_a"],
          ],
        );
        assert.deepEqual(secondFake.turnInputs, [[]]);
        // The fallback never touches its source: the pending record survives
        // the restart for a later compatible request that can resume it.
        assert.equal(
          persistedRecords(directory).find(
            (record) => record.responseId === responseId,
          )?.state,
          "pending_tool",
        );
      } finally {
        await secondServer.proxy.close();
      }
    }, "codex-tool-restart-");
  }
});

test("a post-restart tool continuation falls back and still delivers a new tool batch", async () => {
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

    const resumedFake = new ToolAppServer(false);
    resumedFake.replayAndRequestNewToolOnContinuation = true;
    const resumedServer = await startProxy(directory, resumedFake);
    try {
      const response = await postChatCompletion(resumedServer.origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        previous_response_id: responseId,
        messages: toolTranscript(calls),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as CompletionBody;
      // Missing raw-response capability on the new transport selects a fresh
      // thread before any source RPC, and that thread's raw boundaries make
      // the newly requested batch deliverable.
      assert.equal(body.x_codex?.threadReused, false);
      assert.equal(body.choices[0]!.finish_reason, "tool_calls");
      assert.deepEqual(
        body.choices[0]!.message.tool_calls?.map((call) => call.id),
        ["call_new"],
      );
      // The delivered batch ends its turn through exactly one interrupt; no
      // source read/resume and no fork ever precede it.
      assert.deepEqual(resumedFake.methods, [
        "thread/start",
        "thread/inject_items",
        "turn/start",
        "turn/interrupt",
      ]);
      assert.equal(resumedFake.methods.includes("thread/fork"), false);
    } finally {
      await resumedServer.proxy.close();
    }
  }, "codex-tool-raw-resume-");
});

test("a post-restart tool continuation falls back even when the next response is text-only", async () => {
  await withTempDir(async (directory) => {
    const firstFake = new ToolAppServer();
    const firstServer = await startProxy(directory, firstFake);
    let continuedId = "";
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
      // Consume the batch natively so the restart continues from a ready
      // record whose binding includes the active tools.
      const continued = (await (
        await postChatCompletion(firstServer.origin, {
          model: "m",
          tools: [
            { type: "function", function: { name: "first", parameters: {} } },
            { type: "function", function: { name: "second", parameters: {} } },
          ],
          previous_response_id: initial.id,
          messages: toolTranscript(initial.choices[0]!.message.tool_calls),
        })
      ).json()) as CompletionBody;
      continuedId = continued.id;
    } finally {
      await firstServer.proxy.close();
    }

    const secondFake = new ToolAppServer(false);
    const secondServer = await startProxy(directory, secondFake);
    try {
      const response = await postChatCompletion(secondServer.origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        previous_response_id: continuedId,
        messages: [{ role: "user", content: "just text" }],
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as CompletionBody;
      // Active tools without raw-response capability on the new transport
      // select a fresh thread even though this response would be text-only.
      // The fallback happens before any source RPC: one start and one turn,
      // with the single user message as input and no history to inject.
      assert.equal(body.x_codex?.threadReused, false);
      assert.equal(body.choices[0]!.finish_reason, "stop");
      assert.equal(body.choices[0]!.message.content, "continued");
      assert.deepEqual(secondFake.methods, ["thread/start", "turn/start"]);
      assert.equal(secondFake.injected.length, 0);
      assert.equal(secondFake.methods.includes("thread/fork"), false);
    } finally {
      await secondServer.proxy.close();
    }
  }, "codex-tool-restart-text-");
});

test("completed continuations survive restart, fall back from superseded selectors, and reject a resume race", async () => {
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
      assert.equal(superseded.status, 200);
      const branched = (await superseded.json()) as CompletionBody;
      // The superseded selector is unavailable, so the branch executes its
      // transcript on a fresh thread: one new start and turn, and never a
      // second read/resume of the source thread.
      assert.equal(branched.x_codex?.threadReused, false);
      assert.deepEqual(resumedFake.methods, [
        "thread/read",
        "thread/resume",
        "turn/start",
        "thread/start",
        "turn/start",
      ]);
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

test("a failed injection tombstones the source and the retry isolates on a fresh thread", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer(
      true,
      false,
      undefined,
      false,
      {},
      {
        injectError: true,
      },
    );
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
      const transcript = toolTranscript(initial.choices[0]!.message.tool_calls);
      const failed = await postChatCompletion(origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        previous_response_id: initial.id,
        messages: transcript,
      });
      assert.equal(failed.status, 502);
      assert.equal(
        await responseErrorCode(failed),
        "tool_result_injection_failed",
      );
      // The injection reached an unknowable state, so the tombstone still
      // prevents replay into the source thread. The retry instead executes
      // the same transcript on a fresh thread, whose own injection succeeds.
      const attemptsBeforeRetry = fake.methods.length;
      const retried = await postChatCompletion(origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        previous_response_id: initial.id,
        messages: transcript,
      });
      assert.equal(retried.status, 200);
      const isolated = (await retried.json()) as CompletionBody;
      assert.equal(isolated.x_codex?.threadReused, false);
      assert.deepEqual(fake.methods.slice(attemptsBeforeRetry), [
        "thread/start",
        "thread/inject_items",
        "turn/start",
      ]);
      assert.deepEqual(
        fake.injected.map((item) => [item.type, item.call_id]),
        [
          ["function_call", "call_b"],
          ["function_call_output", "call_b"],
          ["function_call", "call_a"],
          ["function_call_output", "call_a"],
        ],
      );
      // The tombstoned source stays tombstoned: the fallback never injects
      // into it and never marks it consumed.
      assert.equal(
        persistedRecords(directory).find(
          (record) => record.responseId === initial.id,
        )?.state,
        "expired",
      );
    } finally {
      await proxy.close();
    }
  }, "codex-tool-inject-fail-");
});

test("a failed suffix injection tombstones the source and the retry carries the suffix onto a fresh thread", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer(
      true,
      false,
      undefined,
      false,
      {},
      {
        injectError: true,
      },
    );
    const { origin, proxy } = await startProxy(directory, fake);
    const tools = [
      { type: "function", function: { name: "first", parameters: {} } },
      { type: "function", function: { name: "second", parameters: {} } },
    ];
    try {
      const initial = (await (
        await postChatCompletion(origin, {
          model: "m",
          tools,
          messages: [{ role: "user", content: "tools" }],
        })
      ).json()) as CompletionBody;
      const transcript = [
        ...toolTranscript(initial.choices[0]!.message.tool_calls),
        { role: "user", content: "earlier" },
        { role: "user", content: "final" },
      ];
      const failed = await postChatCompletion(origin, {
        model: "m",
        tools,
        previous_response_id: initial.id,
        messages: transcript,
      });
      assert.equal(failed.status, 502);
      assert.equal(
        await responseErrorCode(failed),
        "tool_result_injection_failed",
      );
      // The injection reached an unknowable state, so the tombstone still
      // prevents replay into the source thread.
      assert.equal(
        persistedRecords(directory).find(
          (record) => record.responseId === initial.id,
        )?.state,
        "expired",
      );
      const attemptsBeforeRetry = fake.methods.length;
      const retried = await postChatCompletion(origin, {
        model: "m",
        tools,
        previous_response_id: initial.id,
        messages: transcript,
      });
      assert.equal(retried.status, 200);
      const isolated = (await retried.json()) as CompletionBody;
      assert.equal(isolated.x_codex?.threadReused, false);
      // The retry executes the same transcript on one fresh thread, whose
      // own injection succeeds.
      assert.deepEqual(fake.methods.slice(attemptsBeforeRetry), [
        "thread/start",
        "thread/inject_items",
        "turn/start",
      ]);
      // The failed attempt injected nothing; the fresh thread carries the
      // pairs plus every suffix user except the final one.
      assert.deepEqual(
        fake.injected.slice(0, 4).map((item) => [item.type, item.call_id]),
        [
          ["function_call", "call_b"],
          ["function_call_output", "call_b"],
          ["function_call", "call_a"],
          ["function_call_output", "call_a"],
        ],
      );
      assert.deepEqual(fake.injected.slice(4), [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "earlier" }],
        },
      ]);
      // The final suffix user remains the new turn's input.
      assert.deepEqual(fake.turnInputs.at(-1), [
        { type: "text", text: "final", text_elements: [] },
      ]);
    } finally {
      await proxy.close();
    }
  }, "codex-tool-suffix-inject-fail-");
});

test("a failed suffix turn start never retries and the retry executes fresh", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer(
      true,
      false,
      undefined,
      false,
      {},
      {
        failTurnStartOnTurn: 2,
      },
    );
    const { origin, proxy } = await startProxy(directory, fake);
    const tools = [
      { type: "function", function: { name: "first", parameters: {} } },
      { type: "function", function: { name: "second", parameters: {} } },
    ];
    try {
      const initial = (await (
        await postChatCompletion(origin, {
          model: "m",
          tools,
          messages: [{ role: "user", content: "tools" }],
        })
      ).json()) as CompletionBody;
      const transcript = [
        ...toolTranscript(initial.choices[0]!.message.tool_calls),
        { role: "user", content: "earlier" },
        { role: "user", content: "final" },
      ];
      const failed = await postChatCompletion(origin, {
        model: "m",
        tools,
        previous_response_id: initial.id,
        messages: transcript,
      });
      // A raw app-server turn/start rejection surfaces as a 500-level
      // JSON error before any header is committed.
      assert.ok(failed.status >= 500);
      // Exactly one continuation sequence: the failed turn/start is the
      // last RPC, and nothing follows it in this request — no second
      // execution and no fresh retry inside the request.
      assert.deepEqual(fake.methods, [
        "thread/start",
        "turn/start",
        "turn/interrupt",
        "thread/read",
        "thread/resume",
        "thread/inject_items",
        "turn/start",
      ]);
      // The pairs and the earlier suffix user were delivered before the
      // failed start.
      assert.deepEqual(
        fake.injected.slice(0, 4).map((item) => [item.type, item.call_id]),
        [
          ["function_call", "call_b"],
          ["function_call_output", "call_b"],
          ["function_call", "call_a"],
          ["function_call_output", "call_a"],
        ],
      );
      assert.deepEqual(fake.injected.slice(4), [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "earlier" }],
        },
      ]);
      // The successful injection consumed the record before the failed
      // start, so the source is superseded and can never be replayed.
      assert.equal(
        persistedRecords(directory).find(
          (record) => record.responseId === initial.id,
        )?.state,
        "superseded",
      );
      // The retry of the same suffix continuation selects fresh execution
      // for the superseded source: one new thread carries the transcript,
      // and its turn number no longer matches the failure knob.
      const attemptsBeforeRetry = fake.methods.length;
      const retried = await postChatCompletion(origin, {
        model: "m",
        tools,
        previous_response_id: initial.id,
        messages: transcript,
      });
      assert.equal(retried.status, 200, await retried.clone().text());
      const isolated = (await retried.json()) as CompletionBody;
      assert.equal(isolated.x_codex?.threadReused, false);
      assert.deepEqual(fake.methods.slice(attemptsBeforeRetry), [
        "thread/start",
        "thread/inject_items",
        "turn/start",
      ]);
    } finally {
      await proxy.close();
    }
  }, "codex-tool-suffix-turn-fail-");
});

test("a failed interrupt rejects the response and makes its batch non-replayable", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer(
      true,
      false,
      undefined,
      false,
      { suspendOrder: "on_interrupt" },
      { interruptError: true },
    );
    const { origin, proxy } = await startProxy(directory, fake);
    try {
      const response = await postChatCompletion(origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        messages: [{ role: "user", content: "tools" }],
      });
      assert.equal(response.status, 502);
      assert.equal(
        await responseErrorCode(response),
        "tool_turn_interrupt_failed",
      );
      // No actionable tool_calls response was exposed, and the original
      // app-server requests remain unanswered rather than resuming an
      // ownerless turn.
      assert.deepEqual(fake.rejections, []);
      assert.equal(
        persistedRecords(directory).some(
          (candidate) => candidate.state === "pending_tool",
        ),
        false,
      );
    } finally {
      await proxy.close();
    }
  }, "codex-tool-interrupt-fail-");
});

test("a failed fresh fallback returns its error without a second attempt", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer(
      true,
      false,
      undefined,
      false,
      {},
      {
        failThreadStart: true,
      },
    );
    const { origin, proxy } = await startProxy(directory, fake);
    try {
      const response = await postChatCompletion(origin, {
        model: "m",
        messages: [{ role: "user", content: "fresh start" }],
        previous_response_id: "chatcmpl_codex_unknown",
      });
      // The unknown selector selects fresh execution; a rejected thread/start
      // fails the request exactly once, with no second execution attempt.
      assert.ok(response.status >= 500);
      assert.deepEqual(fake.methods, ["thread/start"]);
    } finally {
      await proxy.close();
    }
  }, "codex-tool-fallback-fail-");
});

test("duplicate app-server tool call IDs are deduplicated by first arrival", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer(
      true,
      false,
      undefined,
      false,
      {},
      { duplicateToolCallId: true },
    );
    const { origin, proxy } = await startProxy(directory, fake);
    try {
      const response = await postChatCompletion(origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        messages: [{ role: "user", content: "tools" }],
      });
      assert.equal(response.status, 200, await response.clone().text());
      const body = (await response.json()) as CompletionBody;
      assert.deepEqual(body.choices[0]!.message.tool_calls, [
        {
          id: "call_b",
          function: { name: "second", arguments: '{"fragment":"b"}' },
          type: "function",
        },
      ]);
      assert.deepEqual(fake.rejections, []);
      const pending = persistedRecords(directory).find(
        (record) => record.responseId === body.id,
      );
      assert.deepEqual(pending?.pendingCalls, [
        { callId: "call_b", name: "second", arguments: '{"fragment":"b"}' },
      ]);
      assert.equal("callIds" in (pending ?? {}), false);
    } finally {
      await proxy.close();
    }
  }, "codex-tool-duplicate-id-");
});

test("a failed replay-guard write prevents injection and leaves a safe retry", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer();
    const { origin, proxy } = await startProxy(directory, fake);
    let restoreUpdate: (() => void) | undefined;
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
      const transcript = toolTranscript(initial.choices[0]!.message.tool_calls);
      const original = ResponseStore.prototype.update;
      const update = vi
        .spyOn(ResponseStore.prototype, "update")
        .mockImplementation(function (this: ResponseStore, responseId, patch) {
          if (patch.state === "expired")
            throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          return original.call(this, responseId, patch);
        });
      restoreUpdate = () => update.mockRestore();

      const failed = await postChatCompletion(origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        previous_response_id: initial.id,
        messages: transcript,
      });
      assert.equal(failed.status, 500);
      assert.equal(await responseErrorCode(failed), "internal_error");
      assert.equal(fake.injected.length, 0);
      assert.equal(
        persistedRecords(directory).find(
          (candidate) => candidate.responseId === initial.id,
        )?.state,
        "pending_tool",
      );

      update.mockRestore();
      restoreUpdate = undefined;
      const retried = await postChatCompletion(origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        previous_response_id: initial.id,
        messages: transcript,
      });
      assert.equal(retried.status, 200);
      assert.equal(fake.injected.length, 4);
    } finally {
      restoreUpdate?.();
      await proxy.close();
    }
  }, "codex-tool-replay-guard-write-");
});

test("post-handoff bookkeeping failures do not retract the response or permit replay", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer();
    const original = ResponseStore.prototype.update;
    const update = vi
      .spyOn(ResponseStore.prototype, "update")
      .mockImplementation(function (this: ResponseStore, responseId, patch) {
        if ("usageTotal" in patch || patch.state === "superseded")
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        return original.call(this, responseId, patch);
      });
    const { origin, proxy } = await startProxy(directory, fake);
    try {
      const initialResponse = await postChatCompletion(origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        messages: [{ role: "user", content: "tools" }],
      });
      assert.equal(initialResponse.status, 200);
      const initial = (await initialResponse.json()) as CompletionBody;
      assert.equal(initial.choices[0]!.finish_reason, "tool_calls");

      const continued = await postChatCompletion(origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        previous_response_id: initial.id,
        messages: toolTranscript(initial.choices[0]!.message.tool_calls),
      });
      assert.equal(continued.status, 200);
      assert.equal(fake.injected.length, 4);

      const replay = await postChatCompletion(origin, {
        model: "m",
        tools: [
          { type: "function", function: { name: "first", parameters: {} } },
          { type: "function", function: { name: "second", parameters: {} } },
        ],
        previous_response_id: initial.id,
        messages: toolTranscript(initial.choices[0]!.message.tool_calls),
      });
      assert.equal(replay.status, 200);
      const isolated = (await replay.json()) as CompletionBody;
      // The tombstoned selector cannot replay into the source thread, but the
      // complete transcript still executes: the fallback injects its own copy
      // into a new thread while the failed bookkeeping stays best-effort.
      assert.equal(isolated.x_codex?.threadReused, false);
      assert.equal(fake.injected.length, 8);
      assert.equal(
        fake.methods.filter((method) => method === "thread/start").length,
        2,
      );
    } finally {
      update.mockRestore();
      await proxy.close();
    }
  }, "codex-tool-best-effort-state-");
});

test("implicit binding mismatches fall back and leave the pending source consumable", async () => {
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
          reasoning_effort: "high",
          tools,
          x_codex: { sandbox: "workspace-write" },
          messages: [{ role: "user", content: "use tools" }],
        })
      ).json()) as CompletionBody;
      const calls = first.choices[0]!.message.tool_calls;

      // An implicit continuation that drops x_codex no longer fails: its
      // binding cannot resume the suspension, so the transcript executes on a
      // fresh thread under the requested default policy instead.
      const dropped = await postChatCompletion(origin, {
        model: "m",
        reasoning_effort: "high",
        tools,
        messages: toolTranscript(calls),
      });
      assert.equal(dropped.status, 200);
      assert.equal(
        ((await dropped.clone().json()) as CompletionBody).x_codex
          ?.threadReused,
        false,
      );

      // A changed reasoning effort is the same kind of binding mismatch: the
      // full transcript runs on another fresh thread.
      const changedEffort = await postChatCompletion(origin, {
        model: "m",
        reasoning_effort: "low",
        tools,
        x_codex: { sandbox: "workspace-write" },
        messages: toolTranscript(calls),
      });
      assert.equal(changedEffort.status, 200);
      assert.equal(
        ((await changedEffort.clone().json()) as CompletionBody).x_codex
          ?.threadReused,
        false,
      );
      // Each mismatched continuation injected its own copy of the transcript
      // into its own fresh thread; neither consumed the pending source.
      assert.equal(fake.injected.length, 8);
      assert.equal(
        persistedRecords(directory).find(
          (record) => record.responseId === first.id,
        )?.state,
        "pending_tool",
      );
      assert.equal(
        fake.methods.filter((method) => method === "thread/start").length,
        3,
      );

      // Repeating the original x_codex on the implicit continuation matches the
      // pending record and delivers the results natively on the source thread.
      const repeated = await postChatCompletion(origin, {
        model: "m",
        reasoning_effort: "high",
        tools,
        x_codex: { sandbox: "workspace-write" },
        messages: toolTranscript(calls),
      });
      assert.equal(repeated.status, 200);
      assert.equal(
        ((await repeated.clone().json()) as CompletionBody).x_codex
          ?.threadReused,
        true,
      );
      assert.equal(
        fake.methods.filter((method) => method === "thread/resume").length,
        1,
      );
      const expectedPairs = [
        ["function_call", "call_b"],
        ["function_call_output", "call_b"],
        ["function_call", "call_a"],
        ["function_call_output", "call_a"],
      ];
      assert.deepEqual(
        fake.injected.map((item) => [item.type, item.call_id]),
        [...expectedPairs, ...expectedPairs, ...expectedPairs],
      );
    } finally {
      await proxy.close();
    }
  }, "codex-dynamic-tools-");
});

test("tool_choice none changes a tool-bearing binding and falls back", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer();
    const { origin, proxy } = await startProxy(directory, fake);
    const tools = [
      { type: "function", function: { name: "first", parameters: {} } },
      { type: "function", function: { name: "second", parameters: {} } },
    ];
    try {
      const initial = (await (
        await postChatCompletion(origin, {
          model: "m",
          tools,
          messages: [{ role: "user", content: "tools" }],
        })
      ).json()) as CompletionBody;
      const calls = initial.choices[0]!.message.tool_calls!;

      // The tools are declared unchanged, but tool_choice "none" normalizes
      // the request to zero active tools, so its toolsHash cannot match the
      // pending record's tool-bearing binding and the transcript executes on
      // a fresh thread instead of the suspended one.
      const noneResponse = await postChatCompletion(origin, {
        model: "m",
        tools,
        tool_choice: "none",
        previous_response_id: initial.id,
        messages: toolTranscript(calls),
      });
      assert.equal(noneResponse.status, 200);
      const none = (await noneResponse.json()) as CompletionBody;
      assert.equal(none.x_codex?.threadReused, false);
      // The fresh thread replays the injected pairs as the model-visible
      // input, so its empty-input turn completes like any result continuation.
      assert.equal(none.choices[0]!.message.content, "after tools");
      assert.equal(none.choices[0]!.finish_reason, "stop");
      assert.equal(
        fake.methods.filter((method) => method === "thread/start").length,
        2,
      );
      assert.equal(fake.methods.includes("thread/resume"), false);
      assert.equal(fake.methods.includes("thread/fork"), false);
      assert.deepEqual(
        fake.injected.map((item) => [item.type, item.call_id]),
        [
          ["function_call", "call_b"],
          ["function_call_output", "call_b"],
          ["function_call", "call_a"],
          ["function_call_output", "call_a"],
        ],
      );
      // The bypassed source is never consumed: its pending record stays
      // selectable for a later request that repeats the tool-bearing binding.
      assert.equal(
        persistedRecords(directory).find(
          (record) => record.responseId === initial.id,
        )?.state,
        "pending_tool",
      );
    } finally {
      await proxy.close();
    }
  }, "codex-tool-choice-none-");
});

/** Declares both scripted tools for one suspension-usage request. */
const USAGE_TOOLS = [
  { type: "function", function: { name: "first", parameters: {} } },
  { type: "function", function: { name: "second", parameters: {} } },
];

/** Reads the persisted continuation records without disturbing the live store. */
function persistedRecords(stateDir: string): Array<Record<string, unknown>> {
  const state = JSON.parse(
    readFileSync(join(stateDir, "continuations.json"), "utf8"),
  ) as { records?: Array<Record<string, unknown>> };
  return state.records ?? [];
}

/** Runs one suspension and its tool-result continuation, returning both bodies. */
async function suspendAndContinue(
  origin: string,
  beforeContinuation?: () => void,
): Promise<{ first: CompletionBody; continued: CompletionBody }> {
  const firstResponse = await postChatCompletion(origin, {
    model: "m",
    tools: USAGE_TOOLS,
    messages: [{ role: "user", content: "use tools" }],
  });
  assert.equal(firstResponse.status, 200);
  const first = (await firstResponse.json()) as CompletionBody;
  assert.equal(first.choices[0]!.finish_reason, "tool_calls");
  beforeContinuation?.();
  const continuedResponse = await postChatCompletion(origin, {
    model: "m",
    tools: USAGE_TOOLS,
    previous_response_id: first.id,
    messages: toolTranscript(first.choices[0]!.message.tool_calls),
  });
  assert.equal(continuedResponse.status, 200);
  return {
    first,
    continued: (await continuedResponse.json()) as CompletionBody,
  };
}

test("a tool batch app-server never attributed carries its boundary to the continuation", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer(true, false, undefined, false, {
      // A defective server that flushes nothing even at the interrupt: the
      // tool-call response reaches the client with no usage of its own.
      suspendOrder: "never",
      onCompletion: true,
      reasoningOutputTokens: 3,
    });
    const { origin, proxy } = await startProxy(directory, fake);
    try {
      const { first, continued } = await suspendAndContinue(origin);
      assert.equal(first.usage, undefined);
      // The continuation subtracts from the boundary the tool-call response
      // started from, so it reports both model requests rather than only its own.
      assert.deepEqual(continued.usage, {
        prompt_tokens: 8,
        completion_tokens: 10,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 6 },
      });
    } finally {
      await proxy.close();
    }
  }, "codex-dynamic-tools-");
});

test("a tool batch on a fresh thread persists its exact all-zero boundary and call metadata", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer(true, false, undefined, false, {
      suspendOrder: "never",
      onCompletion: true,
    });
    const { origin, proxy } = await startProxy(directory, fake);
    try {
      const response = await postChatCompletion(origin, {
        model: "m",
        tools: USAGE_TOOLS,
        messages: [{ role: "user", content: "use tools" }],
      });
      assert.equal(response.status, 200);
      const first = (await response.json()) as CompletionBody;
      const record = persistedRecords(directory).find(
        (candidate) => candidate.responseId === first.id,
      );
      assert.equal(record?.state, "pending_tool");
      // Zero is a meaningful boundary, not an absent one: a fresh thread had
      // provably consumed nothing when this response began.
      assert.deepEqual(record?.usageTotal, {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      });
      // The record carries everything a continuation must inject, so nothing
      // about the pending batch is process-local.
      assert.deepEqual(record?.pendingCalls, [
        { callId: "call_b", name: "second", arguments: '{"fragment":"b"}' },
        { callId: "call_a", name: "first", arguments: '{"fragment":"a"}' },
      ]);
    } finally {
      await proxy.close();
    }
  }, "codex-dynamic-tools-");
});

test("usage captured before a tool call is reported without waiting", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer(true, false, undefined, false, {
      suspendOrder: "before_tool_call",
      onCompletion: true,
      reasoningOutputTokens: 3,
    });
    const { origin, proxy } = await startProxy(directory, fake);
    try {
      const started = Date.now();
      const response = await postChatCompletion(origin, {
        model: "m",
        tools: USAGE_TOOLS,
        messages: [{ role: "user", content: "use tools" }],
      });
      assert.equal(response.status, 200);
      const first = (await response.json()) as CompletionBody;
      assert.equal(first.choices[0]!.finish_reason, "tool_calls");
      assert.equal(first.usage?.completion_tokens_details?.reasoning_tokens, 3);
      assert.ok(
        Date.now() - started < 1_000,
        "the interrupted turn's idle boundary must end the wait immediately",
      );
    } finally {
      await proxy.close();
    }
  }, "codex-dynamic-tools-");
});

test("usage flushed by the interrupt is attributed to the tool-call response", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer(true, false, undefined, false, {
      suspendOrder: "on_interrupt",
      onCompletion: true,
      reasoningOutputTokens: 3,
    });
    const { origin, proxy } = await startProxy(directory, fake);
    try {
      const { first, continued } = await suspendAndContinue(origin);
      assert.deepEqual(first.usage, {
        prompt_tokens: 4,
        completion_tokens: 5,
        total_tokens: 9,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 3 },
      });
      // The client already counted the first round, so the continuation counts
      // from the tool-call boundary rather than repeating it.
      assert.deepEqual(continued.usage, {
        prompt_tokens: 4,
        completion_tokens: 5,
        total_tokens: 9,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 3 },
      });
    } finally {
      await proxy.close();
    }
  }, "codex-dynamic-tools-");
});

test("usage observed after a tool-call response ends never advances its boundary", async () => {
  await withTempDir(async (directory) => {
    const fake = new ToolAppServer(true, false, undefined, false, {
      suspendOrder: "never",
      onCompletion: true,
      reasoningOutputTokens: 3,
    });
    const { origin, proxy } = await startProxy(directory, fake);
    try {
      const { first, continued } = await suspendAndContinue(origin, () => {
        // Delivered once the suspended response has demonstrably ended, so no
        // observer may fold it into a boundary no response reported.
        fake.sendUsage();
      });
      assert.equal(first.usage, undefined);
      assert.deepEqual(continued.usage, {
        prompt_tokens: 8,
        completion_tokens: 10,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 6 },
      });
    } finally {
      await proxy.close();
    }
  }, "codex-dynamic-tools-");
});

test("a server that never flushes usage leaves it omitted rather than estimated", async () => {
  await withTempDir(async (directory) => {
    const entries: Array<Record<string, unknown>> = [];
    const fake = new ToolAppServer(true, false, undefined, false, {
      suspendOrder: "never",
      onCompletion: true,
      reasoningOutputTokens: 3,
    });
    const { origin, proxy } = await startProxy(
      directory,
      fake,
      createLogger("warn", (entry) => entries.push(entry)),
    );
    try {
      const response = await postChatCompletion(origin, {
        model: "m",
        tools: USAGE_TOOLS,
        messages: [{ role: "user", content: "use tools" }],
      });
      assert.equal(response.status, 200);
      const first = (await response.json()) as CompletionBody;
      assert.equal(first.choices[0]!.finish_reason, "tool_calls");
      // Live app-server flushes usage at the interrupt; against a server that
      // does not, the response reports none instead of guessing.
      assert.equal(first.usage, undefined);
      const warnings = entries.filter(
        (entry) => entry.event === "usage_unreported",
      );
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.level, "warn");
      assert.equal(warnings[0]?.reason, "idle_grace_expired");
      assert.equal(warnings[0]?.pending_tool_batch, true);
      assert.equal(typeof warnings[0]?.request_id, "string");
    } finally {
      await proxy.close();
    }
  }, "codex-dynamic-tools-");
});
