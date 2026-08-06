import type { JsonRpcTransport } from "../app-server/json-rpc.js";
import { record } from "../core/canonical.js";
import { HttpError } from "./errors.js";

/** Resolves optional rate-limit details for one terminal usage-limit error. */
export interface UsageLimitErrorResolver {
  resolve(error: HttpError): Promise<HttpError>;
}

/** One validated backend classification plus its optional trustworthy reset. */
interface UsageLimitDetails {
  code:
    | "usage_limit_exceeded"
    | "insufficient_credits"
    | "workspace_usage_limit_exceeded";
  resetAt?: number;
  observedAt: number;
}

/** Backend classifications used by quota-to-HTTP translation. */
type KnownRateLimitReachedType =
  | "rate_limit_reached"
  | "workspace_owner_credits_depleted"
  | "workspace_member_credits_depleted"
  | "workspace_owner_usage_limit_reached"
  | "workspace_member_usage_limit_reached";

/** Known app-server account plan classifications. */
type KnownPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "self_serve_business_usage_based"
  | "business"
  | "ent26"
  | "enterprise_cbp_usage_based"
  | "enterprise"
  | "edu"
  | "unknown";

/** Validated rolling-window fields consumed by reset selection. */
interface RuntimeRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

/** Validated spend-control fields consumed by workspace reset selection. */
interface RuntimeSpendControlSnapshot {
  limit: string;
  used: string;
  remainingPercent: number;
  resetsAt: number;
}

/** Validated account-credit fields in one generated rate-limit snapshot. */
interface RuntimeCreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

/** Validated subset of one coherent generated rate-limit snapshot. */
interface RuntimeRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RuntimeRateLimitWindow | null;
  secondary: RuntimeRateLimitWindow | null;
  credits: RuntimeCreditsSnapshot | null;
  individualLimit: RuntimeSpendControlSnapshot | null;
  spendControlReached: boolean | null;
  planType: KnownPlanType | null;
  rateLimitReachedType: KnownRateLimitReachedType | null;
}

/** Validated earned-reset row retained only for response-shape validation. */
interface RuntimeRateLimitResetCredit {
  id: string;
  resetType: "codexRateLimits" | "unknown";
  status: "available" | "redeeming" | "redeemed" | "unknown";
  grantedAt: number;
  expiresAt: number | null;
  title: string | null;
  description: string | null;
}

/** Validated earned-reset summary in an account rate-limit response. */
interface RuntimeRateLimitResetCreditsSummary {
  availableCount: number | bigint;
  credits: RuntimeRateLimitResetCredit[] | null;
}

/** Fully validated generated account/rateLimits/read response. */
interface RuntimeAccountRateLimitsResponse {
  rateLimits: RuntimeRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RuntimeRateLimitSnapshot> | null;
  rateLimitResetCredits: RuntimeRateLimitResetCreditsSummary | null;
}

/** Recognizes the sole app-server TurnError that represents exhausted usage. */
export function usageLimitError(
  value: unknown,
  fallbackMessage: string,
): HttpError | undefined {
  const error = record(value);
  if (error?.codexErrorInfo !== "usageLimitExceeded") return undefined;
  return new HttpError(
    429,
    typeof error.message === "string" ? error.message : fallbackMessage,
    "rate_limit_error",
    "usage_limit_exceeded",
  );
}

/** Creates the request-scoped, abortable lookup for a terminal usage limit. */
export function usageLimitErrorResolver(
  rpc: JsonRpcTransport,
  signal: AbortSignal,
): UsageLimitErrorResolver {
  let details: Promise<UsageLimitDetails | undefined> | undefined;
  return {
    async resolve(error): Promise<HttpError> {
      if (
        error.status !== 429 ||
        error.type !== "rate_limit_error" ||
        error.code !== "usage_limit_exceeded"
      )
        return error;
      // A failed turn triggers one observational read only. The promise is
      // memoized before awaiting so duplicate terminal events cannot multiply it.
      details ??= readUsageLimitDetails(rpc, signal);
      const result = await details;
      return result
        ? new HttpError(
            error.status,
            error.message,
            error.type,
            result.code,
            error.param,
            result.resetAt === undefined
              ? {}
              : {
                  xCodex: { resetAt: result.resetAt },
                  responseHeaders: {
                    retryAfter: String(
                      Math.max(1, result.resetAt - result.observedAt),
                    ),
                  },
                },
          )
        : error;
    },
  };
}

