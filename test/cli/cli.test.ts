import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, vi } from "vitest";
import {
  APP_SERVER_RECOVERY_DELAYS_MS,
  run,
  usage,
} from "../../src/cli/cli.js";
import {
  CLIENT_VERSION,
  PINNED_CODEX_VERSION,
} from "../../src/app-server/app-server.js";
import { repoRootPath } from "../support/repo-root.js";
import {
  protocolAuthenticatedAccountResponse,
  protocolInitializeResponse,
  protocolResponse,
  protocolServerRequest,
  protocolThread,
  protocolThreadStartResponse,
  protocolTurn,
} from "../support/protocol-fixtures.js";

/** Skips fake shebang executables that Windows cannot spawn without a shell. */
const testWithPosixExecutable = test.skipIf(process.platform === "win32");

/** Generated results embedded in maintained fake child-process scripts. */
const embeddedProtocolResults = {
  initialize: JSON.stringify(protocolInitializeResponse()),
  requirements: JSON.stringify(
    protocolResponse("configRequirements/read", 0, { requirements: null })
      .result,
  ),
  authenticatedAccount: JSON.stringify(protocolAuthenticatedAccountResponse()),
  unauthenticatedAccount: JSON.stringify({
    account: null,
    requiresOpenaiAuth: true,
  } satisfies ReturnType<typeof protocolAuthenticatedAccountResponse>),
  login: JSON.stringify(
    protocolResponse("account/login/start", 0, {
      type: "chatgptDeviceCode",
      loginId: "login",
      verificationUrl: "https://example.invalid",
      userCode: "TEST-CODE",
    }).result,
  ),
  threadStart: JSON.stringify(
    protocolThreadStartResponse(protocolThread("thr_shutdown")),
  ),
  turnStart: JSON.stringify({
    turn: protocolTurn("turn_shutdown", "inProgress"),
  }),
  toolCall: JSON.stringify(
    protocolServerRequest({
      id: 900,
      method: "item/tool/call",
      params: {
        threadId: "thr_shutdown",
        turnId: "turn_shutdown",
        callId: "call_shutdown",
        namespace: null,
        tool: "lookup",
        arguments: { key: "value" },
      },
    }),
  ),
};

