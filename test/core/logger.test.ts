import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { createLogger } from "../../src/core/logger.js";

test("logger failures write one plain error entry", () => {
  const path = join("private", "workspace", "file.ts");
  const entries: Record<string, unknown>[] = [];
  const log = createLogger("debug", (entry) => entries.push(entry));

  log.failure("widget_failed", { attempt: 1 }, new Error(`boom at ${path}`));

  assert.deepEqual(entries, [
    {
      time: entries[0]?.time,
      level: "error",
      event: "widget_failed",
      attempt: 1,
      error: `boom at ${path}`,
    },
  ]);
});
