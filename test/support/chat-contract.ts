import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test } from "vitest";

/** Model fixed by the repository's live-test cost policy. */
export const CONTRACT_MODEL = "gpt-5.4-mini";

/** Hard model-turn guard for the explicitly selected Stage 07 live scenarios. */
export const MAX_LIVE_MODEL_CALLS = 6;

/** Maximum model turns allowed by the comprehensive offline contract. */
const MAX_OFFLINE_MODEL_CALLS = 10;

/** Maximum model turns allowed for the complete tool round trip. */
const MAX_TOOL_MODEL_CALLS = 2;

/** A ready proxy backed by either a scripted or real app-server. */
export interface ChatContractBackend {
  origin: string;
  root: string;
  modelCalls(): number;
  resumeCalls(): number;
  waitForInterrupt(): Promise<void>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

/** Starts one backend shared by every scenario in a contract run. */
export type ChatContractBackendFactory = () => Promise<ChatContractBackend>;

/** Independently selectable compatibility claims in the shared contract. */
export type ChatContractScenario =
  | "aggregate"
  | "role-history-sse"
  | "dynamic-tool-restart"
  | "safe-policy-built-in-continuation"
  | "invalid-input"
  | "disconnect";

/** Selects named scenarios and a suite-wide model-call guard. */
export interface ChatContractOptions {
  scenarios?: readonly ChatContractScenario[];
  maxModelCalls?: number;
}

/** Complete deterministic contract exercised by the fake app-server. */
const OFFLINE_SCENARIOS: readonly ChatContractScenario[] = [
  "aggregate",
  "role-history-sse",
  "dynamic-tool-restart",
  "safe-policy-built-in-continuation",
  "invalid-input",
  "disconnect",
];

/** Registers the backend-independent Chat Completions HTTP contract. */
export function registerChatContract(
  name: string,
  startBackend: ChatContractBackendFactory,
  options: ChatContractOptions = {},
): void {
  describe.sequential(`Chat Completions contract (${name})`, () => {
    let backend: ChatContractBackend | undefined;
    const scenarios = new Set(options.scenarios ?? OFFLINE_SCENARIOS);
    const maxModelCalls = options.maxModelCalls ?? MAX_OFFLINE_MODEL_CALLS;

    beforeAll(async () => {
      backend = await startBackend();
    }, 130_000);

    afterAll(async () => {
      if (!backend) return;
      const modelCalls = backend.modelCalls();
      await backend.close();
      assert.ok(
        modelCalls <= maxModelCalls,
        `contract exceeded ${maxModelCalls} model calls`,
      );
    }, 20_000);

    /** Sends a request that is expected to reach app-server. */
    const chat = async (
      body: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<Response> => {
      assert.ok(
        (backend?.modelCalls() ?? 0) < maxModelCalls,
        `contract attempted more than ${maxModelCalls} model calls`,
      );
      return fetch(`${backend!.origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    };

    if (scenarios.has("aggregate"))
      test("returns an OpenAI-shaped aggregate completion", async () => {
        const response = await chat({
          model: CONTRACT_MODEL,
          messages: [
            {
              role: "user",
              content: "Reply with one short greeting and no explanation.",
            },
          ],
        });
        const raw = await response.text();
        assert.equal(response.status, 200, diagnostic(raw));
        const body = parseJson<{
          id?: string;
          object?: string;
          model?: string;
          choices?: Array<{
            index?: number;
            finish_reason?: string | null;
            message?: { role?: string; content?: string };
          }>;
          usage?: Usage;
        }>(raw, "aggregate completion");
        assert.match(body.id ?? "", /^chatcmpl_codex_/);
        assert.equal(body.object, "chat.completion");
        assert.equal(body.model, CONTRACT_MODEL);
        assert.equal(body.choices?.[0]?.index, 0);
        assert.equal(body.choices?.[0]?.message?.role, "assistant");
        assert.ok((body.choices?.[0]?.message?.content?.length ?? 0) > 0);
        assert.equal(body.choices?.[0]?.finish_reason, "stop");
        if (body.usage) assertUsage(body.usage);
      }, 130_000);

    if (scenarios.has("role-history-sse"))
      test("streams role-preserving history as valid SSE", async () => {
        const response = await chat({
          model: CONTRACT_MODEL,
          messages: [
            { role: "system", content: "Answer briefly." },
            { role: "developer", content: "Do not use markdown." },
            { role: "user", content: "Remember the word cedar." },
            { role: "assistant", content: "I will remember cedar." },
            { role: "user", content: "Acknowledge the remembered word." },
          ],
          stream: true,
          stream_options: { include_usage: true },
        });
        assert.equal(response.status, 200);
        assert.equal(
          response.headers.get("content-type"),
          "text/event-stream; charset=utf-8",
        );
        const frames = (await response.text())
          .split("\n\n")
          .filter(Boolean)
          .map((frame) => frame.slice(6));
        assert.ok(
          frames.at(-1) === "[DONE]",
          "SSE stream omitted its terminal marker",
        );
        const chunks = frames
          .slice(0, -1)
          .map((frame) => parseJson<StreamChunk>(frame, "SSE frame"));
        assert.equal(chunks[0]?.choices?.[0]?.delta?.role, "assistant");
        const content = chunks
          .flatMap((chunk) => chunk.choices ?? [])
          .map((choice) => choice.delta?.content ?? "")
          .join("");
        assert.ok(content.length > 0);
        assert.equal(
          chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === "stop"),
          true,
        );
        const usage = chunks.find(
          (chunk) => chunk.choices?.length === 0 && chunk.usage,
        )?.usage;
        if (usage) assertUsage(usage);
      }, 130_000);

    if (scenarios.has("dynamic-tool-restart"))
      test("completes a client function-tool round trip and resumes after restart", async () => {
        const callsBefore = backend!.modelCalls();
        const tools = [
          {
            type: "function",
            function: {
              name: "contract_lookup",
              description: "Looks up the fixed live-contract test value.",
              parameters: {
                type: "object",
                properties: { key: { type: "string" } },
                required: ["key"],
                additionalProperties: false,
              },
            },
          },
        ];
        const first = await chat({
          model: CONTRACT_MODEL,
          messages: [
            {
              role: "user",
              content:
                "Call contract_lookup exactly once with key cedar. Do not answer without using the tool.",
            },
          ],
          tools,
        });
        const firstRaw = await first.text();
        assert.equal(first.status, 200, diagnostic(firstRaw));
        const firstBody = parseJson<ToolCompletion>(
          firstRaw,
          "dynamic-tool completion",
        );
        const assistant = firstBody.choices?.[0]?.message;
        const call = assistant?.tool_calls?.[0];
        assert.match(firstBody.id ?? "", /^chatcmpl_codex_/);
        assert.equal(firstBody.choices?.[0]?.finish_reason, "tool_calls");
        assert.equal(assistant?.role, "assistant");
        assert.equal(assistant?.tool_calls?.length, 1);
        assert.ok(call?.id);
        assert.ok(
          call?.type === "function",
          "dynamic tool call used an unsupported type",
        );
        assert.ok(
          call?.function.name === "contract_lookup",
          "dynamic tool name did not match the contract fixture",
        );
        const callArguments = parseJson<Record<string, unknown>>(
          call?.function.arguments ?? "",
          "dynamic-tool arguments",
        );
        assert.ok(
          callArguments.key === "cedar" &&
            Object.keys(callArguments).length === 1,
          "dynamic-tool arguments did not match the contract fixture",
        );

        const second = await chat({
          model: CONTRACT_MODEL,
          messages: [
            {
              role: "assistant",
              content: null,
              tool_calls: assistant!.tool_calls,
            },
            {
              role: "tool",
              tool_call_id: call!.id,
              content:
                "The lookup succeeded. Reply exactly with contract-tool-ok.",
            },
          ],
          tools,
        });
        const secondRaw = await second.text();
        assert.equal(second.status, 200, diagnostic(secondRaw));
        const secondBody = parseJson<ToolCompletion>(
          secondRaw,
          "tool-result completion",
        );
        assert.equal(secondBody.choices?.[0]?.finish_reason, "stop");
        assert.ok(
          /contract-tool-ok/i.test(
            secondBody.choices?.[0]?.message?.content ?? "",
          ),
          "tool-result completion omitted the contract acknowledgment",
        );
        assert.ok(
          backend!.modelCalls() - callsBefore <= MAX_TOOL_MODEL_CALLS,
          `tool round trip exceeded ${MAX_TOOL_MODEL_CALLS} model calls`,
        );

        await backend!.restart();
        const continued = await chat({
          model: CONTRACT_MODEL,
          previous_response_id: secondBody.id,
          messages: [
            {
              role: "user",
              content: "Reply exactly with contract-resume-ok.",
            },
          ],
          tools,
        });
        const continuedRaw = await continued.text();
        assert.equal(continued.status, 200, diagnostic(continuedRaw));
        const continuedBody = parseJson<ToolCompletion>(
          continuedRaw,
          "restart continuation",
        );
        assert.ok(
          /contract-resume-ok/i.test(
            continuedBody.choices?.[0]?.message?.content ?? "",
          ),
          "restart continuation omitted the contract acknowledgment",
        );
      }, 130_000);

    if (scenarios.has("safe-policy-built-in-continuation"))
      test("streams a read-only built-in command and continues its observation", async () => {
        const policy = {
          cwd: backend!.root,
          sandbox: "read-only",
          web_search: "disabled",
        };
        const callsBefore = backend!.modelCalls();
        const resumesBefore = backend!.resumeCalls();
        const response = await chat({
          model: CONTRACT_MODEL,
          messages: [
            {
              role: "user",
              content:
                "Use the built-in shell command tool to run pwd exactly once. Do not modify files. Then report the observed directory.",
            },
          ],
          stream: true,
          x_codex: policy,
        });
        const raw = await response.text();
        assert.equal(response.status, 200, diagnostic(raw));
        const chunks = parseSse(raw);
        const calls = chunks.flatMap(
          (chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? [],
        );
        const results = chunks.flatMap(
          (chunk) => chunk.choices?.[0]?.delta?.tool_results ?? [],
        );
        const uniqueCalls = [
          ...new Map(calls.map((call) => [call.id, call])).values(),
        ];
        assert.equal(
          uniqueCalls.length,
          1,
          "live policy scenario did not execute exactly one built-in command",
        );
        const builtIn = uniqueCalls[0]!;
        assert.ok(
          builtIn.function?.name === "commandExecution",
          "built-in tool name did not match the command contract",
        );
        const builtInArguments = parseJson<{ command?: string }>(
          builtIn.function?.arguments ?? "null",
          "built-in tool arguments",
        );
        assert.ok(
          builtInArguments.command === "pwd",
          "built-in command did not match the bounded contract fixture",
        );
        assert.ok(results.length > 0, "built-in result was not observed");
        assert.ok(
          results.every((result) =>
            uniqueCalls.some((call) => call.id === result.id),
          ),
          "built-in results were not correlated to observed calls",
        );
        assert.equal(
          chunks.some(
            (chunk) => chunk.choices?.[0]?.finish_reason === "tool_calls",
          ),
          false,
          "already-executed built-in activity suspended as a client tool",
        );
        const responseId = chunks.find((chunk) => chunk.id)?.id;
        assert.match(responseId ?? "", /^chatcmpl_codex_/);

        const continued = await chat({
          model: CONTRACT_MODEL,
          previous_response_id: responseId,
          messages: [
            {
              role: "user",
              content:
                "State the directory observed by the prior built-in command.",
            },
          ],
          x_codex: policy,
        });
        const continuedRaw = await continued.text();
        assert.equal(continued.status, 200, diagnostic(continuedRaw));
        const body = parseJson<ToolCompletion>(
          continuedRaw,
          "built-in continuation",
        );
        assert.ok(
          (body.choices?.[0]?.message?.content ?? "").includes(backend!.root),
          "built-in continuation omitted the observed directory",
        );
        assert.equal(backend!.resumeCalls(), resumesBefore + 1);
        assert.ok(
          backend!.modelCalls() - callsBefore <= 2,
          "built-in tool turn and continuation exceeded two model calls",
        );
      }, 130_000);

    if (scenarios.has("invalid-input"))
      test("rejects invalid requests before starting model work", async () => {
        const callsBefore = backend!.modelCalls();
        for (const body of [
          {
            model: CONTRACT_MODEL,
            messages: [{ role: "assistant", content: "not a user turn" }],
          },
          {
            model: CONTRACT_MODEL,
            messages: [{ role: "tool", content: "x" }],
          },
        ]) {
          const response = await fetch(
            `${backend!.origin}/v1/chat/completions`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
          );
          const raw = await response.text();
          assert.equal(response.status, 400, diagnostic(raw));
          const error = parseJson<{ error?: { code?: string } }>(
            raw,
            "invalid-input response",
          );
          assert.equal(error.error?.code, "invalid_request");
        }
        const unknown = await fetch(`${backend!.origin}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: CONTRACT_MODEL,
            messages: [{ role: "user", content: "x" }],
            previous_response_id: "chatcmpl_old",
          }),
        });
        assert.equal(unknown.status, 404);
        assert.equal(
          ((await unknown.json()) as { error?: { code?: string } }).error?.code,
          "unknown_previous_response_id",
        );
        assert.equal(
          backend!.modelCalls(),
          callsBefore,
          "invalid requests started app-server turns",
        );
      });