/** Waits until captured CLI diagnostics contain one lifecycle event. */
async function waitForText(
  read: () => string,
  expected: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!read().includes(expected)) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${expected}: ${read()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Waits until a fake child records that one startup phase began. */
async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for startup marker ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** Allocates a loopback port and keeps it reserved until close is called. */
async function reservePort(): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    port: address.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("CLI recovery uses the documented bounded retry schedule", () => {
  assert.deepEqual(
    APP_SERVER_RECOVERY_DELAYS_MS,
    [1_000, 3_000, 5_000, 10_000],
  );
  assert.match(usage, /per-root under ~\/\.codex-openai-proxy/);
  assert.equal(usage.includes("<root>/.codex-openai-proxy"), false);
});

test("CLI help and unsafe configuration are handled in-process", async () => {
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  try {
    assert.equal(await run(["--help"]), 0);
    assert.match(String(stdout.mock.calls[0]?.[0]), /Usage:/);
    assert.equal(await run(["serve", "--help"]), 0);
    assert.match(String(stdout.mock.calls[1]?.[0]), /Usage:/);
    assert.equal(await run(["--version"]), 0);
    assert.equal(stdout.mock.calls[2]?.[0], `${CLIENT_VERSION}\n`);
    assert.equal(await run(["serve", "--version"]), 0);
    assert.equal(stdout.mock.calls[3]?.[0], `${CLIENT_VERSION}\n`);
    await assert.rejects(run(["unknown"]), /Unknown command/);
    const missingRoot = join(
      tmpdir(),
      `codex-proxy-missing-root-${process.pid}-${Date.now()}`,
    );
    assert.equal(await run(["serve", "--root", missingRoot]), 1);
    assert.match(String(stderr.mock.calls.at(-1)?.[0]), /startup_failed/);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});

test("CLI rejects unsafe binds before opening a socket", async () => {
  const child = spawn(
    process.execPath,
    ["dist/bin.js", "serve", "--host", "0.0.0.0"],
    { cwd: repoRootPath, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.match(stderr, /startup_failed/);
  assert.match(stderr, /Only 127\.0\.0\.1/);
});

test("CLI reports a bind-time port conflict before starting app-server", async () => {
  const reservation = await reservePort();
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-port-test-"));
  try {
    const child = spawn(
      process.execPath,
      [
        "dist/bin.js",
        "serve",
        "--port",
        String(reservation.port),
        "--state-dir",
        join(directory, "state"),
        "--codex-path",
        join(directory, "must-not-start"),
      ],
      { cwd: repoRootPath, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const [code] = await once(child, "exit");
    assert.equal(code, 1);
    assert.match(stderr, /startup_failed/);
    assert.match(stderr, /EADDRINUSE/);
    assert.equal(stderr.includes("must-not-start"), false);
  } finally {
    await reservation.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI redacts configured paths from initial startup failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-redact-test-"));
  const missingCodex = join(directory, "secret-client", "missing-codex");
  try {
    const child = spawn(
      process.execPath,
      [
        "dist/bin.js",
        "serve",
        "--port",
        "0",
        "--root",
        ".",
        "--state-dir",
        join(directory, "state"),
        "--codex-path",
        missingCodex,
      ],
      { cwd: repoRootPath, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const [code] = await once(child, "exit");
    assert.equal(code, 1);
    assert.match(stderr, /startup_failed/);
    assert.match(stderr, /\[REDACTED_PATH\]/);
    assert.equal(stderr.includes(missingCodex), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

testWithPosixExecutable(
  "signal shutdown aborts pre-auth version and initialization startup",
  async () => {
    for (const phase of ["version", "initialize"] as const) {
      const directory = await mkdtemp(
        join(tmpdir(), `codex-proxy-${phase}-stop-`),
      );
      const fake = join(directory, "codex");
      const started = join(directory, "started");
      await writeFile(
        fake,
        `#!${process.execPath}
const fs=require('fs');
if(process.argv.includes('--version')) {
  if(${JSON.stringify(phase)}==='version') { fs.writeFileSync(${JSON.stringify(started)},'version'); setInterval(()=>{},1000); }
  else { console.log('codex-cli ${PINNED_CODEX_VERSION}'); process.exit(0); }
} else {
  fs.writeFileSync(${JSON.stringify(started)},'initialize');
  setInterval(()=>{},1000);
}
`,
        "utf8",
      );
      await chmod(fake, 0o755);
      const child = spawn(
        process.execPath,
        [
          "dist/bin.js",
          "serve",
          "--port",
          "0",
          "--state-dir",
          join(directory, "state"),
          "--codex-path",
          fake,
          "--tool-timeout",
          "30s",
          "--shutdown-timeout",
          "1s",
        ],
        { cwd: repoRootPath, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      await waitForFile(started);
      const signalledAt = Date.now();
      child.kill("SIGTERM");
      const [code, signal] = await once(child, "exit");
      assert.equal(code, 0, `${phase} shutdown stderr:\n${stderr}`);
      assert.equal(signal, null, `${phase} shutdown stderr:\n${stderr}`);
      assert.ok(Date.now() - signalledAt < 3_000);
      assert.match(stderr, /shutdown_complete/);
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

testWithPosixExecutable(
  "CLI exits cleanly after a termination signal",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-proxy-test-"));
    const fake = join(directory, "codex");
    await writeFile(
      fake,
      `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('codex-cli ${PINNED_CODEX_VERSION}'); process.exit(0); }
const rl=require('readline').createInterface({input:process.stdin});
rl.on('line', line => {
  const m=JSON.parse(line);
  if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:${embeddedProtocolResults.initialize}}));
  if(m.method==='configRequirements/read') console.log(JSON.stringify({id:m.id,result:${embeddedProtocolResults.requirements}}));
  if(m.method==='account/read') console.log(JSON.stringify({id:m.id,result:${embeddedProtocolResults.authenticatedAccount}}));
});
`,
      "utf8",
    );
    await chmod(fake, 0o755);
    const child = spawn(
      process.execPath,
      [
        "dist/bin.js",
        "serve",
        "--port",
        "0",
        "--root",
        ".",
        "--state-dir",
        join(directory, "state"),
        "--codex-path",
        fake,
      ],
      { cwd: repoRootPath, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    while (!stderr.includes("app_server_ready")) {
      await once(child.stderr, "data");
    }
    child.kill("SIGTERM");
    const [code, signal] = await once(child, "exit");
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.match(stderr, /shutdown_complete/);
    assert.match(stderr, /"default_sandbox":"read-only"/);
    assert.match(stderr, /"default_web_search":"disabled"/);
    assert.equal(stderr.includes(`"proxy_version":"${CLIENT_VERSION}"`), true);
    assert.equal(
      stderr.includes(`"codex_version":"${PINNED_CODEX_VERSION}"`),
      true,
    );
    assert.equal(stderr.includes(repoRootPath), false);
    await rm(directory, { recursive: true });
  },
);

testWithPosixExecutable(
  "CLI makes readiness false and recovers after an unexpected child exit",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "codex-proxy-recovery-test-"),
    );
    const fake = join(directory, "codex");
    const launches = join(directory, "launches");
    const reservation = await reservePort();
    const port = reservation.port;
    await reservation.close();
    await writeFile(
      fake,
      `#!${process.execPath}
const fs=require('fs');
if(process.argv.includes('--version')) { console.log('codex-cli ${PINNED_CODEX_VERSION}'); process.exit(0); }
const count=Number(fs.existsSync(${JSON.stringify(launches)})?fs.readFileSync(${JSON.stringify(launches)},'utf8'):0)+1;
fs.writeFileSync(${JSON.stringify(launches)},String(count));
const rl=require('readline').createInterface({input:process.stdin});
rl.on('line', line => {
  const m=JSON.parse(line);
  if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:${embeddedProtocolResults.initialize}}));
  if(m.method==='configRequirements/read') console.log(JSON.stringify({id:m.id,result:${embeddedProtocolResults.requirements}}));
  if(m.method==='account/read') {
    console.log(JSON.stringify({id:m.id,result:${embeddedProtocolResults.authenticatedAccount}}));
    if(count===1) setTimeout(()=>process.exit(23),250);
  }
});
process.on('SIGTERM',()=>process.exit(0));
`,
      "utf8",
    );
    await chmod(fake, 0o755);
    const child = spawn(
      process.execPath,
      [
        "dist/bin.js",
        "serve",
        "--port",
        String(port),
        "--state-dir",
        join(directory, "state"),
        "--codex-path",
        fake,
        "--shutdown-timeout",
        "2s",
      ],
      { cwd: repoRootPath, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    try {
      await waitForText(() => stderr, "app_server_ready");
      await waitForText(() => stderr, "app_server_exited");
      const unavailable = await fetch(`http://127.0.0.1:${port}/ready`);
      assert.equal(unavailable.status, 503);
      await waitForText(() => stderr, "app_server_restarted", 8_000);
      const ready = await fetch(`http://127.0.0.1:${port}/ready`);
      assert.equal(ready.status, 200);
      assert.equal(Number(await readFile(launches, "utf8")), 2);
    } finally {
      child.kill("SIGTERM");
      await once(child, "exit");
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

testWithPosixExecutable(
  "signal shutdown cancels an in-flight login and stops its child",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-proxy-login-stop-"));
    const fake = join(directory, "codex");
    const stopped = join(directory, "stopped");
    await writeFile(
      fake,
      `#!${process.execPath}
const fs=require('fs');
if(process.argv.includes('--version')) { console.log('codex-cli ${PINNED_CODEX_VERSION}'); process.exit(0); }
const rl=require('readline').createInterface({input:process.stdin});
rl.on('line', line => {
  const m=JSON.parse(line);
  if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:${embeddedProtocolResults.initialize}}));
  if(m.method==='configRequirements/read') console.log(JSON.stringify({id:m.id,result:${embeddedProtocolResults.requirements}}));
  if(m.method==='account/read') console.log(JSON.stringify({id:m.id,result:${embeddedProtocolResults.unauthenticatedAccount}}));
  if(m.method==='account/login/start') console.log(JSON.stringify({id:m.id,result:${embeddedProtocolResults.login}}));
});
process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'yes');process.exit(0)});
`,
      "utf8",
    );
    await chmod(fake, 0o755);
    const child = spawn(
      process.execPath,
      [
        "dist/bin.js",
        "serve",
        "--port",
        "0",
        "--state-dir",
        join(directory, "state"),
        "--codex-path",
        fake,
        "--shutdown-timeout",
        "2s",
      ],
      { cwd: repoRootPath, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    await waitForText(() => stderr, "device_code_login_started");
    child.kill("SIGTERM");
    const [code, signal] = await once(child, "exit");
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.match(stderr, /shutdown_complete/);
    assert.equal(await readFile(stopped, "utf8"), "yes");
    await rm(directory, { recursive: true, force: true });
  },
  10_000,
);

testWithPosixExecutable(
  "signal shutdown rejects a suspended dynamic tool request",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-proxy-tool-stop-"));
    const fake = join(directory, "codex");
    const rejected = join(directory, "rejected");
    const reservation = await reservePort();
    const port = reservation.port;
    await reservation.close();
    await writeFile(
      fake,
      `#!${process.execPath}
const fs=require('fs');
if(process.argv.includes('--version')) { console.log('codex-cli ${PINNED_CODEX_VERSION}'); process.exit(0); }
const rl=require('readline').createInterface({input:process.stdin});
rl.on('line', line => {
  const m=JSON.parse(line);
  if(m.id===900 && m.error) fs.writeFileSync(${JSON.stringify(rejected)},JSON.stringify(m.error));
  if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:${embeddedProtocolResults.initialize}}));
  if(m.method==='configRequirements/read') console.log(JSON.stringify({id:m.id,result:${embeddedProtocolResults.requirements}}));
  if(m.method==='account/read') console.log(JSON.stringify({id:m.id,result:${embeddedProtocolResults.authenticatedAccount}}));
  if(m.method==='thread/start') console.log(JSON.stringify({id:m.id,result:${embeddedProtocolResults.threadStart}}));
  if(m.method==='turn/start') {
    console.log(JSON.stringify({id:m.id,result:${embeddedProtocolResults.turnStart}}));
    console.log(JSON.stringify(${embeddedProtocolResults.toolCall}));
  }
});
process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),200));
`,
      "utf8",
    );
    await chmod(fake, 0o755);
    const child = spawn(
      process.execPath,
      [
        "dist/bin.js",
        "serve",
        "--port",
        String(port),
        "--state-dir",
        join(directory, "state"),
        "--codex-path",
        fake,
        "--shutdown-timeout",
        "2s",
      ],
      { cwd: repoRootPath, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    await waitForText(() => stderr, "app_server_ready");
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4-mini",
          messages: [{ role: "user", content: "Use lookup." }],
          tools: [
            { type: "function", function: { name: "lookup", parameters: {} } },
          ],
        }),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(
      ((await response.json()) as { choices: [{ finish_reason: string }] })
        .choices[0].finish_reason,
      "tool_calls",
    );
    child.kill("SIGTERM");
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    const error = JSON.parse(await readFile(rejected, "utf8")) as {
      code: number;
    };
    assert.equal(error.code, -32000);
    assert.match(stderr, /shutdown_complete/);
    await rm(directory, { recursive: true, force: true });
  },
  10_000,
);
