import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ServerNotification } from "../../protocol/generated/typescript/ServerNotification.js";
import { LiveUsageDiagnostics } from "./live-usage-diagnostics.js";
import { readContractResponse } from "./live-usage.js";
import { postChatCompletion, startProxyWithTransport } from "./http.js";
import {
  protocolNotification,
  protocolResponse,
  protocolThread,
  protocolThreadResumeResponse,
  protocolThreadStartResponse,
  protocolTurn,
} from "./protocol-fixtures.js";
import {
  completeTurn,
  createFakeTransport,
  tokenUsageFixture,
} from "./transport.js";
import { withTempDir } from "./temp.js";

/** Builds typed upstream completions with deliberately private synthetic identifiers. */
function raw(
  responseId: string,
  reasoning = 3,
  threadId = "private-thread",
  turnId = "private-turn",
): ServerNotification {
  return {
    method: "rawResponse/completed",
    params: {
      threadId,
      turnId,
      responseId,
      usage: tokenUsageFixture(reasoning).last,
      usageMetadata: null,
    },
  };
}

/** Builds a typed thread snapshot whose total can include previous model responses. */
function threadUsage(reasoning = 3, prior = 0): ServerNotification {
  return {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "private-thread",
      turnId: "private-turn",
      tokenUsage: tokenUsageFixture(reasoning, prior),
    },
  };
}

/** Public usage expected for one synthetic model response. */
function httpUsage(reasoning = 3, responses = 1): Record<string, unknown> {
  return {
    prompt_tokens: 4 * responses,
    completion_tokens: (2 + reasoning) * responses,
    total_tokens: (6 + reasoning) * responses,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: reasoning * responses },
  };
}

/** Exercises real framed RPCs, including notifications preceding the turn/start reply. */
function backend(
  notifications: ServerNotification[],
  finish = false,
  finalReasoning = 3,
) {
  const fake = createFakeTransport({
    onMessage(message, send) {
      if (message.method === "thread/start") {
        send(
          protocolResponse("thread/start", message.id as number, {
            ...protocolThreadStartResponse(protocolThread("private-thread")),
            reasoningEffort: "medium",
          }),
        );
      } else if (message.method === "thread/resume") {
        send(
          protocolResponse("thread/resume", message.id as number, {
            ...protocolThreadResumeResponse(protocolThread("private-thread")),
            reasoningEffort: "low",
          }),
        );
      } else if (message.method === "turn/start") {
        for (const notification of notifications)
          send(protocolNotification(notification));
        send(
          protocolResponse("turn/start", message.id as number, {
            turn: protocolTurn("private-turn", "inProgress"),
          }),
        );
        if (finish)
          completeTurn(send, "private-thread", "private-turn", {
            reasoningOutputTokens: finalReasoning,
          });
      } else throw new Error("Unexpected fake method");
    },
  });
  const diagnostics = new LiveUsageDiagnostics(fake.rpc);
  return { fake, diagnostics };
}

/** Drives one serial root turn and the existing proxy source-selection log. */
async function beginTurn(
  value: ReturnType<typeof backend>,
  effort?: string,
  resume = false,
): Promise<Response> {
  value.diagnostics.begin(
    effort === undefined ? {} : { reasoning_effort: effort },
  );
  await value.fake.rpc.request(resume ? "thread/resume" : "thread/start", {});
  await value.fake.rpc.request("turn/start", {
    threadId: "private-thread",
    ...(effort === undefined ? {} : { effort }),
  });
  value.diagnostics.log("debug", "usage_collection_completed", {
    request_id: "private-request",
    usage_source: "raw_response",
  });
  return new Response(null, { headers: { "x-request-id": "private-request" } });
}

afterEach(() => vi.restoreAllMocks());

test("deduplicates raw completions, excludes other turns and children, and retains late thread corrections", async (t) => {
  const value = backend([
    raw("private-response-1"),
    raw("private-response-1"),
    raw("private-response-2"),
    raw("child-response", 99, "private-child"),
    raw("old-response", 99, "private-thread", "old-turn"),
    threadUsage(0),
    threadUsage(3, 1),
  ]);
  t.onTestFinished(() => value.fake.close());
  const output = vi.spyOn(console, "info").mockImplementation(() => {});
  const response = await beginTurn(value, "high");
  value.diagnostics.report(response, 1, httpUsage(3, 2));
  const text = output.mock.calls.flat().join("\n");
  expect(text).toContain(
    "source=raw_response requested_effort=high thread_effort=medium effective_effort=high effort_evidence=turn_override",
  );
  expect(text).toContain(
    "raw_responses=2 duplicates=1 thread_updates=2 excluded_events=2 dropped_events=0",
  );
  expect(text).toContain(
    "raw_sum input_tokens=8 output_tokens=10 cached_input_tokens=0 reasoning_tokens=6 total_tokens=18 http_comparison=match reasoning_comparison=match",
  );
  expect(text).toContain(
    "thread_last input_tokens=4 output_tokens=5 cached_input_tokens=0 reasoning_tokens=3 total_tokens=9",
  );
  expect(text).toContain(
    "thread_total input_tokens=8 output_tokens=10 cached_input_tokens=0 reasoning_tokens=6 total_tokens=18",
  );
  expect(text).not.toContain("private-");
});