/** Reads and validates quota metadata without allowing lookup failure to hide 429. */
async function readUsageLimitDetails(
  rpc: JsonRpcTransport,
  signal: AbortSignal,
): Promise<UsageLimitDetails | undefined> {
  try {
    const response = await rpc.request(
      "account/rateLimits/read",
      undefined,
      signal,
    );
    if (signal.aborted)
      throw signal.reason ?? new Error("rate-limit lookup cancelled");
    const now = Math.floor(Date.now() / 1_000);
    return selectUsageLimitDetails(response, now);
  } catch (error) {
    // An aborted HTTP request must retain cancellation semantics; ordinary
    // transport and malformed-result failures still expose the typed 429.
    if (signal.aborted) throw error;
    return undefined;
  }
}

/** Selects a reset and backend classification from a validated rate-limit response. */
function selectUsageLimitDetails(
  value: unknown,
  now: number,
): UsageLimitDetails | undefined {
  const response = accountRateLimitsResponse(value);
  if (!response) return undefined;
  const buckets = response.rateLimitsByLimitId;
  const snapshot =
    buckets && Object.hasOwn(buckets, "codex")
      ? buckets.codex!
      : response.rateLimits;
  const reached = snapshot.rateLimitReachedType;
  if (
    reached === "workspace_owner_credits_depleted" ||
    reached === "workspace_member_credits_depleted"
  )
    return { code: "insufficient_credits", observedAt: now };
  if (
    reached === "workspace_owner_usage_limit_reached" ||
    reached === "workspace_member_usage_limit_reached"
  ) {
    const reset =
      snapshot.spendControlReached === true
        ? futureUnix(snapshot.individualLimit?.resetsAt, now)
        : undefined;
    return reset
      ? { code: "usage_limit_exceeded", resetAt: reset, observedAt: now }
      : { code: "workspace_usage_limit_exceeded", observedAt: now };
  }
  if (reached !== "rate_limit_reached") return undefined;
  const windows = [snapshot.primary, snapshot.secondary];
  const exhausted = windows
    .filter((window) => window !== null && window.usedPercent >= 100)
    .map((window) => futureUnix(window?.resetsAt, now))
    .filter((reset): reset is number => reset !== undefined);
  const fallback = windows
    .map((window) => futureUnix(window?.resetsAt, now))
    .filter((reset): reset is number => reset !== undefined);
  const reset = Math.max(...(exhausted.length ? exhausted : fallback));
  return Number.isFinite(reset)
    ? { code: "usage_limit_exceeded", resetAt: reset, observedAt: now }
    : { code: "usage_limit_exceeded", observedAt: now };
}

/** Validates the complete generated account/rateLimits/read response shape. */
function accountRateLimitsResponse(
  value: unknown,
): RuntimeAccountRateLimitsResponse | undefined {
  const response = record(value);
  if (!response || !rateLimitSnapshot(response.rateLimits)) return undefined;
  const bucketsValue = response.rateLimitsByLimitId;
  const buckets = record(bucketsValue);
  if (
    bucketsValue !== null &&
    (!buckets || !Object.values(buckets).every(rateLimitSnapshot))
  )
    return undefined;
  if (!nullableResetCreditsSummary(response.rateLimitResetCredits))
    return undefined;
  return {
    rateLimits: response.rateLimits,
    rateLimitsByLimitId:
      bucketsValue === null
        ? null
        : (buckets as Record<string, RuntimeRateLimitSnapshot>),
    rateLimitResetCredits: response.rateLimitResetCredits,
  };
}

/** Validates the required quota fields of one selected generated snapshot. */
function rateLimitSnapshot(value: unknown): value is RuntimeRateLimitSnapshot {
  const snapshot = record(value);
  if (!snapshot) return false;
  return (
    nullableString(snapshot.limitId) &&
    nullableString(snapshot.limitName) &&
    nullableRateLimitWindow(snapshot.primary) &&
    nullableRateLimitWindow(snapshot.secondary) &&
    nullableCreditsSnapshot(snapshot.credits) &&
    nullableSpendControlSnapshot(snapshot.individualLimit) &&
    (typeof snapshot.spendControlReached === "boolean" ||
      snapshot.spendControlReached === null) &&
    (snapshot.planType === null || planType(snapshot.planType) !== undefined) &&
    (snapshot.rateLimitReachedType === null ||
      rateLimitReachedType(snapshot.rateLimitReachedType) !== undefined)
  );
}

