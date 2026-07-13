import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import {
  type ContinuationMapping,
  preflightContinuation,
} from "../src/continuation.js";
import { HttpError } from "../src/errors.js";

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
    const mapping: ContinuationMapping = {
      responseId: "chatcmpl_codex_test",
      threadId: "thr_1",
      state:
        entry.case === "resume_race"
          ? "ready"
          : (entry.case as ContinuationMapping["state"]),
    };
    const mappings =
      entry.case === "unknown"
        ? new Map<string, ContinuationMapping>()
        : new Map([[mapping.responseId, mapping]]);
    const before = JSON.stringify([...mappings]);
    let resumeCalls = 0;
    let startCalls = 0;
    const appServer = {
      resume() {
        resumeCalls += 1;
        return "not_resumable" as const;
      },
      start() {
        startCalls += 1;
      },
    };

    assert.throws(
      () => preflightContinuation(mapping.responseId, mappings, appServer),
      (error: unknown) => {
        assert(error instanceof HttpError);
        assert.equal(error.status, entry.status);
        assert.equal(error.code, entry.code);
        assert.equal(
          error.type,
          entry.status >= 500
            ? "server_error"
            : entry.status === 409
              ? "conflict_error"
              : "invalid_request_error",
        );
        return true;
      },
    );
    assert.equal(JSON.stringify([...mappings]), before);
    assert.equal(resumeCalls, entry.case === "resume_race" ? 1 : 0);
    assert.equal(startCalls, 0);
  }
});

test("a resumable continuation returns its existing mapping", () => {
  const mapping: ContinuationMapping = {
    responseId: "chatcmpl_codex_test",
    threadId: "thr_1",
    state: "ready",
  };
  const result = preflightContinuation(
    mapping.responseId,
    new Map([[mapping.responseId, mapping]]),
    { resume: () => "resumable" },
  );
  assert.equal(result, mapping);
});
