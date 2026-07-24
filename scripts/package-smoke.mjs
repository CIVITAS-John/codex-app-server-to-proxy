import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** Repository root containing the package under test. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** npm invocation inherited from npm run, with a direct-execution fallback. */
const npmInvocation = process.env.npm_execpath
  ? { command: process.execPath, prefixArgs: [process.env.npm_execpath] }
  : {
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      prefixArgs: [],
    };

/** Spawns a command, routing Windows command shims through cmd.exe explicitly. */
function spawnCommand(command, args, options = {}) {
  if (process.platform !== "win32" || !command.toLowerCase().endsWith(".cmd"))
    return spawn(command, args, { ...options, shell: false });
  const commandLine = [command, ...args]
    .map((value) => {
      assert.equal(value.includes('"'), false, "Windows shim argument contains a quote");
      return `"${value}"`;
    })
    .join(" ");
  // The outer quote pair is required by cmd.exe when the command itself is
  // quoted. Verbatim arguments prevent Node from escaping that command again.
  return spawn(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", `"${commandLine}"`],
    {
      ...options,
      shell: false,
      windowsVerbatimArguments: true,
    },
  );
}

/** Emits one stable progress marker for CI timeout diagnosis. */
function reportPhase(phase) {
  process.stdout.write(`package smoke: ${phase}\n`);
}