/** Validates a nullable generated rolling-window snapshot. */
function nullableRateLimitWindow(
  value: unknown,
): value is RuntimeRateLimitWindow | null {
  if (value === null) return true;
  const window = record(value);
  return Boolean(
    window &&
    typeof window.usedPercent === "number" &&
    Number.isSafeInteger(window.usedPercent) &&
    (window.windowDurationMins === null ||
      (typeof window.windowDurationMins === "number" &&
        Number.isSafeInteger(window.windowDurationMins))) &&
    (window.resetsAt === null ||
      (typeof window.resetsAt === "number" &&
        Number.isSafeInteger(window.resetsAt))),
  );
}

/** Validates nullable generated account-credit state. */
function nullableCreditsSnapshot(
  value: unknown,
): value is RuntimeCreditsSnapshot | null {
  if (value === null) return true;
  const credits = record(value);
  return Boolean(
    credits &&
    typeof credits.hasCredits === "boolean" &&
    typeof credits.unlimited === "boolean" &&
    nullableString(credits.balance),
  );
}

/** Validates a nullable generated workspace spend-control snapshot. */
function nullableSpendControlSnapshot(
  value: unknown,
): value is RuntimeSpendControlSnapshot | null {
  if (value === null) return true;
  const limit = record(value);
  return Boolean(
    limit &&
    typeof limit.limit === "string" &&
    typeof limit.used === "string" &&
    typeof limit.remainingPercent === "number" &&
    Number.isSafeInteger(limit.remainingPercent) &&
    typeof limit.resetsAt === "number" &&
    Number.isSafeInteger(limit.resetsAt),
  );
}

/** Validates a nullable generated earned-reset summary and every detail row. */
function nullableResetCreditsSummary(
  value: unknown,
): value is RuntimeRateLimitResetCreditsSummary | null {
  if (value === null) return true;
  const summary = record(value);
  if (!summary || !nonnegativeCount(summary.availableCount)) return false;
  return (
    summary.credits === null ||
    (Array.isArray(summary.credits) &&
      summary.credits.every(rateLimitResetCredit))
  );
}

/** Validates one generated earned-reset detail row. */
function rateLimitResetCredit(
  value: unknown,
): value is RuntimeRateLimitResetCredit {
  const credit = record(value);
  return Boolean(
    credit &&
    typeof credit.id === "string" &&
    (credit.resetType === "codexRateLimits" ||
      credit.resetType === "unknown") &&
    (credit.status === "available" ||
      credit.status === "redeeming" ||
      credit.status === "redeemed" ||
      credit.status === "unknown") &&
    typeof credit.grantedAt === "number" &&
    Number.isSafeInteger(credit.grantedAt) &&
    (credit.expiresAt === null ||
      (typeof credit.expiresAt === "number" &&
        Number.isSafeInteger(credit.expiresAt))) &&
    nullableString(credit.title) &&
    nullableString(credit.description),
  );
}

/** Accepts a JSON count or defensive bigint when it is integral and nonnegative. */
function nonnegativeCount(value: unknown): value is number | bigint {
  return (
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "bigint" && value >= 0n)
  );
}

/** Validates a required nullable string field. */
function nullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

/** Accepts only a future safe-integer Unix timestamp. */
function futureUnix(value: unknown, now: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > now
    ? value
    : undefined;
}

/** Narrows an explicit backend rate-limit classification to known values. */
function rateLimitReachedType(
  value: unknown,
): KnownRateLimitReachedType | undefined {
  switch (value) {
    case "rate_limit_reached":
    case "workspace_owner_credits_depleted":
    case "workspace_member_credits_depleted":
    case "workspace_owner_usage_limit_reached":
    case "workspace_member_usage_limit_reached":
      return value;
    default:
      return undefined;
  }
}

/** Narrows one generated account plan classification. */
function planType(value: unknown): KnownPlanType | undefined {
  switch (value) {
    case "free":
    case "go":
    case "plus":
    case "pro":
    case "prolite":
    case "team":
    case "self_serve_business_usage_based":
    case "business":
    case "ent26":
    case "enterprise_cbp_usage_based":
    case "enterprise":
    case "edu":
    case "unknown":
      return value;
    default:
      return undefined;
  }
}
