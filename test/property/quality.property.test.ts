import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import fc from "fast-check";
import { test } from "vitest";
import { JsonRpcTransport } from "../../src/app-server/json-rpc.js";
import { bindingHash, canonicalJson } from "../../src/core/canonical.js";
import { createLogger } from "../../src/core/logger.js";
import {
  aggregateNormalizedEvents,
  EventNormalizer,
  serializeSseFrame,
  type NormalizedEvent,
} from "../../src/http/chat.js";
import { startFakeChatBackend } from "../support/chat-backends.js";
import {
  boundedJsonValue,
  fragmentByWidths,
  propertyOptions,
} from "../support/property.js";
import { repoRootUrl } from "../support/repo-root.js";

/** Checked-in minimal examples retained after property shrinking. */
const regressions = JSON.parse(
  await readFile(
    new URL("protocol/fixtures/property-regressions.json", repoRootUrl),
    "utf8",
  ),
) as {
  jsonRpcFragments: number[];
  dynamicToolArguments: unknown;
  ignoredField: string;
  canonicalLeft: unknown;
  canonicalRight: unknown;
};

/** Lowercase keys avoid prototype and transport-specific edge semantics. */
const ignoredField = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), {
    minLength: 1,
    maxLength: 24,
  })
  .map((characters) => `x_property_${characters.join("")}`);

test("property: JSON-RPC framing preserves arbitrary JSON across bounded fragments", async () => {
  await fc.assert(
    fc.asyncProperty(
      boundedJsonValue,
      fc.array(fc.integer({ min: 1, max: 17 }), {
        minLength: 1,
        maxLength: 8,
      }),
      async (params, widths) => {
        const input = new PassThrough();
        const rpc = new JsonRpcTransport(input, new PassThrough());
        const received = once(rpc, "notification");
        const frame = `${JSON.stringify({ method: "fixture/event", params })}\n`;
        for (const fragment of fragmentByWidths(frame, widths))
          input.write(fragment);
        assert.deepEqual(await received, ["fixture/event", params]);
        rpc.close();
      },
    ),
    propertyOptions,
  );
});

test("property: fragmented dynamic-tool arguments remain valid correlated JSON", async () => {
  const argumentsObject = boundedJsonValue.filter(
    (value) =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  );
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(fc.constant(regressions.dynamicToolArguments), argumentsObject),
      fc.oneof(
        fc.constant(regressions.jsonRpcFragments),
        fc.array(fc.integer({ min: 1, max: 17 }), {
          minLength: 1,
          maxLength: 8,
        }),
      ),
      async (argumentsValue, widths) => {
        const input = new PassThrough();
        const rpc = new JsonRpcTransport(input, new PassThrough());
        const pending = once(rpc, "request");
        const wire = `${JSON.stringify({
          id: 1,
          method: "item/tool/call",
          params: {
            threadId: "thread_property",
            turnId: "turn_property",
            callId: "call_property",
            namespace: null,
            tool: "lookup",
            arguments: argumentsValue,
          },
        })}\n`;
        for (const fragment of fragmentByWidths(wire, widths))
          input.write(fragment);
        const [request] = (await pending) as [
          { id: number; method: string; params: Record<string, unknown> },
        ];
        const normalized = new EventNormalizer().dynamicToolCall({
          request,
          callId: String(request.params.callId),
          name: String(request.params.tool),
          arguments: request.params.arguments,
          threadId: String(request.params.threadId),
          turnId: String(request.params.turnId),
        });
        const encoded = normalized.delta?.tool_calls?.[0]?.function.arguments;
        assert.deepEqual(JSON.parse(encoded ?? ""), argumentsValue);
        rpc.close();
      },
    ),
    propertyOptions,
  );
});

test("property: SSE serialization round-trips bounded JSON as one data frame", () => {
  fc.assert(
    fc.property(boundedJsonValue, (value) => {
      const encoded = JSON.stringify(value);
      const frame = serializeSseFrame(encoded);
      assert.equal(frame.startsWith("data: "), true);
      assert.equal(frame.endsWith("\n\n"), true);
      assert.deepEqual(JSON.parse(frame.slice(6, -2)), value);
    }),
    propertyOptions,
  );
});

test("property: response aggregation preserves order and sorts tool indexes", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.string({ maxLength: 32 }), { maxLength: 12 }),
      fc.array(fc.string({ maxLength: 32 }), { maxLength: 12 }),
      fc.uniqueArray(fc.integer({ min: 0, max: 32 }), { maxLength: 12 }),
      async (content, reasoning, indexes) => {
        const events: NormalizedEvent[] = [
          ...content.map((part) => ({ delta: { content: part } })),
          ...reasoning.map((part) => ({ delta: { reasoning: part } })),
          ...indexes.map((index) => ({
            delta: {
              tool_calls: [
                {
                  index,
                  id: `call_${index}`,
                  type: "function" as const,
                  function: { name: "fixture", arguments: "{}" },
                },
              ],
            },
          })),
          { finishReason: "stop" },
        ];
        const aggregate = await aggregateNormalizedEvents(events);
        assert.equal(aggregate.content, content.join(""));
        assert.equal(aggregate.reasoning, reasoning.join(""));
        assert.deepEqual(
          aggregate.toolCalls.map((call) => call.index),
          [...indexes].sort((left, right) => left - right),
        );
        assert.equal(aggregate.finishReason, "stop");
      },
    ),
    propertyOptions,
  );
});

test("property: canonical binding material ignores recursive object key order", () => {
  assert.equal(
    bindingHash(regressions.canonicalLeft),
    bindingHash(regressions.canonicalRight),
  );
  fc.assert(
    fc.property(boundedJsonValue, (value) => {
      const reparsed = JSON.parse(canonicalJson(value)) as unknown;
      assert.equal(canonicalJson(reparsed), canonicalJson(value));
      assert.equal(bindingHash(reparsed), bindingHash(value));
    }),
    propertyOptions,
  );
});

test("canonical binding material sorts keys by UTF-16 code units", () => {
  const value = {
    "\ue000": "private-use",
    "\u{10000}": "supplementary",
    "\u00e9": "accented",
    a: "lowercase",
    Z: "uppercase",
  };

  assert.equal(
    canonicalJson(value),
    '{"Z":"uppercase","a":"lowercase","\u00e9":"accented","\u{10000}":"supplementary","\ue000":"private-use"}',
  );
});

test("property: ignored fields produce exactly one sorted warning per request", async () => {
  const logs: Array<Record<string, unknown>> = [];
  const backend = await startFakeChatBackend(
    createLogger("warn", (entry) => logs.push(entry)),
  );
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.oneof(fc.constant(regressions.ignoredField), ignoredField),
          { minLength: 1, maxLength: 5 },
        ),
        async (keys) => {
          logs.length = 0;
          const body: Record<string, unknown> = {
            model: "gpt-5.6-luna",
            messages: [{ role: "user", content: "bounded property" }],
          };
          for (const [index, key] of keys.entries()) body[key] = index;
          const response = await fetch(
            `${backend.origin}/v1/chat/completions`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
          );
          assert.equal(response.status, 200);
          await response.arrayBuffer();
          const warnings = logs.filter(
            (entry) => entry.event === "unsupported_chat_fields_ignored",
          );
          assert.equal(warnings.length, 1);
          assert.deepEqual(warnings[0]?.fields, [...keys].sort());
        },
      ),
      { ...propertyOptions, numRuns: 12 },
    );
  } finally {
    await backend.close();
  }
});
