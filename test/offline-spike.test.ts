import assert from "node:assert/strict";
import { test } from "vitest";
import { runOfflineSpike } from "../scripts/offline-spike.mjs";

test("offline spike covers text, two-request tool flow, and restart", () => {
  assert.deepEqual(runOfflineSpike(), {
    modelCalls: 0,
    threadId: "thr_1",
    resumedAfterRestart: true,
    toolRoundTrip: true,
  });
});
