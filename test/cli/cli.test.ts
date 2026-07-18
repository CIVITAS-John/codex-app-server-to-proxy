import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, readFile, writeFile } from "node:fs/promises";
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
import { fakeCodexScript } from "../support/fake-codex.js";
import { waitForFile, waitForText } from "../support/poll.js";
import { repoRootPath } from "../support/repo-root.js";
import {
  protocolAuthenticatedAccountResponse,
  protocolResponse,
  protocolServerRequest,
  protocolThread,
  protocolThreadStartResponse,
  protocolTurn,
} from "../support/protocol-fixtures.js";
import { withTempDir } from "../support/temp.js";

/** Skips fake shebang executables that Windows cannot spawn without a shell. */
const testWithPosixExecutable = test.skipIf(process.platform === "win32");

/** Generated results embedded in maintained fake child-process scripts. */
const embeddedProtocolResults = {
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
  await withTempDir(async (directory) => {
    const reservation = await reservePort();
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
    }
  }, "codex-proxy-port-test-");
});

test("CLI redacts configured paths from initial startup failures", async () => {
  await withTempDir(async (directory) => {
    const missingCodex = join(directory, "secret-client", "missing-codex");
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
  }, "codex-proxy-redact-test-");
});

testWithPosixExecutable(
  "signal shutdown aborts pre-auth version and initialization startup",
  async () => {
    for (const phase of ["version", "initialize"] as const) {
      await withTempDir(async (directory) => {
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
      }, `codex-proxy-${phase}-stop-`);
    }
  },
  15_000,
);

