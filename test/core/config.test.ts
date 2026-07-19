import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, realpath, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { test } from "vitest";
import {
  LOG_LEVELS,
  normalizeLoopbackHost,
  parseServeOptions,
  resolveServeOptions,
} from "../../src/core/config.js";
import { withTempDir } from "../support/temp.js";

test("loopback validation accepts only exact safe forms", () => {
  assert.equal(normalizeLoopbackHost("127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeLoopbackHost("::1"), "::1");
  assert.equal(normalizeLoopbackHost("LOCALHOST"), "127.0.0.1");
  for (const host of [
    "0.0.0.0",
    "::",
    "192.168.1.2",
    "example.test",
    "127.0.0.2",
    "::ffff:127.0.0.1",
    "[::1]",
    "localhost.",
  ]) {
    assert.throws(
      () => normalizeLoopbackHost(host),
      /Only 127\.0\.0\.1, ::1, and localhost/,
    );
  }
});

test("log-level validation accepts every supported value and rejects others", () => {
  for (const logLevel of LOG_LEVELS)
    assert.equal(
      parseServeOptions(["--log-level", logLevel]).logLevel,
      logLevel,
    );
  assert.throws(
    () => parseServeOptions(["--log-level", "verbose"]),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "--log-level must be debug, info, warn, or error.",
  );
});

test("durations cap at the maximum Node timer delay", () => {
  // Larger values overflow Node timers and fire immediately instead of later.
  const maximum = 2 ** 31 - 1;
  assert.equal(
    parseServeOptions(["--tool-timeout", `${maximum}ms`]).toolTimeoutMs,
    maximum,
  );
  assert.throws(
    () => parseServeOptions(["--tool-timeout", `${maximum + 1}ms`]),
    /--tool-timeout must be between 1ms and 2147483647ms\./,
  );
  assert.throws(
    () => parseServeOptions(["--request-timeout", "40000m"]),
    /--request-timeout must be between 1ms and 2147483647ms\./,
  );
});

test("serve options have safe documented defaults and reject ambiguity", async () => {
  const canonicalHome = realpathSync(homedir());
  await withTempDir(async (directory) => {
    const project = join(directory, "project");
    const projectLink = join(directory, "project-link");
    await mkdir(project);
    await symlink(project, projectLink, "dir");
    // Match the promise-based canonicalization used by resolveServeOptions;
    // Windows may spell the same path differently in sync and async realpath.
    const canonicalProject = await realpath(project);
    const parsed = parseServeOptions([], project);
    assert.equal(parsed.host, "127.0.0.1");
    assert.equal(parsed.port, 8787);
    assert.equal(parsed.root, project);
    assert.equal(parsed.toolTimeoutMs, 300_000);
    assert.equal(parsed.implicitToolContinuation, true);
    assert.equal(parsed.stateDir, undefined);
    const finalized = await resolveServeOptions(parsed);
    // The default state directory is namespaced under the canonical home path
    // and is lexically outside this canonical project root.
    assert.ok(
      finalized.stateDir.startsWith(
        join(canonicalHome, ".codex-openai-proxy") + sep,
      ),
    );
    assert.equal(
      finalized.stateDir.startsWith(`${canonicalProject}${sep}`),
      false,
    );

    const explicit = parseServeOptions(
      ["--root", projectLink, "--state-dir", "state"],
      "/",
    );
    assert.equal(explicit.stateDir, "state");
    const resolvedExplicit = await resolveServeOptions(explicit);
    assert.equal(resolvedExplicit.root, canonicalProject);
    assert.equal(resolvedExplicit.stateDir, join(canonicalProject, "state"));
    assert.equal(
      (
        await resolveServeOptions(
          parseServeOptions(["--root", projectLink], "/"),
        )
      ).stateDir,
      finalized.stateDir,
    );

    await assert.rejects(
      resolveServeOptions(parseServeOptions([], homedir())),
      /default --state-dir falls inside --root/,
    );
    assert.throws(
      () => parseServeOptions(["--port", "80", "--port", "81"]),
      /Duplicate/,
    );
    assert.throws(() => parseServeOptions(["--unknown", "x"]), /Unknown/);
    assert.equal(
      parseServeOptions(["--implicit-tool-continuation", "false"])
        .implicitToolContinuation,
      false,
    );
    assert.throws(
      () => parseServeOptions(["--implicit-tool-continuation", "yes"]),
      /true or false/,
    );
  }, "codex-config-test-");
});
