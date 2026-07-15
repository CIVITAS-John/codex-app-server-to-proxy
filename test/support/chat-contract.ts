import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test } from "vitest";

/** Model fixed by the repository's live-test cost policy. */
export const CONTRACT_MODEL = "gpt-5.4-mini";

/** Maximum model turns allowed by the focused Stage 03 live suite. */
const MAX_LIVE_MODEL_CALLS = 4;

/** Maximum model turns allowed by the comprehensive offline contract. */
const MAX_OFFLINE_MODEL_CALLS = 8;

/** Maximum model turns allowed for the complete tool round trip. */
const MAX_TOOL_MODEL_CALLS = 2;

/** Maximum error text retained in assertion output. */
const MAX_DIAGNOSTIC_LENGTH = 1_000;

/** A ready proxy backed by either a scripted or real app-server. */
export interface ChatContractBackend {
  origin: string;
  modelCalls(): number;
  waitForInterrupt(): Promise<void>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

/** Starts one backend shared by every scenario in a contract run. */
export type ChatContractBackendFactory = () => Promise<ChatContractBackend>;

/** Selects the comprehensive offline contract or focused Stage 03 live proof. */
export interface ChatContractOptions {
  stage03Live?: boolean;
}

/** Registers the backend-independent Chat Completions HTTP contract. */
export function registerChatContract(
  name: string,
  startBackend: ChatContractBackendFactory,
  options: ChatContractOptions = {},
): void {
  describe.sequential(`Chat Completions contract (${name})`, () => {
    let backend: ChatContractBackend | undefined;
    const maxModelCalls = options.stage03Live
      ? MAX_LIVE_MODEL_CALLS
      : MAX_OFFLINE_MODEL_CALLS;

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

    if (!options.stage03Live)
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
        const body = JSON.parse(raw) as {
          id?: string;
          object?: string;
          model?: string;
          choices?: Array<{
            index?: number;
            finish_reason?: string | null;
            message?: { role?: string; content?: string };
          }>;
          usage?: Usage;
        };
        assert.match(body.id ?? "", /^chatcmpl_codex_/);
        assert.equal(body.object, "chat.completion");
        assert.equal(body.model, CONTRACT_MODEL);
        assert.equal(body.choices?.[0]?.index, 0);
        assert.equal(body.choices?.[0]?.message?.role, "assistant");
        assert.ok((body.choices?.[0]?.message?.content?.length ?? 0) > 0);
        assert.equal(body.choices?.[0]?.finish_reason, "stop");
        if (body.usage) assertUsage(body.usage);
      }, 130_000);

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
      assert.equal(frames.at(-1), "[DONE]");
      const chunks = frames
        .slice(0, -1)
        .map((frame) => JSON.parse(frame) as StreamChunk);
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
      const firstBody = JSON.parse(firstRaw) as ToolCompletion;
      const assistant = firstBody.choices?.[0]?.message;
      const call = assistant?.tool_calls?.[0];
      assert.match(firstBody.id ?? "", /^chatcmpl_codex_/);
      assert.equal(firstBody.choices?.[0]?.finish_reason, "tool_calls");
      assert.equal(assistant?.role, "assistant");
      assert.equal(assistant?.tool_calls?.length, 1);
      assert.ok(call?.id);
      assert.equal(call?.type, "function");
      assert.equal(call?.function.name, "contract_lookup");
      assert.deepEqual(JSON.parse(call?.function.arguments ?? ""), {
        key: "cedar",
      });

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
      const secondBody = JSON.parse(secondRaw) as ToolCompletion;
      assert.equal(secondBody.choices?.[0]?.finish_reason, "stop");
      assert.match(
        secondBody.choices?.[0]?.message?.content ?? "",
        /contract-tool-ok/i,
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
      const continuedBody = JSON.parse(continuedRaw) as ToolCompletion;
      assert.match(
        continuedBody.choices?.[0]?.message?.content ?? "",
        /contract-resume-ok/i,
      );
    }, 130_000);

    if (!options.stage03Live)
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
          const error = JSON.parse(raw) as { error?: { code?: string } };
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

    if (!options.stage03Live)
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
        const body = JSON.parse(raw) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
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
  choices?: Array<{
    delta?: { role?: string; content?: string };
    finish_reason?: string | null;
  }>;
  usage?: Usage;
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

/** Bounds response text included in a failed assertion. */
function diagnostic(value: string): string {
  return value.slice(0, MAX_DIAGNOSTIC_LENGTH);
}
