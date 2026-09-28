import type { JsonRpcTransport } from "../../src/app-server/json-rpc.js";
import { createLogger } from "../../src/core/logger.js";

/** Counter order shared by upstream snapshots and the public usage comparison. */
const COUNTERS = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "reasoningOutputTokens",
  "totalTokens",
] as const;

/** Bounded numeric projection; unknown counters remain absent. */
type Counts = Partial<Record<(typeof COUNTERS)[number], number>>;

/** One sanitized usage notification retained until its root turn is identified. */
interface Observation {
  threadId: unknown;
  turnId: unknown;
  responseId?: unknown;
  kind: "raw" | "thread";
  counts: Counts;
  total?: Counts;
}

/** State for one serial live HTTP request, including events preceding turn/start's reply. */
interface RequestDiagnostics {
  requestedEffort: string;
  threadEffort: string;
  turnEffort: string;
  threadId?: unknown;
  turnId?: unknown;
  requestId?: unknown;
  source: string;
  observations: Observation[];
  dropped: number;
}

/** Captures numeric app-server evidence for the serial live contract, without extra RPCs. */
export class LiveUsageDiagnostics {
  #active: RequestDiagnostics | undefined;

  /** Selects only the existing final-usage diagnostic, never forwarding other logs. */
  readonly log = createLogger("debug", (entry) => {
    if (entry.event !== "usage_collection_completed" || !this.#active) return;
    this.#active.requestId = entry.request_id;
    this.#active.source = [
      "raw_response",
      "thread_token_usage",
      "none",
    ].includes(String(entry.usage_source))
      ? String(entry.usage_source)
      : "unreported";
  });

  /** Observes the existing transport while preserving its requests and results. */
  constructor(rpc: JsonRpcTransport) {
    const request = rpc.request.bind(rpc);
    rpc.request = (method, params, signal) => {
      const active = this.#active;
      if (method === "turn/start" && active) {
        active.threadId = record(params)?.threadId;
        active.turnEffort = effort(record(params)?.effort);
      }
      return request(method, params, signal).then((result) => {
        if (!active || active !== this.#active) return result;
        if (method === "thread/start" || method === "thread/resume")
          active.threadEffort = effort(record(result)?.reasoningEffort);
        if (method === "turn/start")
          active.turnId = record(record(result)?.turn)?.id;
        return result;
      });
    };
    rpc.on("notification", (method, params: unknown) =>
      this.#observe(method, params),
    );
  }

  /** Begins an isolated observation window before the contract sends its next request. */
  begin(body: Record<string, unknown>): void {
    this.#active = {
      requestedEffort:
        body.reasoning_effort === undefined
          ? "omitted"
          : effort(body.reasoning_effort),
      threadEffort: "unreported",
      turnEffort: "unreported",
      source: "unreported",
      observations: [],
      dropped: 0,
    };
  }