/** Waits for a child exit while enforcing a hard deadline. */
async function waitForChild(child, label, timeoutMs) {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref();
  try {
    const [code, signal] = await once(child, "exit");
    if (timedOut) throw new Error(`${label} timed out after ${timeoutMs}ms`);
    return { code, signal };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs one finite child process and returns its captured output. */
async function run(command, args, options = {}) {
  const child = spawnCommand(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const { code, signal } = await waitForChild(
    child,
    `${command} ${args.join(" ")}`,
    options.timeoutMs ?? 120_000,
  );
  if (code !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed (${code ?? signal}):\n${stderr}${stdout}`,
    );
  return { stdout, stderr };
}

/** Runs npm without relying on Windows command-shim path resolution. */
async function runNpm(args, options = {}) {
  return await run(
    npmInvocation.command,
    [...npmInvocation.prefixArgs, ...args],
    options,
  );
}

/** Recursively lists package-relative regular files below one path. */
async function listFiles(relativePath) {
  const entries = await readdir(join(repoRoot, relativePath), {
    withFileTypes: true,
  });
  const paths = [];
  for (const entry of entries) {
    const child = `${relativePath}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...(await listFiles(child)));
    else if (entry.isFile()) paths.push(child);
  }
  return paths;
}

/** Deletes only the current candidate tarball left by an interrupted smoke run. */
async function removeStaleTarball(filename) {
  assert.equal(filename, filename.split(/[\\/]/u).at(-1));
  await rm(join(repoRoot, filename), { force: true });
}

/** Invokes an npm-generated bin shim without resolving the source entry point. */
function spawnShim(shim, args, options = {}) {
  return spawnCommand(shim, args, options);
}

/** Runs a finite command through the installed npm bin shim. */
async function runShim(shim, args, cwd) {
  const child = spawnShim(shim, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const { code, signal } = await waitForChild(
    child,
    `installed shim ${args.join(" ")}`,
    15_000,
  );
  assert.equal(code, 0, `shim failed (${code ?? signal}):\n${stderr}`);
  return { stdout, stderr };
}

/** Waits for a startup event and returns its structured diagnostic. */
async function waitForEvent(readStderr, event, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of readStderr().split("\n")) {
      try {
        const entry = JSON.parse(line);
        if (entry.event === event) return entry;
      } catch {
        // A partial final line is expected while the process is still writing.
      }
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${event}:\n${readStderr()}`);
}

/** Waits for child exit without missing an event that already fired. */
async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer;
  try {
    return await Promise.race([
      once(child, "exit").then(() => true),
      new Promise((resolve) => {
        // Keep this deadline referenced so top-level cleanup always settles.
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Stops the shim process and its child process tree on every supported OS. */
async function stopShim(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await run("taskkill", ["/pid", String(child.pid), "/t", "/f"]).catch(
      () => undefined,
    );
  } else {
    child.kill("SIGTERM");
  }
  if (await waitForExit(child, 5_000)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(child, 5_000)))
    throw new Error("Installed package shim did not stop.");
}

/** Creates a deterministic fake for the installed package-owned Codex binary. */
function fakeCodexSource(codexVersion) {
  return `#!/usr/bin/env node
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli ${codexVersion}\\n");
  process.exit(0);
}
const cwd = process.cwd();
const thread = {
  id: "thr_package_smoke", extra: null, sessionId: "session_package_smoke",
  forkedFromId: null, parentThreadId: null, preview: "", ephemeral: false,
  historyMode: "paginated", modelProvider: "openai", createdAt: 0, updatedAt: 0,
  recencyAt: null, status: { type: "idle" }, path: null, cwd, cliVersion: "${codexVersion}",
  source: "unknown", threadSource: null, agentNickname: null, agentRole: null,
  gitInfo: null, name: null, turns: []
};
const turn = (status) => ({
  id: "turn_package_smoke", items: [], itemsView: "full", status,
  error: null, startedAt: null, completedAt: null, durationMs: null
});
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {
    userAgent: "package-smoke", codexHome: cwd,
    platformFamily: process.platform === "win32" ? "windows" : "unix",
    platformOs: process.platform
  }});
  else if (message.method === "configRequirements/read")
    send({ id: message.id, result: { requirements: null }});
  else if (message.method === "account/read") send({ id: message.id, result: {
    account: { type: "chatgpt", email: null, planType: "unknown" },
    requiresOpenaiAuth: true
  }});
  else if (message.method === "thread/start") send({ id: message.id, result: {
    thread, model: "gpt-5.6-luna", modelProvider: "openai", serviceTier: null, cwd,
    runtimeWorkspaceRoots: [], instructionSources: [], approvalPolicy: "never",
    approvalsReviewer: "auto_review", sandbox: { type: "readOnly", networkAccess: false },
    activePermissionProfile: null, reasoningEffort: null, multiAgentMode: "explicitRequestOnly"
  }});
  else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: turn("inProgress") }});
    send({ method: "item/agentMessage/delta", params: {
      threadId: thread.id, turnId: "turn_package_smoke", itemId: "message_package_smoke",
      delta: "packed smoke ok"
    }});
    send({ method: "turn/completed", params: {
      threadId: thread.id, turn: turn("completed")
    }});
  }
});
process.on("SIGTERM", () => process.exit(0));
`;
}

/** Builds, packs, installs, and exercises the distributable package. */
async function main() {
  const argumentsList = process.argv.slice(2);
  const argumentSet = new Set(argumentsList);
  assert.ok(
    argumentSet.size === argumentsList.length &&
      argumentsList.every(
        (argument) =>
          argument === "--retain" || argument === "--registry-install",
      ),
    "Usage: node scripts/package-smoke.mjs [--retain] [--registry-install]",
  );
  const retainTarball = argumentSet.has("--retain");
  const registryInstall = argumentSet.has("--registry-install");
  const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const expectedTarballName = `${packageJson.name}-${packageJson.version}.tgz`;
  const forbiddenLifecycleScripts = ["preinstall", "install", "postinstall", "prepare"];
  for (const script of forbiddenLifecycleScripts)
    assert.equal(packageJson.scripts?.[script], undefined, `${script} must not run during install`);

  const installRoot = await mkdtemp(join(tmpdir(), "codex-openai-proxy-package-"));
  const npmEnvironment = {
    ...process.env,
    npm_config_cache: join(installRoot, "npm-cache"),
    ...(registryInstall ? {} : { npm_config_offline: "true" }),
  };
  const tarballPath = join(repoRoot, expectedTarballName);
  let smokePassed = false;
  try {
    reportPhase("building distributable");
    await removeStaleTarball(expectedTarballName);
    await runNpm(["run", "build"], { env: npmEnvironment });
    reportPhase("packing and inspecting exact contents");
    const packed = await runNpm(["pack", "--json", "--ignore-scripts"], {
      env: npmEnvironment,
    });
    const packResult = JSON.parse(packed.stdout)[0];
    assert.equal(packResult.filename, expectedTarballName);
    const expectedFiles = new Set([
      "LICENSE",
      "README.md",
      "package.json",
      "protocol/VERSION.json",
      ...(await listFiles("dist")),
      ...(await listFiles("protocol/schemas")),
    ]);
    const packedFiles = new Set(packResult.files.map((file) => file.path));
    assert.deepEqual(
      [...packedFiles].sort(),
      [...expectedFiles].sort(),
      "packed tarball contents differ from the release allow-list",
    );

    await writeFile(
      join(installRoot, "package.json"),
      JSON.stringify({ private: true }),
      "utf8",
    );
    const sourceCodexRoot = join(repoRoot, "node_modules", "@openai", "codex");
    const sourceCodex = JSON.parse(
      await readFile(join(sourceCodexRoot, "package.json"), "utf8"),
    );
    assert.equal(sourceCodex.version, packageJson.dependencies["@openai/codex"]);
    const platformPackageName = `codex-${process.platform}-${process.arch}`;
    const platformCodexRoot = join(
      repoRoot,
      "node_modules",
      "@openai",
      platformPackageName,
    );
    const platformCodex = JSON.parse(
      await readFile(join(platformCodexRoot, "package.json"), "utf8"),
    );
    assert.equal(platformCodex.name, "@openai/codex");
    assert.equal(
      sourceCodex.optionalDependencies[`@openai/${platformPackageName}`],
      `npm:@openai/codex@${platformCodex.version}`,
    );
    const codexSeedTarballs = [];
    if (!registryInstall) {
      reportPhase("seeding isolated cache from installed Codex packages");
      for (const packageRoot of [sourceCodexRoot, platformCodexRoot]) {
        const seedPack = await runNpm(
          [
            "pack",
            packageRoot,
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            installRoot,
          ],
          { env: npmEnvironment },
        );
        const seedTarball = join(
          installRoot,
          JSON.parse(seedPack.stdout)[0].filename,
        );
        codexSeedTarballs.push(seedTarball);
        await runNpm(["cache", "add", seedTarball], {
          env: npmEnvironment,
        });
      }
    }
    reportPhase(
      registryInstall
        ? "installing tarball and native Codex package from the registry"
        : "installing tarball from the isolated cache",
    );
    await runNpm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--omit=dev",
        ...(registryInstall
          ? ["--include=optional"]
          : ["--omit=optional", "--offline"]),
        tarballPath,
        ...(registryInstall ? [] : [codexSeedTarballs[0]]),
      ],
      { cwd: installRoot, env: npmEnvironment },
    );

    const installedPackageRoot = join(
      installRoot,
      "node_modules",
      packageJson.name,
    );
    const installedPackage = JSON.parse(
      await readFile(join(installedPackageRoot, "package.json"), "utf8"),
    );
    assert.equal(installedPackage.version, packageJson.version);
    assert.equal(
      installedPackage.dependencies["@openai/codex"],
      packageJson.dependencies["@openai/codex"],
    );

    const installedCodexRoot = join(installRoot, "node_modules", "@openai", "codex");
    const installedCodex = JSON.parse(
      await readFile(join(installedCodexRoot, "package.json"), "utf8"),
    );
    assert.equal(installedCodex.version, packageJson.dependencies["@openai/codex"]);
    if (registryInstall) {
      const installedPlatformCodex = JSON.parse(
        await readFile(
          join(
            installRoot,
            "node_modules",
            "@openai",
            platformPackageName,
            "package.json",
          ),
          "utf8",
        ),
      );
      assert.equal(installedPlatformCodex.name, "@openai/codex");
      assert.equal(installedPlatformCodex.version, platformCodex.version);
    }
    const codexBin =
      typeof installedCodex.bin === "string"
        ? installedCodex.bin
        : installedCodex.bin.codex;
    const codexExecutable = join(installedCodexRoot, codexBin);
    await writeFile(codexExecutable, fakeCodexSource(installedCodex.version), "utf8");
    await chmod(codexExecutable, 0o755);

    reportPhase("invoking generated npm bin shim");
    const shim = join(
      installRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? `${packageJson.name}.cmd` : packageJson.name,
    );
    assert.equal((await runShim(shim, ["--version"], installRoot)).stdout, `${packageJson.version}\n`);
    assert.match((await runShim(shim, ["serve", "--help"], installRoot)).stdout, /Usage:/u);

    reportPhase("starting shim and exercising loopback request");
    const stateDirectory = join(installRoot, "state");
    const server = spawnShim(
      shim,
      [
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--root",
        installRoot,
        "--state-dir",
        stateDirectory,
        "--shutdown-timeout",
        "2s",
      ],
      {
        cwd: installRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let serverStderr = "";
    server.stderr.setEncoding("utf8").on("data", (chunk) => (serverStderr += chunk));
    try {
      const listening = await waitForEvent(() => serverStderr, "server_listening");
      await waitForEvent(() => serverStderr, "app_server_ready");
      assert.equal(listening.proxy_version, packageJson.version);
      assert.equal(listening.codex_version, installedCodex.version);
      const origin = `http://127.0.0.1:${listening.port}`;
      assert.deepEqual(await (await fetch(`${origin}/health`)).json(), { status: "ok" });
      assert.equal((await fetch(`${origin}/ready`)).status, 200);
      const response = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          messages: [{ role: "user", content: "Return the package smoke fixture." }],
        }),
      });
      assert.equal(response.status, 200);
      const completion = await response.json();
      assert.equal(completion.choices[0].message.content, "packed smoke ok");
      assert.equal(completion.choices[0].finish_reason, "stop");
      smokePassed = true;
    } finally {
      await stopShim(server);
    }
  } finally {
    try {
      await rm(installRoot, { recursive: true, force: true });
    } finally {
      if (!retainTarball || !smokePassed)
        await rm(tarballPath, { force: true });
    }
  }
  process.stdout.write(
    `Packed package smoke passed for ${packageJson.name}@${packageJson.version}.\n`,
  );
  if (retainTarball)
    process.stdout.write(`Retained tested tarball: ${tarballPath}\n`);
}

await main();
