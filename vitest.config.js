import { defineConfig } from "vitest/config";

/** Keeps local coverage on by default while allowing non-primary CI jobs to opt out. */
const coverageEnabled = process.env.CODEX_TEST_COVERAGE !== "0";

/**
 * The recorded floors describe a complete offline run. Windows skips the
 * POSIX-only fixture, permission, and executable suites, so measuring its
 * partial run against them fails `npm run check` for reasons unrelated to the
 * change under test. Report coverage everywhere and enforce the floors only
 * where the complete suite runs, which is the primary Linux coverage job.
 */
const thresholdsEnforced = coverageEnabled && process.platform !== "win32";

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
      ...(thresholdsEnforced
        ? {
            thresholds: {
              branches: 79,
              functions: 83,
              lines: 83,
              statements: 80,
            },
          }
        : {}),
    },
  },
});
