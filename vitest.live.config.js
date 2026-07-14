import { defineConfig } from "vitest/config";

/** Isolates opt-in live tests from the deterministic default suite. */
export default defineConfig({
  test: {
    include: ["test/**/*.live.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    watch: false,
  },
});
