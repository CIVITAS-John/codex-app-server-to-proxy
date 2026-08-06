import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { JsonRpcTransport } from "../../src/app-server/json-rpc.js";
import { HttpError } from "../../src/http/errors.js";
import {
  usageLimitError,
  usageLimitErrorResolver,
} from "../../src/http/quota.js";
import {
  protocolRateLimitSnapshot,
  protocolRateLimitsResponse,
} from "../support/protocol-fixtures.js";
import type { RateLimitSnapshot } from "../../protocol/generated/typescript/v2/RateLimitSnapshot.js";

/** Fixed Unix time so all quota reset assertions are deterministic. */
const NOW = 2_000_000_000;

/** Creates an app-server request double while retaining its exact call arguments. */
function rateLimitRpc(result: unknown | (() => Promise<unknown>)): {
  rpc: Pick<JsonRpcTransport, "request">;
  calls: Array<[string, unknown, AbortSignal | undefined]>;
} {
  const calls: Array<[string, unknown, AbortSignal | undefined]> = [];
  return {
    rpc: {
      request: async (method, params, signal): Promise<unknown> => {
        calls.push([method, params, signal]);
        return typeof result === "function" ? await result() : result;
      },
    },
    calls,
  };
}

/** Resolves one known usage-limit error through a deterministic fake RPC response. */
async function resolveUsageLimit(
  result: unknown | (() => Promise<unknown>),
  signal = new AbortController().signal,
): Promise<{
  error: HttpError;
  calls: Array<[string, unknown, AbortSignal | undefined]>;
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
    "quota",
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
      usageLimitError({ message: "not quota", codexErrorInfo }, "not quota"),
      undefined,
    );
});

/** Verifies quota lookup request arguments and duplicate-terminal memoization. */
test("reads quota details once with undefined params and the request signal", async () => {
  fixedClock();
  try {
    const controller = new AbortController();
    const fake = rateLimitRpc(
      protocolRateLimitsResponse(
        protocolRateLimitSnapshot({
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
    const codex = protocolRateLimitSnapshot({
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
    const fallback = protocolRateLimitSnapshot({
      rateLimitReachedType: "workspace_owner_credits_depleted",
    });
    const resolved = await resolveUsageLimit(
      protocolRateLimitsResponse(fallback, { codex }),
    );
    assert.equal(resolved.error.code, "usage_limit_exceeded");
    assert.deepEqual(resolved.error.extensions, {
      xCodex: { resetAt: NOW + 90 },
    });

    const rolling = await resolveUsageLimit(
      protocolRateLimitsResponse(
        protocolRateLimitSnapshot({
          primary: {
            usedPercent: 99,
            windowDurationMins: 60,
            resetsAt: NOW + 45,
          },
        }),
        null,
      ),
    );
    assert.deepEqual(rolling.error.extensions, {
      xCodex: { resetAt: NOW + 45 },
    });
  } finally {
    vi.restoreAllMocks();
  }
});

/** Verifies a present malformed Codex bucket cannot be replaced by another limit. */
test("does not fall back from a malformed codex bucket", async () => {
  fixedClock();
  try {
    const fallback = protocolRateLimitSnapshot({
      primary: {
        usedPercent: 100,
        windowDurationMins: 60,
        resetsAt: NOW + 30,
      },
    });
    const resolved = await resolveUsageLimit({
      ...protocolRateLimitsResponse(fallback),
      rateLimitsByLimitId: { codex: "invalid" },
    });
    assert.deepEqual(resolved.error.extensions, {});
  } finally {
    vi.restoreAllMocks();
  }
});

/** Verifies malformed consumed fields cannot drive quota enrichment. */
test("keeps the default typed quota error for malformed consumed lookup fields", async () => {
  fixedClock();
  try {
    const resetWindow = {
      usedPercent: 100,
      windowDurationMins: 60,
      resetsAt: NOW + 30,
    };
    const enrichable = protocolRateLimitSnapshot({ primary: resetWindow });
    const selectedResponse = (codex: unknown): unknown => ({
      ...protocolRateLimitsResponse(enrichable),
      rateLimitsByLimitId: { codex },
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
        name: "invalid bucket container",
        create: () => ({
          ...protocolRateLimitsResponse(enrichable),
          rateLimitsByLimitId: "invalid",
        }),
      },
      {
        name: "array bucket container",
        create: () => ({
          ...protocolRateLimitsResponse(enrichable),
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
        name: "malformed spend-control snapshot",
        create: () =>
          selectedResponse({ ...enrichable, individualLimit: "invalid" }),
      },
      {
        name: "malformed spend-control flag",
        create: () =>
          selectedResponse({ ...enrichable, spendControlReached: "yes" }),
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

/** Verifies unconsumed response fields never disable quota enrichment. */
test("ignores unconsumed snapshot and response fields during enrichment", async () => {
  fixedClock();
  try {
    // Raw wire junk everywhere reset selection does not read: an unknown plan
    // tier, malformed credits and reset-credit rows, a malformed sibling
    // bucket, and a window missing its unconsumed duration.
    const snapshot = {
      limitId: 7,
      limitName: null,
      primary: { usedPercent: 100, resetsAt: NOW + 30 },
      secondary: null,
      credits: "malformed",
      individualLimit: null,
      spendControlReached: null,
      planType: "future_plan",
      rateLimitReachedType: "rate_limit_reached",
    };
    const resolved = await resolveUsageLimit({
      rateLimits: snapshot,
      rateLimitsByLimitId: { codex: snapshot, other: "invalid" },
      rateLimitResetCredits: { availableCount: "1", credits: ["junk"] },
    });
    assert.equal(resolved.error.code, "usage_limit_exceeded");
    assert.deepEqual(resolved.error.extensions, {
      xCodex: { resetAt: NOW + 30 },
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
      protocolRateLimitsResponse(
        protocolRateLimitSnapshot({ rateLimitReachedType }),
      ),
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
        protocolRateLimitsResponse(
          protocolRateLimitSnapshot({
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
        protocolRateLimitsResponse(
          protocolRateLimitSnapshot({
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
        protocolRateLimitsResponse(
          protocolRateLimitSnapshot({
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
