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
}

/** Backend classifications used by quota-to-HTTP translation. */
type KnownRateLimitReachedType =
  | "rate_limit_reached"
  | "workspace_owner_credits_depleted"
  | "workspace_member_credits_depleted"
  | "workspace_owner_usage_limit_reached"
  | "workspace_member_usage_limit_reached";

/** Validated rolling-window fields consumed by reset selection. */
interface RuntimeRateLimitWindow {
  usedPercent: number;
  resetsAt: number | null;
}

/**
 * The consumed subset of one generated rate-limit snapshot. Like the model
 * catalog, only the fields reset selection reads are validated, so unfamiliar
 * metadata or new generated enum members never disable quota enrichment.
 */
interface RuntimeRateLimitSnapshot {
  primary: RuntimeRateLimitWindow | null;
  secondary: RuntimeRateLimitWindow | null;
  individualLimit: { resetsAt: number } | null;
  spendControlReached: boolean | null;
  rateLimitReachedType: unknown;
}

/** Recognizes the sole app-server TurnError that represents exhausted usage. */
export function usageLimitError(
  error: Record<string, unknown> | undefined,
  message: string,
): HttpError | undefined {
  if (error?.codexErrorInfo !== "usageLimitExceeded") return undefined;
  return new HttpError(
    429,
    message,
    "rate_limit_error",
    "usage_limit_exceeded",
  );
}

/** Recognizes a quota rate-limit error across its pre- and post-lookup codes. */
export function isUsageLimitError(error: unknown): error is HttpError {
  return (
    error instanceof HttpError &&
    error.status === 429 &&
    error.type === "rate_limit_error"
  );
}

/** Creates the request-scoped, abortable lookup for a terminal usage limit. */
export function usageLimitErrorResolver(
  rpc: Pick<JsonRpcTransport, "request">,
  signal: AbortSignal,
): UsageLimitErrorResolver {
  let details: Promise<UsageLimitDetails | undefined> | undefined;
  return {
    async resolve(error): Promise<HttpError> {
      if (!isUsageLimitError(error) || error.code !== "usage_limit_exceeded")
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
              : { xCodex: { resetAt: result.resetAt } },
          )
        : error;
    },
  };
}

/** Reads and validates quota metadata without allowing lookup failure to hide 429. */
async function readUsageLimitDetails(
  rpc: Pick<JsonRpcTransport, "request">,
  signal: AbortSignal,
): Promise<UsageLimitDetails | undefined> {
  try {
    const response = await rpc.request(
      "account/rateLimits/read",
      undefined,
      signal,
    );
    if (signal.aborted) throw signal.reason;
    return selectUsageLimitDetails(response, Math.floor(Date.now() / 1_000));
  } catch (error) {
    // An aborted HTTP request must retain cancellation semantics; ordinary
    // transport and malformed-result failures still expose the typed 429.
    if (signal.aborted) throw error;
    return undefined;
  }
}

/** Selects a reset and backend classification from one validated snapshot. */
function selectUsageLimitDetails(
  value: unknown,
  now: number,
): UsageLimitDetails | undefined {
  const snapshot = selectSnapshot(value);
  if (!snapshot) return undefined;
  const reached = rateLimitReachedType(snapshot.rateLimitReachedType);
  if (
    reached === "workspace_owner_credits_depleted" ||
    reached === "workspace_member_credits_depleted"
  )
    return { code: "insufficient_credits" };
  if (
    reached === "workspace_owner_usage_limit_reached" ||
    reached === "workspace_member_usage_limit_reached"
  ) {
    const reset =
      snapshot.spendControlReached === true
        ? futureUnix(snapshot.individualLimit?.resetsAt, now)
        : undefined;
    return reset
      ? { code: "usage_limit_exceeded", resetAt: reset }
      : { code: "workspace_usage_limit_exceeded" };
  }
  if (reached !== "rate_limit_reached") return undefined;
  const windows = [snapshot.primary, snapshot.secondary];
  const exhausted = futureResets(
    windows.filter((window) => (window?.usedPercent ?? 0) >= 100),
    now,
  );
  const candidates = exhausted.length ? exhausted : futureResets(windows, now);
  // No future reset leaves the already-typed 429 unchanged.
  return candidates.length
    ? { code: "usage_limit_exceeded", resetAt: Math.max(...candidates) }
    : undefined;
}

/** Collects the future reset instants from a set of rolling windows. */
function futureResets(
  windows: Array<RuntimeRateLimitWindow | null>,
  now: number,
): number[] {
  return windows
    .map((window) => futureUnix(window?.resetsAt, now))
    .filter((reset): reset is number => reset !== undefined);
}

/**
 * Prefers the codex bucket over the top-level snapshot and validates only the
 * selected snapshot's consumed fields. A present-but-malformed codex bucket
 * yields no enrichment rather than silently falling back to another limit.
 */
function selectSnapshot(value: unknown): RuntimeRateLimitSnapshot | undefined {
  const response = record(value);
  if (!response) return undefined;
  let selected: unknown = response.rateLimits;
  if (response.rateLimitsByLimitId !== null) {
    const buckets = record(response.rateLimitsByLimitId);
    if (!buckets) return undefined;
    if (Object.hasOwn(buckets, "codex")) selected = buckets.codex;
  }
  return rateLimitSnapshot(selected) ? selected : undefined;
}

/** Validates only the consumed quota fields of one selected snapshot. */
function rateLimitSnapshot(value: unknown): value is RuntimeRateLimitSnapshot {
  const snapshot = record(value);
  if (!snapshot) return false;
  return (
    nullableRateLimitWindow(snapshot.primary) &&
    nullableRateLimitWindow(snapshot.secondary) &&
    nullableSpendControlReset(snapshot.individualLimit) &&
    (typeof snapshot.spendControlReached === "boolean" ||
      snapshot.spendControlReached === null)
  );
}

/** Validates the consumed fields of a nullable rolling-window snapshot. */
function nullableRateLimitWindow(
  value: unknown,
): value is RuntimeRateLimitWindow | null {
  if (value === null) return true;
  const window = record(value);
  return Boolean(
    window &&
    typeof window.usedPercent === "number" &&
    Number.isSafeInteger(window.usedPercent) &&
    (window.resetsAt === null ||
      (typeof window.resetsAt === "number" &&
        Number.isSafeInteger(window.resetsAt))),
  );
}

/** Validates the consumed reset instant of a nullable spend-control snapshot. */
function nullableSpendControlReset(
  value: unknown,
): value is { resetsAt: number } | null {
  if (value === null) return true;
  const limit = record(value);
  return Boolean(
    limit &&
    typeof limit.resetsAt === "number" &&
    Number.isSafeInteger(limit.resetsAt),
  );
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
