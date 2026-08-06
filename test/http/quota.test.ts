import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { JsonRpcTransport } from "../../src/app-server/json-rpc.js";
import { HttpError } from "../../src/http/errors.js";
import {
  usageLimitError,
  usageLimitErrorResolver,
} from "../../src/http/quota.js";
import type { GetAccountRateLimitsResponse } from "../../protocol/generated/typescript/v2/GetAccountRateLimitsResponse.js";
import type { RateLimitResetCredit } from "../../protocol/generated/typescript/v2/RateLimitResetCredit.js";
import type { RateLimitResetCreditsSummary } from "../../protocol/generated/typescript/v2/RateLimitResetCreditsSummary.js";
import type { RateLimitSnapshot } from "../../protocol/generated/typescript/v2/RateLimitSnapshot.js";

/** Fixed Unix time so all quota reset assertions are deterministic. */
const NOW = 2_000_000_000;

/** Builds one complete generated-protocol rate-limit snapshot for a fake RPC. */
function rateLimitSnapshot(
  values: Partial<RateLimitSnapshot> = {},
): RateLimitSnapshot {
  return {
    limitId: "codex",
    limitName: "Codex",
    primary: null,
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: null,
    rateLimitReachedType: "rate_limit_reached",
    ...values,
  };
}

/** Builds a complete generated account/rateLimits/read response for a fake RPC. */
function rateLimitResponse(
  snapshot: RateLimitSnapshot,
  rateLimitsByLimitId: GetAccountRateLimitsResponse["rateLimitsByLimitId"] = {
    codex: snapshot,
  },
  rateLimitResetCredits: RateLimitResetCreditsSummary | null = null,
): GetAccountRateLimitsResponse {
  return {
    rateLimits: snapshot,
    rateLimitsByLimitId,
    rateLimitResetCredits,
  };
}

/** Builds one complete generated reset-credit row for a fake quota lookup. */
function rateLimitResetCredit(
  values: Partial<RateLimitResetCredit> = {},
): RateLimitResetCredit {
  return {
    id: "reset-credit-fixture",
    resetType: "codexRateLimits",
    status: "available",
    grantedAt: NOW - 60,
    expiresAt: NOW + 3_600,
    title: "Synthetic reset credit",
    description: "Synthetic quota test fixture.",
    ...values,
  };
}

/** Builds one complete generated reset-credit summary for a fake quota lookup. */
function rateLimitResetCreditsSummary(
  credits: RateLimitResetCredit[] | null = [rateLimitResetCredit()],
): RateLimitResetCreditsSummary {
  return { availableCount: BigInt(credits?.length ?? 1), credits };
}

/** Creates an app-server request double while retaining its exact call arguments. */
function rateLimitRpc(result: unknown | (() => Promise<unknown>)): {
  rpc: JsonRpcTransport;
  calls: Array<[string, unknown, AbortSignal]>;
} {
  const calls: Array<[string, unknown, AbortSignal]> = [];
  return {
    rpc: {
      request: async (
        method: string,
        params: unknown,
        signal: AbortSignal,
      ): Promise<unknown> => {
        calls.push([method, params, signal]);
        return typeof result === "function" ? await result() : result;
      },
    } as unknown as JsonRpcTransport,
    calls,
  };
}

/** Resolves one known usage-limit error through a deterministic fake RPC response. */
async function resolveUsageLimit(
  result: unknown | (() => Promise<unknown>),
  signal = new AbortController().signal,
): Promise<{
  error: HttpError;
  calls: Array<[string, unknown, AbortSignal]>;
  signal: AbortSignal;
}> {
  const fake = rateLimitRpc(result);
  const error = await usageLimitErrorResolver(fake.rpc, signal).resolve(
    new HttpError(
      429,
      "You have reached your usage limit.",
      "rate_limit_error",
      "usage_limit_exceeded",
    ),
  );
  return { error, calls: fake.calls, signal };
}

/** Restores the mocked wall clock after each reset-selection assertion. */
function fixedClock(): void {
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1_000);
}

