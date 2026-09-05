import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Always operate on the checkout owning this script. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** npm supplies its JavaScript entry point, avoiding shell and Windows shims. */
const npmPath = process.env.npm_execpath;
/** Accept an exact release (including prereleases), never a range or npm option. */
const exactVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

/** Run a subprocess without a shell; output stays in the terminal, never a log artifact. */
function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    shell: false,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${args.join(" ")} failed (${result.signal ?? result.status})`,
    );
  return result.stdout?.trim();
}

/** Preserve the attempted upgrade on failure so an agent can repair compatibility. */
function main() {
  const args = process.argv.slice(2);
  if (
    args.length > 1 ||
    (args[0] &&
      !["latest", "--check"].includes(args[0]) &&
      !exactVersion.test(args[0]))
  ) {
    throw new Error(
      "Usage: npm run update:codex -- [latest|EXACT_VERSION|--check]",
    );
  }
  if (!npmPath)
    throw new Error("Invoke this script through npm run update:codex.");
  const npm = (args, capture = false) =>
    run(process.execPath, [npmPath, ...args], capture);
  if (args[0] !== "--check") {
    // Regeneration deletes old output: never overwrite uncommitted work in its inputs or outputs.
    const dirty = run(
      "git",
      [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        "package.json",
        "package-lock.json",
        "protocol/generated",
        "protocol/VERSION.json",
      ],
      true,
    );
    if (dirty)
      throw new Error(
        "Upgrade inputs or generated outputs have uncommitted changes. Preserve them in a commit or isolated checkout before updating; use --check for an existing attempt.",
      );
    const requested = args[0] ?? "latest";
    const version =
      requested === "latest"
        ? JSON.parse(
            npm(["view", "@openai/codex@latest", "version", "--json"], true),
          )
        : requested;
    if (typeof version !== "string" || !exactVersion.test(version))
      throw new Error("Registry did not return one exact Codex version.");
    process.stdout.write(`Updating @openai/codex to ${version}\n`);
    npm([
      "install",
      "--save-exact",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `@openai/codex@${version}`,
    ]);
    npm(["run", "generate:protocol"]);
  }
  // Keep independent checks running after a failure to give the agent a complete repair list.
  const failed = [];
  for (const gate of [
    "format:check",
    "lint",
    "check:protocol",
    "test",
    "test:package",
  ]) {
    process.stdout.write(`\nCodex upgrade gate: ${gate}\n`);
    try {
      npm(["run", gate]);
    } catch (error) {
      failed.push(gate);
      process.stderr.write(`${error.message}\n`);
    }
  }
  if (failed.length) throw new Error(`Failed gates: ${failed.join(", ")}`);
  process.stdout.write(
    "Offline gates passed. Agent review of protocol, policy, and persisted-state compatibility is still required. No live model calls were made.\n",
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error.message}\nChanges are preserved. Use $update-codex to diagnose and repair, then npm run update:codex -- --check.\n`,
  );
  process.exitCode = 1;
}
