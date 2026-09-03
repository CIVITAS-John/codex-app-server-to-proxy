import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, realpath, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, test, vi } from "vitest";
import {
  LOG_LEVELS,
  LOGIN_MODES,
  SYNC_AUTH_MODES,
  isInteractiveLogin,
  normalizeLoopbackHost,
  parseServeOptions,
  resolveServeOptions,
} from "../../src/core/config.js";
import { withTempDir } from "../support/temp.js";

/** Preserves the Windows profile path replaced for constrained test hosts. */
const originalWindowsUserProfile = vi.hoisted(() => {
  if (process.platform !== "win32") return undefined;
  const original = process.env.USERPROFILE;
  // A test worker cannot asynchronously read the real profile in the Windows
  // sandbox. Set this before config imports `homedir` so default-path checks
  // use the readable workspace root instead.
  process.env.USERPROFILE = process.cwd();
  return original;
});

/** Restores the caller's Windows profile after this test module completes. */
afterAll(() => {
  if (process.platform !== "win32") return;
  if (originalWindowsUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalWindowsUserProfile;
});

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

test("sync-auth validation defaults to always and accepts supported modes", () => {
  assert.equal(parseServeOptions([]).syncAuth, "always");
  for (const syncAuth of SYNC_AUTH_MODES)
    assert.equal(
      parseServeOptions(["--sync-auth", syncAuth]).syncAuth,
      syncAuth,
    );
  assert.throws(
    () => parseServeOptions(["--sync-auth", "if-missing"]),
    /--sync-auth must be always or never\./,
  );
});

test("login validation defaults to auto and accepts supported modes", () => {
  assert.equal(parseServeOptions([]).loginMode, "auto");
  for (const loginMode of LOGIN_MODES)
    assert.equal(
      parseServeOptions(["--login", loginMode]).loginMode,
      loginMode,
    );
  assert.throws(
    () => parseServeOptions(["--login", "if-needed"]),
    /--login must be auto, device-code, or browser\./,
  );
});

test("subagents default off and require an explicit boolean opt-in", () => {
  assert.equal(parseServeOptions([]).subagentsEnabled, false);
  assert.equal(
    parseServeOptions(["--subagents", "true"]).subagentsEnabled,
    true,
  );
  assert.equal(
    parseServeOptions(["--subagents=false"]).subagentsEnabled,
    false,
  );
  assert.throws(
    () => parseServeOptions(["--subagents", "yes"]),
    /--subagents must be true or false\./,
  );
});

test("login interactivity follows the selected mode", () => {
  for (const [mode, stderrIsTty, expected] of [
    ["auto", true, true],
    ["auto", false, false],
    ["browser", true, true],
    ["browser", false, true],
    ["device-code", true, false],
    ["device-code", false, false],
  ] as const)
    assert.equal(isInteractiveLogin(mode, stderrIsTty), expected);
});

test("durations cap at the maximum Node timer delay", () => {
  // Larger values overflow Node timers and fire immediately instead of later.
  const maximum = 2 ** 31 - 1;
  assert.equal(
    parseServeOptions(["--request-timeout", `${maximum}ms`]).requestTimeoutMs,
    maximum,
  );
  assert.throws(
    () => parseServeOptions(["--request-timeout", `${maximum + 1}ms`]),
    /--request-timeout must be between 1ms and 2147483647ms\./,
  );
  assert.throws(
    () => parseServeOptions(["--request-timeout", "40000m"]),
    /--request-timeout must be between 1ms and 2147483647ms\./,
  );
});

test("the removed tool-timeout and usage-grace options are rejected as unknown", () => {
  // Dynamic tool calls end their turn immediately, so neither deadline exists;
  // rejecting the flags loudly beats silently accepting a no-op.
  assert.throws(
    () => parseServeOptions(["--tool-timeout", "5m"]),
    /Unknown option: --tool-timeout\./,
  );
  assert.throws(
    () => parseServeOptions(["--usage-grace", "12s"]),
    /Unknown option: --usage-grace\./,
  );
});

test("serve options have safe documented defaults and reject ambiguity", async () => {
  const canonicalHome = realpathSync(homedir());
  await withTempDir(async (directory) => {
    const project = join(directory, "project");
    const projectLink = join(directory, "project-link");
    await mkdir(project);
    await symlink(
      project,
      projectLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    // Match the promise-based canonicalization used by resolveServeOptions;
    // Windows may spell the same path differently in sync and async realpath.
    const canonicalProject = await realpath(project);
    const parsed = parseServeOptions([], project);
    assert.equal(parsed.host, "127.0.0.1");
    assert.equal(parsed.port, 8787);
    assert.equal(parsed.root, project);
    assert.equal(parsed.subagentsEnabled, false);
    assert.equal(parsed.implicitToolContinuation, true);
    assert.equal(parsed.syncAuth, "always");
    assert.equal(parsed.loginMode, "auto");
    assert.equal(parsed.stateDir, undefined);
    assert.equal(parsed.codexHome, undefined);
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
    // The default Codex home is shared across roots so login persists, while
    // staying isolated from any differently-versioned install using ~/.codex.
    assert.equal(
      finalized.codexHome,
      join(canonicalHome, ".codex-openai-proxy", "codex-home"),
    );

    const explicit = parseServeOptions(
      ["--root", projectLink, "--state-dir", "state", "--codex-home", "home"],
      "/",
    );
    assert.equal(explicit.stateDir, "state");
    assert.equal(explicit.codexHome, "home");
    const resolvedExplicit = await resolveServeOptions(explicit);
    assert.equal(resolvedExplicit.root, canonicalProject);
    assert.equal(resolvedExplicit.stateDir, join(canonicalProject, "state"));
    assert.equal(resolvedExplicit.codexHome, join(canonicalProject, "home"));
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
    await assert.rejects(
      resolveServeOptions(
        parseServeOptions(["--state-dir", join(directory, "state")], homedir()),
      ),
      /default --codex-home falls inside --root/,
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