/** Verifies that quota mapping is limited to the explicit Codex usage-limit code. */
test("only codex usageLimitExceeded becomes a quota error", () => {
  const quota = usageLimitError(
    { message: "quota", codexErrorInfo: "usageLimitExceeded" },
    "fallback",
  );
  assert.equal(quota?.status, 429);
  assert.equal(quota?.type, "rate_limit_error");
  assert.equal(quota?.code, "usage_limit_exceeded");
  assert.equal(quota?.message, "quota");
  for (const codexErrorInfo of [
    null,
    "contextWindowExceeded",
    "sessionBudgetExceeded",
    "other",
  ])
    assert.equal(
      usageLimitError({ message: "not quota", codexErrorInfo }, "fallback"),
      undefined,
    );
});

/** Verifies quota lookup request arguments and duplicate-terminal memoization. */
test("reads quota details once with undefined params and the request signal", async () => {
  fixedClock();
  try {
    const controller = new AbortController();
    const fake = rateLimitRpc(
      rateLimitResponse(
        rateLimitSnapshot({
          primary: {
            usedPercent: 100,
            windowDurationMins: 60,
            resetsAt: NOW + 30,
          },
        }),
      ),
    );
    const resolver = usageLimitErrorResolver(fake.rpc, controller.signal);
    const input = new HttpError(
      429,
      "quota",
      "rate_limit_error",
      "usage_limit_exceeded",
    );
    const [first, second] = await Promise.all([
      resolver.resolve(input),
      resolver.resolve(input),
    ]);
    assert.equal(first.extensions.xCodex?.resetAt, NOW + 30);
    assert.equal(second.extensions.xCodex?.resetAt, NOW + 30);
    assert.deepEqual(fake.calls, [
      ["account/rateLimits/read", undefined, controller.signal],
    ]);
  } finally {
    vi.restoreAllMocks();
  }
});

/** Verifies bucket priority and reset-selection rules for rolling rate limits. */
test("uses the codex bucket and latest exhausted reset before rolling fallbacks", async () => {
  fixedClock();
  try {
    const codex = rateLimitSnapshot({
      primary: {
        usedPercent: 100,
        windowDurationMins: 60,
        resetsAt: NOW + 20,
      },
      secondary: {
        usedPercent: 100,
        windowDurationMins: 1_440,
        resetsAt: NOW + 90,
      },
    });
    const fallback = rateLimitSnapshot({
      rateLimitReachedType: "workspace_owner_credits_depleted",
    });
    const resolved = await resolveUsageLimit(
      rateLimitResponse(fallback, { codex }),
    );
    assert.equal(resolved.error.code, "usage_limit_exceeded");
    assert.deepEqual(resolved.error.extensions, {
      xCodex: { resetAt: NOW + 90 },
      responseHeaders: { retryAfter: "90" },
    });

    const rolling = await resolveUsageLimit(
      rateLimitResponse(
        rateLimitSnapshot({
          primary: {
            usedPercent: 99,
            windowDurationMins: 60,
            resetsAt: NOW + 45,
          },
        }),
        null,
      ),
    );
    assert.equal(rolling.error.extensions.xCodex?.resetAt, NOW + 45);
    assert.equal(rolling.error.extensions.responseHeaders?.retryAfter, "45");
  } finally {
    vi.restoreAllMocks();
  }
});

/** Verifies a present malformed Codex bucket cannot be replaced by another limit. */
test("does not fall back from a malformed codex bucket", async () => {
  fixedClock();
  try {
    const fallback = rateLimitSnapshot({
      primary: {
        usedPercent: 100,
        windowDurationMins: 60,
        resetsAt: NOW + 30,
      },
    });
    const resolved = await resolveUsageLimit({
      ...rateLimitResponse(fallback),
      rateLimitsByLimitId: { codex: "invalid" },
    });
    assert.deepEqual(resolved.error.extensions, {});
  } finally {
    vi.restoreAllMocks();
  }
});

