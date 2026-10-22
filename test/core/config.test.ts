import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  prepareServeOptions,
  finalizeServeOptions,
  type ParsedServeOptions,
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

/** Resolves configuration with a synthetic bound port without creating state. */
async function resolveServeOptions(parsed: ParsedServeOptions, port = 8787) {
  return finalizeServeOptions(await prepareServeOptions(parsed), port);
}

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
    // Each bound instance keeps its app-server files beside its own state.
    assert.equal(
      finalized.codexHome,
      join(finalized.stateDir, "..", "codex-home"),
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

    // Preparation rejects these before any port is bound.
    await assert.rejects(
      prepareServeOptions(parseServeOptions([], homedir())),
      /default --state-dir falls inside --root/,
    );
    await assert.rejects(
      prepareServeOptions(
        parseServeOptions(["--state-dir", join(directory, "state")], homedir()),
      ),
      /default --codex-home falls inside --root/,
    );
    const explicitInsideHome = await prepareServeOptions(
      parseServeOptions(
        [
          "--state-dir",
          join(directory, "state"),
          "--codex-home",
          join(directory, "home"),
        ],
        homedir(),
      ),
    );
    assert.equal(explicitInsideHome.codexHome, join(directory, "home"));
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

test("default directories identify the canonical root and normalized bound endpoint", async () => {
  await withTempDir(async (directory) => {
    const root = join(directory, "project");
    const otherRoot = join(directory, "other");
    await Promise.all([mkdir(root), mkdir(otherRoot)]);
    const prepared = await prepareServeOptions(
      parseServeOptions(["--root", root, "--port", "0"]),
    );
    assert.equal(prepared.stateDir, undefined);
    assert.equal(prepared.codexHome, undefined);
    assert.throws(() => finalizeServeOptions(prepared, 0), /bound port/);
    const first = finalizeServeOptions(prepared, 40001);
    const hash = createHash("sha256")
      .update(prepared.root)
      .digest("hex")
      .slice(0, 16);
    const instance = join(
      realpathSync(homedir()),
      ".codex-openai-proxy",
      hash,
      "ipv4-40001",
    );
    assert.equal(first.root, prepared.root);
    assert.equal(first.port, 40001);
    assert.equal(first.stateDir, join(instance, "state"));
    assert.equal(first.codexHome, join(instance, "codex-home"));
    assert.deepEqual(finalizeServeOptions(prepared, 40001), first);
    const localhost = await prepareServeOptions(
      parseServeOptions(["--root", root, "--host", "localhost"]),
    );
    assert.equal(
      finalizeServeOptions(localhost, 40001).stateDir,
      first.stateDir,
    );
    for (const candidate of [
      finalizeServeOptions(prepared, 40002),
      finalizeServeOptions({ ...prepared, host: "::1" }, 40001),
      finalizeServeOptions(
        await prepareServeOptions(parseServeOptions(["--root", otherRoot])),
        40001,
      ),
    ]) {
      assert.notEqual(candidate.stateDir, first.stateDir);
      assert.notEqual(candidate.codexHome, first.codexHome);
    }
    const explicit = await prepareServeOptions(
      parseServeOptions([
        "--root",
        root,
        "--state-dir",
        "chosen-state",
        "--codex-home",
        "chosen-home",
      ]),
    );
    for (const port of [40001, 40002]) {
      const selected = finalizeServeOptions(explicit, port);
      assert.equal(selected.stateDir, join(prepared.root, "chosen-state"));
      assert.equal(selected.codexHome, join(prepared.root, "chosen-home"));
    }
    assert.equal(
      finalizeServeOptions({ ...prepared, stateDir: explicit.stateDir }, 40001)
        .codexHome,
      first.codexHome,
    );
    assert.equal(
      finalizeServeOptions(
        { ...prepared, codexHome: explicit.codexHome },
        40001,
      ).stateDir,
      first.stateDir,
    );
  });
});