testWithPosixExecutable(
  "CLI exits cleanly after a termination signal",
  async () => {
    await withTempDir(async (directory) => {
      const fake = join(directory, "codex");
      await writeFile(
        fake,
        fakeCodexScript({
          version: PINNED_CODEX_VERSION,
          onLine: (message) => `  if (${message}.method === "account/read") {
    console.log(JSON.stringify({ id: ${message}.id, result: ${embeddedProtocolResults.authenticatedAccount} }));
    return;
  }`,
        }),
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
      await waitForText(() => stderr, "app_server_ready");
      child.kill("SIGTERM");
      const [code, signal] = await once(child, "exit");
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.match(stderr, /shutdown_complete/);
      assert.match(stderr, /"default_sandbox":"read-only"/);
      assert.match(stderr, /"default_web_search":"disabled"/);
      assert.equal(
        stderr.includes(`"proxy_version":"${CLIENT_VERSION}"`),
        true,
      );
      assert.equal(
        stderr.includes(`"codex_version":"${PINNED_CODEX_VERSION}"`),
        true,
      );
      assert.equal(stderr.includes(repoRootPath), false);
    }, "codex-proxy-test-");
  },
);

testWithPosixExecutable(
  "CLI makes readiness false and recovers after an unexpected child exit",
  async () => {
    await withTempDir(async (directory) => {
      const fake = join(directory, "codex");
      const launches = join(directory, "launches");
      const reservation = await reservePort();
      const port = reservation.port;
      await reservation.close();
      await writeFile(
        fake,
        fakeCodexScript({
          version: PINNED_CODEX_VERSION,
          setup: `const fs = require("node:fs");
const launches = ${JSON.stringify(launches)};
const count = Number(fs.existsSync(launches) ? fs.readFileSync(launches, "utf8") : 0) + 1;
fs.writeFileSync(launches, String(count));
process.on("SIGTERM", () => process.exit(0));`,
          onLine: (message) => `  if (${message}.method === "account/read") {
    console.log(JSON.stringify({ id: ${message}.id, result: ${embeddedProtocolResults.authenticatedAccount} }));
    if(count===1) setTimeout(()=>process.exit(23),250);
    return;
  }
`,
        }),
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
      }
    }, "codex-proxy-recovery-test-");
  },
  15_000,
);

testWithPosixExecutable(
  "signal shutdown waits for an in-flight recovery initialization",
  async () => {
    await withTempDir(async (directory) => {
      const fake = join(directory, "codex");
      const launches = join(directory, "launches");
      const recoveryStarted = join(directory, "recovery-started");
      const recoveryStopped = join(directory, "recovery-stopped");
      await writeFile(
        fake,
        fakeCodexScript({
          version: PINNED_CODEX_VERSION,
          setup: `const fs = require("node:fs");
const launches = ${JSON.stringify(launches)};
const count = Number(fs.existsSync(launches) ? fs.readFileSync(launches, "utf8") : 0) + 1;
fs.writeFileSync(launches, String(count));
if (count === 1) {
  process.on("SIGTERM", () => process.exit(0));
} else {
  process.on("SIGTERM", () => setTimeout(() => {
    fs.writeFileSync(${JSON.stringify(recoveryStopped)}, "yes");
    process.exit(0);
  }, 250));
  // Publish readiness only after SIGTERM is handled; otherwise the parent can
  // signal between the marker write and handler registration on a busy runner.
  fs.writeFileSync(${JSON.stringify(recoveryStarted)}, "yes");
}`,
          onLine: (
            message,
          ) => `  if (count === 2 && ${message}.method === "initialize") {
    return;
  }
  if (${message}.method === "account/read") {
    console.log(JSON.stringify({ id: ${message}.id, result: ${embeddedProtocolResults.authenticatedAccount} }));
    if (count === 1) setTimeout(() => process.exit(23), 100);
    return;
  }`,
        }),
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
          "2s",
        ],
        { cwd: repoRootPath, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      const exit = once(child, "exit");
      let exited = false;
      try {
        await waitForText(() => stderr, "app_server_ready");
        await waitForFile(recoveryStarted, 8_000);
        child.kill("SIGTERM");
        await waitForText(() => stderr, "shutdown_complete");
        // The recovery child delays this marker after SIGTERM, so its presence
        // proves shutdown awaited the detached initialization task.
        assert.equal(await readFile(recoveryStopped, "utf8"), "yes");
        const [code, signal] = await exit;
        exited = true;
        assert.equal(code, 0);
        assert.equal(signal, null);
      } finally {
        if (!exited && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exit;
        }
      }
    }, "codex-proxy-recovery-stop-");
  },
  15_000,
);

testWithPosixExecutable(
  "signal shutdown cancels an in-flight login and stops its child",
  async () => {
    await withTempDir(async (directory) => {
      const fake = join(directory, "codex");
      const stopped = join(directory, "stopped");
      await writeFile(
        fake,
        fakeCodexScript({
          version: PINNED_CODEX_VERSION,
          setup: `const fs = require("node:fs");
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(stopped)}, "yes");
  process.exit(0);
});`,
          onLine: (message) => `  if (${message}.method === "account/read") {
    console.log(JSON.stringify({ id: ${message}.id, result: ${embeddedProtocolResults.unauthenticatedAccount} }));
    return;
  }
  if (${message}.method === "account/login/start") {
    console.log(JSON.stringify({ id: ${message}.id, result: ${embeddedProtocolResults.login} }));
    return;
  }`,
        }),
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
    }, "codex-proxy-login-stop-");
  },
  10_000,
);

testWithPosixExecutable(
  "signal shutdown rejects a suspended dynamic tool request",
  async () => {
    await withTempDir(async (directory) => {
      const fake = join(directory, "codex");
      const rejected = join(directory, "rejected");
      const reservation = await reservePort();
      const port = reservation.port;
      await reservation.close();
      await writeFile(
        fake,
        fakeCodexScript({
          version: PINNED_CODEX_VERSION,
          setup: `const fs = require("node:fs");
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 200));`,
          onLine: (
            message,
          ) => `  if (${message}.id === 900 && ${message}.error) {
    fs.writeFileSync(${JSON.stringify(rejected)}, JSON.stringify(${message}.error));
  }
  if (${message}.method === "account/read") {
    console.log(JSON.stringify({ id: ${message}.id, result: ${embeddedProtocolResults.authenticatedAccount} }));
    return;
  }
  if (${message}.method === "thread/start") {
    console.log(JSON.stringify({ id: ${message}.id, result: ${embeddedProtocolResults.threadStart} }));
    return;
  }
  if (${message}.method === "turn/start") {
    console.log(JSON.stringify({ id: ${message}.id, result: ${embeddedProtocolResults.turnStart} }));
    console.log(JSON.stringify(${embeddedProtocolResults.toolCall}));
    return;
  }
`,
        }),
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
              {
                type: "function",
                function: { name: "lookup", parameters: {} },
              },
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
    }, "codex-proxy-tool-stop-");
  },
  10_000,
);
