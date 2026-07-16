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

/** Paths that default-visible failure summaries must mask. */
export interface RedactionContext {
  root: string;
  sensitivePaths: readonly string[];
}

/** Structured logger with failure reporting bound to one redaction context. */
export interface Logger {
  (entryLevel: LogLevel, event: string, fields?: Record<string, unknown>): void;
  failure(event: string, fields: Record<string, unknown>, error: unknown): void;
}

/** Creates a structured logger filtered at the configured level. */
export function createLogger(
  level: LogLevel,
  write: LogWriter = defaultWriter,
  redaction: RedactionContext = { root: "", sensitivePaths: [] },
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
    log("error", event, {
      ...fields,
      error: redact(message, redaction.root, redaction.sensitivePaths),
    });
    log("debug", `${event}_detail`, { ...fields, error: message });
  };
  return log;
}

/** Writes structured logs to stderr as newline-delimited JSON. */
function defaultWriter(entry: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}
