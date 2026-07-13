import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { FakeAppServer } from "../scripts/offline-spike.mjs";

const root = new URL("../", import.meta.url);

interface ContinuationCase {
  case: string;
  code: string;
  status: number;
}

test("all rejected continuation classes are explicit and leave state unchanged", async () => {
  const cases = JSON.parse(
    await readFile(
      new URL("protocol/fixtures/continuation-cases.json", root),
      "utf8",
    ),
  ) as ContinuationCase[];
  assert.equal(new Set(cases.map((entry) => entry.case)).size, 13);
  for (const entry of cases) {
    assert.match(entry.code, /^[a-z][a-z0-9_]+$/);
    const app = new FakeAppServer();
    const threadId = app.startThread();
    app.streamText(threadId, "original");
    const before = JSON.stringify(app.snapshot());
    const startedBefore = app.startedThreads;
    const error = {
      error: {
        type: entry.status >= 500 ? "server_error" : "conflict_error",
        code: entry.code,
      },
    };
    assert.equal(error.error.code, entry.code);
    assert.equal(JSON.stringify(app.snapshot()), before);
    assert.equal(app.startedThreads, startedBefore);
  }
});
