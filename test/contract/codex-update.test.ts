import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { repoRootUrl } from "../support/repo-root.js";
import { withTempDir } from "../support/temp.js";

/** Synthetic npm entry point: records invocations and models partial update failures. */
const fakeNpm = `
import { appendFileSync, writeFileSync } from "node:fs";
/** Arguments supplied by the upgrade helper. */
const args = process.argv.slice(2);
appendFileSync("calls.jsonl", JSON.stringify(args) + "\\n");
if (args[0] === "view") process.stdout.write(JSON.stringify("1.2.3"));
if (args[0] === "install") writeFileSync("package.json", JSON.stringify({ attempted: args.at(-1) }));
if (process.env.FAIL_PHASE === (args[0] === "run" ? args[1] : args[0])) process.exit(2);
if (args[1] === "generate:protocol") writeFileSync("generated-marker", "synthetic protocol");
`;

/** Execute the real helper in an isolated Git checkout with no network or real npm work. */
async function attempt(args: string[], failPhase = "", dirty = false) {
  return withTempDir(async (directory) => {
    await mkdir(join(directory, "scripts"));
    await copyFile(
      new URL("scripts/update-codex.mjs", repoRootUrl),
      join(directory, "scripts/update-codex.mjs"),
    );
    await writeFile(join(directory, "npm.mjs"), fakeNpm);
    const git = spawnSync("git", ["init", "--quiet"], { cwd: directory });
    assert.equal(git.status, 0, git.stderr.toString());
    if (dirty)
      await writeFile(join(directory, "package.json"), '{"userWork":true}');
    const result = spawnSync(
      process.execPath,
      [join(directory, "scripts/update-codex.mjs"), ...args],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          // Windows deduplicates environment keys without regard to case; remove
          // inherited variants so a real NPM_EXECPATH cannot outrank our fake.
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) =>
                !["NPM_EXECPATH", "NPM_CONFIG_OFFLINE"].includes(
                  key.toUpperCase(),
                ),
            ),
          ),
          npm_execpath: join(directory, "npm.mjs"),
          npm_config_offline: "true",
          FAIL_PHASE: failPhase,
        },
      },
    );
    const calls = await readFile(join(directory, "calls.jsonl"), "utf8").catch(
      () => "",
    );
    const manifest = await readFile(
      join(directory, "package.json"),
      "utf8",
    ).catch(() => "");
    return {
      ...result,
      calls: calls.trim()
        ? calls
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as string[])
        : [],
      manifest,
    };
  }, "codex-update-");
}

test("Codex update resolves latest once, pins exactly, generates, and runs only offline gates", async () => {
  const result = await attempt([]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    ["view", "@openai/codex@latest", "version", "--json"],
    [
      "install",
      "--save-exact",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "@openai/codex@1.2.3",
    ],
    ...[
      "generate:protocol",
      "format:check",
      "lint",
      "check:protocol",
      "test",
      "test:package",
    ].map((gate) => ["run", gate]),
  ]);
});

test("Codex update continues independent gates after failure and preserves the attempted pin", async () => {
  const result = await attempt(["1.2.3-rc.1"], "lint");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Failed gates: lint/);
  assert.deepEqual(result.calls.at(-1), ["run", "test:package"]);
  assert.match(result.manifest, /1.2.3-rc.1/);
});

test.each(["install", "generate:protocol"])(
  "Codex update stops on %s failure without rolling back",
  async (phase) => {
    const result = await attempt(["1.2.3"], phase);
    assert.equal(result.status, 1);
    assert.equal(result.calls.length, phase === "install" ? 1 : 2);
    assert.match(result.manifest, /1.2.3/);
    assert.match(result.stderr, /Changes are preserved/);
  },
);

test("Codex update refuses dirty manifests before invoking npm", async () => {
  const result = await attempt(["1.2.3"], "", true);
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, []);
  assert.equal(result.manifest, '{"userWork":true}');
});

test("Codex update check mode validates a dirty attempt without installation or regeneration", async () => {
  const result = await attempt(["--check"], "", true);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.calls.map((args) => args[1]),
    ["format:check", "lint", "check:protocol", "test", "test:package"],
  );
  assert.equal(result.manifest, '{"userWork":true}');
});

test.each(["--force", "^1.2.3", "1.2.3;echo", "1.2.3-01"])(
  "Codex update rejects unsafe or inexact target %s",
  async (version) => {
    const result = await attempt([version]);
    assert.equal(result.status, 1);
    assert.deepEqual(result.calls, []);
    assert.match(result.stderr, /Usage:/);
  },
);
