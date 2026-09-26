import { afterEach, vi } from "vitest";

/** Skips idle waiting except in tests explicitly exercising delayed wire reads. */
const offlineUsageTiming = vi.hoisted(() => ({ idleGraceMs: 0 }));

export { offlineUsageTiming };

vi.mock("../../src/http/chat-timing.js", () => ({
  get IDLE_USAGE_GRACE_MS() {
    return offlineUsageTiming.idleGraceMs;
  },
}));

afterEach(() => {
  offlineUsageTiming.idleGraceMs = 0;
});
