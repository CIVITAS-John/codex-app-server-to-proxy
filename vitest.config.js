import { defineConfig } from "vitest/config";

/** Keeps local coverage on by default while allowing non-primary CI jobs to opt out. */
const coverageEnabled = process.env.CODEX_TEST_COVERAGE !== "0";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.live.test.ts"],
    watch: false,
    coverage: {
      enabled: coverageEnabled,
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/bin.ts"],
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      thresholds: {
        branches: 79,
        functions: 83,
        lines: 83,
        statements: 80,
      },
    },
  },
});