/** Verifies partially malformed lookup shapes cannot drive quota enrichment. */
test("keeps the default typed quota error for partially malformed lookup payloads", async () => {
  fixedClock();
  try {
    const resetWindow = {
      usedPercent: 100,
      windowDurationMins: 60,
      resetsAt: NOW + 30,
    };
    const enrichable = rateLimitSnapshot({
      primary: resetWindow,
      credits: { hasCredits: true, unlimited: false, balance: "10" },
      planType: "plus",
    });
    const selectedResponse = (
      codex: unknown,
      responseValues: Record<string, unknown> = {},
    ): unknown => ({
      ...rateLimitResponse(enrichable),
      rateLimitsByLimitId: { codex },
      ...responseValues,
    });
    const withoutField = (field: keyof RateLimitSnapshot): unknown => {
      const snapshot = { ...enrichable } as Record<string, unknown>;
      delete snapshot[field];
      return selectedResponse(snapshot);
    };
    const payloads: Array<{ name: string; create(): unknown }> = [
      {
        name: "missing required snapshot field",
        create: () => withoutField("primary"),
      },
      {
        name: "missing limitId",
        create: () => withoutField("limitId"),
      },
      {
        name: "wrong limitId",
        create: () => selectedResponse({ ...enrichable, limitId: 7 }),
      },
      {
        name: "missing limitName",
        create: () => withoutField("limitName"),
      },
      {
        name: "wrong limitName",
        create: () => selectedResponse({ ...enrichable, limitName: {} }),
      },
      {
        name: "malformed credits",
        create: () =>
          selectedResponse({
            ...enrichable,
            credits: { hasCredits: true, unlimited: "no", balance: null },
          }),
      },
      {
        name: "missing planType",
        create: () => withoutField("planType"),
      },
      {
        name: "unknown planType",
        create: () => selectedResponse({ ...enrichable, planType: "future" }),
      },
      {
        name: "invalid bucket container",
        create: () => ({
          ...rateLimitResponse(enrichable),
          rateLimitsByLimitId: "invalid",
        }),
      },
      {
        name: "array bucket container",
        create: () => ({
          ...rateLimitResponse(enrichable),
          rateLimitsByLimitId: [],
        }),
      },
      {
        name: "malformed primary window",
        create: () =>
          selectedResponse({
            ...enrichable,
            primary: "invalid",
            secondary: resetWindow,
          }),
      },
      {
        name: "missing window duration",
        create: () =>
          selectedResponse({
            ...enrichable,
            primary: { usedPercent: 100, resetsAt: NOW + 30 },
          }),
      },
      {
        name: "malformed reset-credit summary",
        create: () =>
          selectedResponse(enrichable, {
            rateLimitResetCredits: { availableCount: "1", credits: [] },
          }),
      },
      {
        name: "malformed reset-credit row",
        create: () => {
          const { status: _status, ...malformedRow } = rateLimitResetCredit();
          assert.equal(_status, "available");
          return selectedResponse(enrichable, {
            rateLimitResetCredits: {
              availableCount: 1n,
              credits: [malformedRow],
            },
          });
        },
      },
      {
        name: "malformed non-codex bucket",
        create: () => ({
          ...rateLimitResponse(enrichable),
          rateLimitsByLimitId: { codex: enrichable, other: "invalid" },
        }),
      },
    ];

    for (const payload of payloads) {
      const resolved = await resolveUsageLimit(payload.create());
      assert.equal(resolved.error.status, 429, payload.name);
      assert.equal(resolved.error.type, "rate_limit_error", payload.name);
      assert.equal(resolved.error.code, "usage_limit_exceeded", payload.name);
      assert.deepEqual(resolved.error.extensions, {}, payload.name);
      assert.equal(resolved.calls.length, 1, payload.name);
    }
  } finally {
    vi.restoreAllMocks();
  }
});

/** Verifies complete non-null optional quota structures still allow enrichment. */
test("accepts valid credits and reset-credit details during quota enrichment", async () => {
  fixedClock();
  try {
    const snapshot = rateLimitSnapshot({
      primary: {
        usedPercent: 100,
        windowDurationMins: 60,
        resetsAt: NOW + 30,
      },
      credits: { hasCredits: true, unlimited: false, balance: "10" },
      planType: "plus",
    });
    const resolved = await resolveUsageLimit(
      rateLimitResponse(
        snapshot,
        { codex: snapshot },
        rateLimitResetCreditsSummary(),
      ),
    );
    assert.equal(resolved.error.code, "usage_limit_exceeded");
    assert.deepEqual(resolved.error.extensions, {
      xCodex: { resetAt: NOW + 30 },
      responseHeaders: { retryAfter: "30" },
    });
  } finally {
    vi.restoreAllMocks();
  }
});

