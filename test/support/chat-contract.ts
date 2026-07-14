import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test } from "vitest";

/** Model fixed by the repository's live-test cost policy. */
export const CONTRACT_MODEL = "gpt-5.4-mini";

/** Maximum number of requests in this suite that may start a model turn. */
const MAX_MODEL_CALLS = 4;

/** Maximum error text retained in assertion output. */
const MAX_DIAGNOSTIC_LENGTH = 1_000;

/** A ready proxy backed by either a scripted or real app-server. */
export interface ChatContractBackend {
  origin: string;
  modelCalls(): number;
  waitForInterrupt(): Promise<void>;
  close(): Promise<void>;
}

/** Starts one backend shared by every scenario in a contract run. */
export type ChatContractBackendFactory = () => Promise<ChatContractBackend>;

/** Registers the backend-independent Chat Completions HTTP contract. */
export function registerChatContract(
  name: string,
  startBackend: ChatContractBackendFactory,
): void {
  describe.sequential(`Chat Completions contract (${name})`, () => {
    let backend: ChatContractBackend | undefined;

    beforeAll(async () => {
      backend = await startBackend();
    }, 130_000);

    afterAll(async () => {
      if (!backend) return;
      const modelCalls = backend.modelCalls();
      await backend.close();
      assert.ok(
        modelCalls <= MAX_MODEL_CALLS,
        `contract exceeded ${MAX_MODEL_CALLS} model calls`,
      );
    }, 20_000);

    /** Sends a request that is expected to reach app-server. */
    const chat = async (
      body: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<Response> => {
      assert.ok(
        (backend?.modelCalls() ?? 0) < MAX_MODEL_CALLS,
        `contract attempted more than ${MAX_MODEL_CALLS} model calls`,
      );
      return fetch(`${backend!.origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    };

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

    test("rejects invalid requests before starting model work", async () => {
      const callsBefore = backend!.modelCalls();
      for (const body of [
        {
          model: CONTRACT_MODEL,
          messages: [{ role: "assistant", content: "not a user turn" }],
        },
        {
          model: CONTRACT_MODEL,
          messages: [{ role: "user", content: "x" }],
          previous_response_id: "chatcmpl_old",
        },
        {
          model: CONTRACT_MODEL,
          messages: [{ role: "tool", content: "x" }],
        },
      ]) {
        const response = await fetch(`${backend!.origin}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const raw = await response.text();
        assert.equal(response.status, 400, diagnostic(raw));
        const error = JSON.parse(raw) as { error?: { code?: string } };
        assert.equal(error.error?.code, "invalid_request");
      }
      assert.equal(
        backend!.modelCalls(),
        callsBefore,
        "invalid requests started app-server turns",
      );
    });

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
        const part: ReadableStreamReadResult<Uint8Array> = await reader.read();
        assert.equal(part.done, false, "stream ended before assistant output");
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