    if (scenarios.has("disconnect"))
      test("interrupts a disconnected stream and remains usable", async () => {
        const response = await chat({
          model: CONTRACT_MODEL,
          messages: [
            {
              role: "user",
              content:
                "Write the integers from 1 through 10000, one per line, without commentary.",
            },
          ],
          stream: true,
        });
        assert.equal(response.status, 200);
        const reader = response.body?.getReader();
        assert.ok(reader);
        while (true) {
          const part: ReadableStreamReadResult<Uint8Array> =
            await reader.read();
          assert.equal(
            part.done,
            false,
            "stream ended before assistant output",
          );
          if (Buffer.from(part.value).includes("content")) break;
        }
        await reader.cancel();
        await backend!.waitForInterrupt();

        const followup = await chat({
          model: CONTRACT_MODEL,
          messages: [
            { role: "user", content: "Reply with one short acknowledgment." },
          ],
        });
        const raw = await followup.text();
        assert.equal(followup.status, 200, diagnostic(raw));
        const body = parseJson<{
          choices?: Array<{ message?: { content?: string } }>;
        }>(raw, "disconnect follow-up");
        assert.ok((body.choices?.[0]?.message?.content?.length ?? 0) > 0);
      }, 130_000);
  });
}

/** Standard usage subset asserted by the shared contract. */
interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** Streaming response subset asserted by the shared contract. */
interface StreamChunk {
  id?: string;
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        id: string;
        function?: { name?: string; arguments?: string };
      }>;
      tool_results?: Array<{ id: string }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: Usage;
}

/** Parses a complete OpenAI-style SSE response and checks its terminal marker. */
function parseSse(value: string): StreamChunk[] {
  const frames = value
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => frame.slice(6));
  assert.ok(
    frames.at(-1) === "[DONE]",
    "SSE stream omitted its terminal marker",
  );
  return frames
    .slice(0, -1)
    .map((frame) => parseJson<StreamChunk>(frame, "SSE frame"));
}

/** Aggregate response subset used by the shared function-tool scenario. */
interface ToolCompletion {
  id?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
}

/** Validates reported usage without estimating omitted counts. */
function assertUsage(usage: Usage): void {
  assert.equal(typeof usage.prompt_tokens, "number");
  assert.equal(typeof usage.completion_tokens, "number");
  assert.equal(typeof usage.total_tokens, "number");
  assert.equal(
    usage.total_tokens,
    usage.prompt_tokens! + usage.completion_tokens!,
  );
}

/** Parses untrusted live output without reproducing it in failure diagnostics. */
function parseJson<T>(value: string, context: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${context} was not valid JSON`);
  }
}

/** Reports only response size so live failures cannot echo captured content. */
function diagnostic(value: string): string {
  return `response body was ${Buffer.byteLength(value)} bytes`;
}
