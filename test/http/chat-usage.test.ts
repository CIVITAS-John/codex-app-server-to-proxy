import assert from "node:assert/strict";
import { test } from "vitest";
import type { ServerNotification } from "../../protocol/generated/typescript/ServerNotification.js";
import { ZERO_TOKEN_USAGE } from "../../src/core/token-usage.js";
import { EventNormalizer } from "../../src/http/chat-normalize.js";
import { protocolNotification } from "../support/protocol-fixtures.js";
import { tokenUsageFixture } from "../support/transport.js";

/** Builds a typed completion with distinguishable exact model-request usage. */
function raw(responseId: string, reasoning = 3): Extract<ServerNotification, { method: "rawResponse/completed" }> {
  return {
    method: "rawResponse/completed",
    params: {
      threadId: "thread_usage",
      turnId: "turn_usage",
      responseId,
      usage: tokenUsageFixture(reasoning).last,
      usageMetadata: null,
    },
  };
}

/** Sends a complete thread snapshot after one or more upstream responses. */
function threadUsage(
  normalizer: EventNormalizer,
  reasoning: number,
  priorRequests = 0,
): void {
  const notification = protocolNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread_usage",
      turnId: "turn_usage",
      tokenUsage: tokenUsageFixture(reasoning, priorRequests),
    },
  });
  normalizer.normalize(notification.method, notification.params);
}

test("raw completions sum distinct responses and deduplicate repeated boundaries", () => {
  const normalizer = new EventNormalizer(ZERO_TOKEN_USAGE);
  const first = raw("response_1");
  const second = raw("response_2", 1);
  normalizer.normalize(first.method, first.params);
  normalizer.normalize(second.method, second.params);
  normalizer.normalize(first.method, first.params);
  assert.equal(normalizer.usageSnapshot()?.prompt_tokens, 8);
  assert.equal(
    normalizer.usageSnapshot()?.completion_tokens_details?.reasoning_tokens,
    4,
  );
  assert.equal(normalizer.usageSource(), "raw_response");
  assert.equal(normalizer.usageBoundary()?.reasoningOutputTokens, 4);
});

test("late thread usage replaces raw totals and its continuation boundary", () => {
  const normalizer = new EventNormalizer(ZERO_TOKEN_USAGE);
  const first = raw("response_1", 1);
  normalizer.normalize(first.method, first.params);
  threadUsage(normalizer, 7);
  assert.equal(normalizer.usageSource(), "thread_token_usage");
  assert.equal(
    normalizer.usageSnapshot()?.completion_tokens_details?.reasoning_tokens,
    7,
  );
  assert.equal(normalizer.usageBoundary()?.reasoningOutputTokens, 7);
  // A replayed raw completion must not revert a later correction.
  normalizer.normalize(first.method, first.params);
  assert.equal(normalizer.usageSource(), "thread_token_usage");
  assert.equal(
    normalizer.usageSnapshot()?.completion_tokens_details?.reasoning_tokens,
    7,
  );
});

test("a later raw completion includes earlier requests without adding thread totals twice", () => {
  const normalizer = new EventNormalizer(ZERO_TOKEN_USAGE);
  const first = raw("response_1");
  normalizer.normalize(first.method, first.params);
  threadUsage(normalizer, 3);
  const second = raw("response_2");
  normalizer.normalize(second.method, second.params);
  assert.equal(normalizer.usageSnapshot()?.total_tokens, 18);
  assert.equal(normalizer.usageBoundary()?.totalTokens, 18);
  const continuation = new EventNormalizer(normalizer.usageBoundary());
  threadUsage(continuation, 3, 2);
  assert.equal(continuation.usageSnapshot()?.total_tokens, 9);
  assert.equal(
    continuation.usageSnapshot()?.completion_tokens_details?.reasoning_tokens,
    3,
  );
});

test.each(["before", "after"])(
  "a raw completion without usage %s valid usage prevents partial sums",
  (position) => {
    const normalizer = new EventNormalizer(ZERO_TOKEN_USAGE);
    const missing = raw("missing");
    missing.params.usage = null;
    const valid = raw("valid");
    for (const notification of position === "before"
      ? [missing, valid]
      : [valid, missing])
      normalizer.normalize(notification.method, notification.params);
    assert.equal(normalizer.usageSnapshot(), undefined);
    assert.deepEqual(normalizer.usageBoundary(), ZERO_TOKEN_USAGE);
    threadUsage(normalizer, 3, 1);
    assert.equal(normalizer.usageSnapshot()?.total_tokens, 18);
  },
);

test("missing raw reasoning stays absent and cannot preserve a stale continuation baseline", () => {
  const normalizer = new EventNormalizer(ZERO_TOKEN_USAGE);
  const notification = raw("partial");
  // Malformed wire data deliberately violates the generated required field.
  const { reasoningOutputTokens: _reasoning, ...partial } =
    notification.params.usage!;
  normalizer.normalize(notification.method, {
    ...notification.params,
    usage: partial,
  });
  assert.equal(normalizer.usageSnapshot()?.total_tokens, 9);
  assert.equal(
    normalizer.usageSnapshot()?.completion_tokens_details,
    undefined,
  );
  assert.equal(normalizer.usageBoundary(), undefined);
  threadUsage(normalizer, 3);
  assert.equal(normalizer.usageBoundary()?.reasoningOutputTokens, 3);
});

test("zero reasoning is available usage and invalid counts are never exposed", () => {
  const normalizer = new EventNormalizer(ZERO_TOKEN_USAGE);
  const zero = raw("zero", 0);
  normalizer.normalize(zero.method, zero.params);
  assert.equal(
    normalizer.usageSnapshot()?.completion_tokens_details?.reasoning_tokens,
    0,
  );
  const invalid = raw("invalid");
  normalizer.normalize(invalid.method, {
    ...invalid.params,
    usage: { ...invalid.params.usage, inputTokens: -1 },
  });
  assert.equal(normalizer.usageSnapshot(), undefined);
});
