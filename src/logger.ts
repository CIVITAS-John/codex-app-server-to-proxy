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