  /** Keeps a capped numeric projection, excluding provider metadata and response content. */
  #observe(method: string, params: unknown): void {
    const active = this.#active;
    if (
      !active ||
      (method !== "rawResponse/completed" &&
        method !== "thread/tokenUsage/updated")
    )
      return;
    if (active.observations.length >= 128) {
      active.dropped += 1;
      return;
    }
    const value = record(params);
    const tokenUsage = record(value?.tokenUsage);
    active.observations.push({
      threadId: value?.threadId,
      turnId: value?.turnId,
      ...(method === "rawResponse/completed"
        ? { responseId: value?.responseId }
        : {}),
      kind: method === "rawResponse/completed" ? "raw" : "thread",
      counts: counts(
        method === "rawResponse/completed" ? value?.usage : tokenUsage?.last,
      ),
      ...(method === "thread/tokenUsage/updated"
        ? { total: counts(tokenUsage?.total) }
        : {}),
    });
  }

  /** Prints root-turn evidence beside the HTTP report, with explicit comparison limits. */
  report(response: Response, requestNumber: number, usage: unknown): void {
    const active = this.#active;
    this.#active = undefined;
    const prefix = `[live] usage-evidence request=${requestNumber}`;
    // The contract is serial, but confirm the server's request ID before using
    // its selected source. Raw thread/turn IDs are only used for correlation.
    if (
      !active ||
      typeof active.threadId !== "string" ||
      typeof active.turnId !== "string" ||
      active.requestId !== response.headers.get("x-request-id")
    ) {
      console.info(`${prefix} unavailable=uncorrelated`);
      return;
    }
    const root = active.observations.filter(
      (item) =>
        item.threadId === active.threadId && item.turnId === active.turnId,
    );
    const raw = new Map<unknown, Counts>();
    let duplicates = 0;
    let unidentified = 0;
    for (const item of root.filter((item) => item.kind === "raw")) {
      if (typeof item.responseId !== "string" || !item.responseId) {
        unidentified += 1;
        continue;
      }
      if (raw.has(item.responseId)) duplicates += 1;
      else raw.set(item.responseId, item.counts);
    }
    const updates = root.filter((item) => item.kind === "thread");
    const effective =
      active.turnEffort !== "unreported"
        ? active.turnEffort
        : active.threadEffort;
    const evidence =
      active.turnEffort !== "unreported"
        ? "turn_override"
        : active.threadEffort !== "unreported"
          ? "thread_response"
          : "unreported";
    console.info(
      `${prefix} source=${active.source} requested_effort=${active.requestedEffort} thread_effort=${active.threadEffort} effective_effort=${effective} effort_evidence=${evidence} raw_responses=${raw.size} duplicates=${duplicates} thread_updates=${updates.length} excluded_events=${active.observations.length - root.length} dropped_events=${active.dropped} unidentified_raw=${unidentified}`,
    );
    let index = 0;
    for (const value of raw.values())
      console.info(`${prefix} raw_response=${++index} ${formatCounts(value)}`);
    const sum: Counts = {};
    if (raw.size && !unidentified && !active.dropped) {
      for (const key of COUNTERS) {
        const values = [...raw.values()].map((value) => value[key]);
        if (values.every((value) => value !== undefined)) {
          const total = values.reduce((left, right) => left + right, 0);
          if (Number.isSafeInteger(total)) sum[key] = total;
        }
      }
    }
    const http = record(usage);
    const httpCounts = counts({
      inputTokens: http?.prompt_tokens,
      outputTokens: http?.completion_tokens,
      cachedInputTokens: record(http?.prompt_tokens_details)?.cached_tokens,
      reasoningOutputTokens: record(http?.completion_tokens_details)
        ?.reasoning_tokens,
      totalTokens: http?.total_tokens,
    });
    console.info(
      `${prefix} raw_sum ${formatCounts(sum)} http_comparison=${compare(sum, httpCounts)} reasoning_comparison=${compare(sum, httpCounts, ["reasoningOutputTokens"])}`,
    );
    // Thread totals are cumulative; print them separately rather than comparing
    // them directly to one HTTP request or adding successive update snapshots.
    console.info(
      `${prefix} thread_last ${formatCounts(updates.at(-1)?.counts ?? {})}`,
    );
    console.info(
      `${prefix} thread_total ${formatCounts(updates.at(-1)?.total ?? {})}`,
    );
  }
}

/** Reads an object without coercing arbitrary payloads into log strings. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Whitelists effort values without exposing unexpected settings. */
function effort(value: unknown): string {
  return typeof value === "string" &&
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
    ? value
    : "unreported";
}

/** Copies exact counters only; missing details never become zero. */
function counts(value: unknown): Counts {
  const source = record(value);
  return Object.fromEntries(
    COUNTERS.flatMap((key) => {
      const value = source?.[key];
      return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
        ? [[key, value]]
        : [];
    }),
  );
}

/** Renders only fixed field names and numeric or unavailable counter values. */
function formatCounts(value: Counts): string {
  return `input_tokens=${value.inputTokens ?? "unreported"} output_tokens=${value.outputTokens ?? "unreported"} cached_input_tokens=${value.cachedInputTokens ?? "unreported"} reasoning_tokens=${value.reasoningOutputTokens ?? "unreported"} total_tokens=${value.totalTokens ?? "unreported"}`;
}

/** Compares reported counters without claiming that missing evidence agrees. */
function compare(
  left: Counts,
  right: Counts,
  keys: readonly (keyof Counts)[] = COUNTERS,
): string {
  if (
    keys.some(
      (key) =>
        left[key] !== undefined &&
        right[key] !== undefined &&
        left[key] !== right[key],
    )
  )
    return "mismatch";
  return keys.every(
    (key) => left[key] !== undefined && right[key] !== undefined,
  )
    ? "match"
    : "unavailable";
}
