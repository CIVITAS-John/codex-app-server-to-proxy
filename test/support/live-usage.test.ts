import { afterEach, describe, expect, test, vi } from "vitest";
import { readContractResponse } from "./live-usage.js";

/** Synthetic public usage with zero reasoning to distinguish it from omission. */
const usage = {
  prompt_tokens: 120,
  completion_tokens: 30,
  prompt_tokens_details: { cached_tokens: 80 },
  completion_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 150,
};

/** Builds a synthetic SSE body in the same format consumed by live contracts. */
function sse(chunks: unknown[], done = true): Response {
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      (done ? "data: [DONE]\n\n" : ""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

afterEach(() => vi.restoreAllMocks());

describe("live HTTP usage reporting", () => {
  test("reports exact JSON counts without leaking payloads or consuming them twice", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    const raw = JSON.stringify({ usage, content: "synthetic-private-content" });
    expect(await readContractResponse(new Response(raw), 1)).toBe(raw);
    expect(output.mock.calls).toEqual([
      [
        "[live] usage request=1 format=json input_tokens=120 output_tokens=30 cached_input_tokens=80 reasoning_tokens=0 total_tokens=150",
      ],
    ]);
  });

  test("uses the final SSE usage once, even when finish follows usage", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    await readContractResponse(
      sse([
        { usage: { ...usage, completion_tokens: 10 } },
        { choices: [], usage },
        { choices: [{ finish_reason: "stop" }], usage: null },
      ]),
      2,
    );
    expect(output).toHaveBeenCalledExactlyOnceWith(
      "[live] usage request=2 format=sse input_tokens=120 output_tokens=30 cached_input_tokens=80 reasoning_tokens=0 total_tokens=150",
    );
  });

  test.each([false, true])(
    "keeps missing usage distinct from zero (stream=%s)",
    async (stream) => {
      const output = vi.spyOn(console, "info").mockImplementation(() => {});
      const body = { choices: [{ finish_reason: "tool_calls" }] };
      await readContractResponse(stream ? sse([body]) : Response.json(body), 3);
      expect(output).toHaveBeenCalledExactlyOnceWith(
        `[live] usage request=3 format=${stream ? "sse" : "json"} input_tokens=unreported output_tokens=unreported cached_input_tokens=unreported reasoning_tokens=unreported total_tokens=unreported`,
      );
    },
  );

  test("does not replace missing or invalid detail counts with zero or payload text", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    await readContractResponse(
      Response.json({
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: "synthetic-private-content" },
        },
      }),
      4,
    );
    expect(output).toHaveBeenCalledExactlyOnceWith(
      "[live] usage request=4 format=json input_tokens=120 output_tokens=30 cached_input_tokens=unreported reasoning_tokens=unreported total_tokens=150",
    );
  });

  test("reports incomplete streams without treating early counts as final", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    await readContractResponse(sse([{ usage }], false), 5);
    expect(output).toHaveBeenCalledExactlyOnceWith(
      "[live] usage request=5 format=sse unavailable=incomplete_stream",
    );
  });

  test("does not leak malformed responses or mask their original contract failure", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    const raw = "synthetic-private-invalid-json";
    expect(await readContractResponse(new Response(raw), 6)).toBe(raw);
    expect(output).toHaveBeenCalledExactlyOnceWith(
      "[live] usage request=6 format=json unavailable=invalid_json",
    );
  });

  test("keeps offline reporting disabled and skips HTTP failures", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    await readContractResponse(Response.json({ usage }));
    await readContractResponse(
      Response.json({ error: {} }, { status: 400 }),
      7,
    );
    expect(output).not.toHaveBeenCalled();
  });
});
