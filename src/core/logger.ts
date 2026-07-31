import type { LogLevel } from "./config.js";

/** Numeric severity ordering used for log filtering. */
const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Receives one structured log entry. */
export type LogWriter = (entry: Record<string, unknown>) => void;

/** Structured logger with plain failure reporting. */
export interface Logger {
  (entryLevel: LogLevel, event: string, fields?: Record<string, unknown>): void;
  failure(event: string, fields: Record<string, unknown>, error: unknown): void;
}

/** Writes an unconfigured startup failure using the standard log envelope. */
export function writeStartupError(error: unknown): void {
  defaultWriter({
    time: new Date().toISOString(),
    level: "error",
    event: "startup_failed",
    error: error instanceof Error ? error.message : String(error),
  });
}

/** Creates a structured logger filtered at the configured level. */
export function createLogger(
  level: LogLevel,
  write: LogWriter = defaultWriter,
): Logger {
  const log = ((
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
  }) as Logger;
  log.failure = (
    event: string,
    fields: Record<string, unknown>,
    error: unknown,
  ): void => {
    const message = error instanceof Error ? error.message : String(error);
    log("error", event, { ...fields, error: message });
  };
  return log;
}

/** Writes structured logs to stderr as newline-delimited JSON. */
function defaultWriter(entry: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}