test("flags positive upstream reasoning becoming HTTP zero and resets on continuation", async (t) => {
  const value = backend([raw("private-response")]);
  t.onTestFinished(() => value.fake.close());
  const output = vi.spyOn(console, "info").mockImplementation(() => {});
  value.diagnostics.report(await beginTurn(value), 1, httpUsage(0));
  expect(output.mock.calls.flat().join("\n")).toContain(
    "http_comparison=mismatch reasoning_comparison=mismatch",
  );
  output.mockClear();
  value.diagnostics.report(
    await beginTurn(value, undefined, true),
    2,
    httpUsage(),
  );
  const text = output.mock.calls.flat().join("\n");
  expect(text).toContain(
    "thread_effort=low effective_effort=low effort_evidence=thread_response",
  );
  expect(text).toContain("raw_responses=1 duplicates=0");
  expect(text).toContain("http_comparison=match reasoning_comparison=match");
});

test("preserves zero while treating missing upstream usage as unavailable", async (t) => {
  const notifications = [raw("zero", 0)];
  const value = backend(notifications);
  t.onTestFinished(() => value.fake.close());
  const output = vi.spyOn(console, "info").mockImplementation(() => {});
  value.diagnostics.report(await beginTurn(value, "none"), 1, httpUsage(0));
  expect(output.mock.calls.flat().join("\n")).toContain(
    "reasoning_tokens=0 total_tokens=6 http_comparison=match reasoning_comparison=match",
  );
  notifications.push({
    method: "rawResponse/completed",
    params: {
      threadId: "private-thread",
      turnId: "private-turn",
      responseId: "missing",
      usage: null,
      usageMetadata: null,
    },
  });
  output.mockClear();
  value.diagnostics.report(await beginTurn(value), 2, httpUsage(0));
  expect(output.mock.calls.flat().join("\n")).toContain(
    "reasoning_tokens=unreported total_tokens=unreported http_comparison=unavailable reasoning_comparison=unavailable",
  );
});

test("caps retained evidence and does not compare a truncated raw sum", async (t) => {
  const value = backend(
    Array.from({ length: 130 }, (_, i) => raw(`response-${i}`)),
  );
  t.onTestFinished(() => value.fake.close());
  const output = vi.spyOn(console, "info").mockImplementation(() => {});
  value.diagnostics.report(await beginTurn(value), 1, httpUsage(3, 130));
  expect(output.mock.calls.flat().join("\n")).toContain("dropped_events=2");
  expect(output.mock.calls.flat().join("\n")).toContain(
    "http_comparison=unavailable reasoning_comparison=unavailable",
  );
  expect(output.mock.calls.length).toBeLessThanOrEqual(132);
});

test("rejects a mismatched HTTP request and never forwards arbitrary logs", async (t) => {
  const value = backend([raw("private-response")]);
  t.onTestFinished(() => value.fake.close());
  const output = vi.spyOn(console, "info").mockImplementation(() => {});
  await beginTurn(value);
  value.diagnostics.log("info", "unrelated", { prompt: "private-prompt" });
  value.diagnostics.log.failure("failure", {}, new Error("private-error"));
  value.diagnostics.report(new Response(), 1, httpUsage());
  expect(output.mock.calls).toEqual([
    ["[live] usage-evidence request=1 unavailable=uncorrelated"],
  ]);
});

test.each([
  { stream: false, finalReasoning: 3, comparison: "match" },
  { stream: true, finalReasoning: 3, comparison: "match" },
  { stream: false, finalReasoning: 0, comparison: "mismatch" },
  { stream: true, finalReasoning: 0, comparison: "mismatch" },
])(
  "compares real HTTP output against upstream evidence (stream=$stream, comparison=$comparison)",
  async ({ stream, finalReasoning, comparison }) => {
    await withTempDir(async (root) => {
      const value = backend([raw("private-response")], true, finalReasoning);
      const started = await startProxyWithTransport(value.fake.rpc, {
        root,
        stateDir: join(root, "state"),
        log: value.diagnostics.log,
      });
      const output = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const body = {
          model: "gpt-6-luna",
          messages: [{ role: "user", content: "Synthetic greeting" }],
          stream,
          reasoning_effort: "high",
        };
        value.diagnostics.begin(body);
        const response = await postChatCompletion(started.origin, body);
        expect(response.status).toBe(200);
        await readContractResponse(response, 1, (usage, number) =>
          value.diagnostics.report(response, number, usage),
        );
        const text = output.mock.calls.flat().join("\n");
        expect(text).toContain(`format=${stream ? "sse" : "json"}`);
        expect(text).toContain("source=thread_token_usage");
        expect(text).toContain(
          `http_comparison=${comparison} reasoning_comparison=${comparison}`,
        );
        expect(text).not.toContain("private-");
      } finally {
        await started.proxy.close();
        value.fake.close();
      }
    });
  },
);
