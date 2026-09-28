import { parseSseFrames } from "./http.js";

/** Reads a contract response and optionally reports only its public token counts. */
export async function readContractResponse(
  response: Response,
  requestNumber?: number,
): Promise<string> {
  const raw = await response.text();
  if (requestNumber !== undefined && response.ok) {
    const streaming = response.headers
      .get("content-type")
      ?.includes("text/event-stream");
    const prefix = `[live] usage request=${requestNumber} format=${streaming ? "sse" : "json"}`;
    let usage: Record<string, unknown> | undefined;
    try {
      if (streaming) {
        const frames = parseSseFrames(raw);
        if (frames.at(-1) !== "[DONE]") {
          console.info(`${prefix} unavailable=incomplete_stream`);
          return raw;
        }
        // Usage may precede the finish reason. Keep the final reported value,
        // never sum cumulative snapshots or assume a fixed chunk position.
        for (const frame of frames.slice(0, -1)) {
          const chunk = record(JSON.parse(frame));
          if (chunk?.error) {
            console.info(`${prefix} unavailable=stream_error`);
            return raw;
          }
          if (record(chunk?.usage)) usage = record(chunk?.usage);
        }
      } else {
        usage = record(record(JSON.parse(raw))?.usage);
      }
    } catch {
      // Leave response validation to the contract without echoing live payloads.
      console.info(`${prefix} unavailable=invalid_json`);
      return raw;
    }
    console.info(
      `${prefix} input_tokens=${count(usage?.prompt_tokens)}` +
        ` output_tokens=${count(usage?.completion_tokens)}` +
        ` cached_input_tokens=${count(record(usage?.prompt_tokens_details)?.cached_tokens)}` +
        ` reasoning_tokens=${count(record(usage?.completion_tokens_details)?.reasoning_tokens)}` +
        ` total_tokens=${count(usage?.total_tokens)}`,
    );
  }
  return raw;
}

/** Narrows untrusted HTTP values without including their contents in diagnostics. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Preserves exact zero while keeping absent or invalid counts visibly unavailable. */
function count(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : "unreported";
}
