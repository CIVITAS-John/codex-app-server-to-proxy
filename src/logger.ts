import type { LogLevel } from "./config.js";

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogWriter = (entry: Record<string, unknown>) => void;

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

function defaultWriter(entry: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export type Logger = ReturnType<typeof createLogger>;
