import type { LogLevel } from "./config.js";
import { redact } from "./redact.js";

/** Numeric severity ordering used for log filtering. */
const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Receives one structured log entry. */
export type LogWriter = (entry: Record<string, unknown>) => void;

/** Creates a structured logger filtered at the configured level. */
export function createLogger(
  level: LogLevel,
  write: LogWriter = defaultWriter,
) {
  return (
    entryLevel: LogLevel,
    event: string,
    fields: Record<string, unknown> = {},
  ): void => {
    if (priorities[entryLevel] < priorities[level]) return;
    write({
      time: new Date().toISOString(),
      level: entryLevel,
      event,
      ...fields,
    });
  };
}

/** Writes structured logs to stderr as newline-delimited JSON. */
function defaultWriter(entry: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

/** Structured logger returned by createLogger. */
export type Logger = ReturnType<typeof createLogger>;

/**
 * Logs a failure so default `info` deployments still get a diagnostic: a
 * redacted error summary at `error` level, plus the full untrimmed detail at
 * `debug`. The redaction keeps the configured root and other local paths out of
 * the always-visible entry while preserving them under `--log-level debug`.
 */
export function logFailure(
  log: Logger,
  event: string,
  fields: Record<string, unknown>,
  error: unknown,
  root: string,
): void {
  const message = error instanceof Error ? error.message : String(error);
  log("error", event, { ...fields, error: redact(message, root) });
  log("debug", `${event}_detail`, { ...fields, error: message });
}