/** Verifies workspace credit classifications intentionally omit reset metadata. */
test("classifies workspace credit exhaustion without a reset", async () => {
  for (const rateLimitReachedType of [
    "workspace_owner_credits_depleted",
    "workspace_member_credits_depleted",
  ] as const) {
    const resolved = await resolveUsageLimit(
      rateLimitResponse(rateLimitSnapshot({ rateLimitReachedType })),
    );
    assert.equal(resolved.error.code, "insufficient_credits");
    assert.deepEqual(resolved.error.extensions, {});
  }
});

/** Verifies only confirmed workspace spend-control limits may expose a reset. */
test("uses workspace spend-control resets only when the backend confirms them", async () => {
  fixedClock();
  try {
    for (const rateLimitReachedType of [
      "workspace_owner_usage_limit_reached",
      "workspace_member_usage_limit_reached",
    ] as const) {
      const capped = await resolveUsageLimit(
        rateLimitResponse(
          rateLimitSnapshot({
            rateLimitReachedType,
            spendControlReached: true,
            individualLimit: {
              limit: "100",
              used: "100",
              remainingPercent: 0,
              resetsAt: NOW + 75,
            },
          }),
        ),
      );
      assert.equal(capped.error.code, "usage_limit_exceeded");
      assert.equal(capped.error.extensions.xCodex?.resetAt, NOW + 75);

      const untrusted = await resolveUsageLimit(
        rateLimitResponse(
          rateLimitSnapshot({
            rateLimitReachedType,
            spendControlReached: false,
            individualLimit: {
              limit: "100",
              used: "100",
              remainingPercent: 0,
              resetsAt: NOW + 75,
            },
            primary: {
              usedPercent: 100,
              windowDurationMins: 60,
              resetsAt: NOW + 90,
            },
          }),
        ),
      );
      assert.equal(untrusted.error.code, "workspace_usage_limit_exceeded");
      assert.deepEqual(untrusted.error.extensions, {});

      const staleIndividual = await resolveUsageLimit(
        rateLimitResponse(
          rateLimitSnapshot({
            rateLimitReachedType,
            spendControlReached: true,
            individualLimit: {
              limit: "100",
              used: "100",
              remainingPercent: 0,
              resetsAt: NOW,
            },
            primary: {
              usedPercent: 100,
              windowDurationMins: 60,
              resetsAt: NOW + 90,
            },
          }),
        ),
      );
      assert.equal(
        staleIndividual.error.code,
        "workspace_usage_limit_exceeded",
      );
      assert.deepEqual(staleIndividual.error.extensions, {});
    }
  } finally {
    vi.restoreAllMocks();
  }
});

/** Verifies observational lookup problems cannot erase the typed quota response. */
test("keeps typed quota failures when the lookup is malformed or fails", async () => {
  for (const result of [
    (): unknown => ({}),
    (): (() => Promise<unknown>) => async () => {
      throw new Error("lookup failed");
    },
  ]) {
    const resolved = await resolveUsageLimit(result());
    assert.equal(resolved.error.status, 429);
    assert.equal(resolved.error.type, "rate_limit_error");
    assert.equal(resolved.error.code, "usage_limit_exceeded");
    assert.deepEqual(resolved.error.extensions, {});
  }
});

/** Verifies caller cancellation remains visible instead of becoming a quota response. */
test("propagates cancellation from the quota lookup", async () => {
  const controller = new AbortController();
  controller.abort(new Error("client disconnected"));
  const fake = rateLimitRpc(async () => {
    throw controller.signal.reason;
  });
  await assert.rejects(
    usageLimitErrorResolver(fake.rpc, controller.signal).resolve(
      new HttpError(429, "quota", "rate_limit_error", "usage_limit_exceeded"),
    ),
    /client disconnected/,
  );
});
