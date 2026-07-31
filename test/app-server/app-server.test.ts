import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { PassThrough } from "node:stream";
import { test } from "vitest";
import {
  attachAppServerStderrLogging,
  CLIENT_VERSION,
  PINNED_CODEX_VERSION,
  resolveCodexExecutable,
  resolveCodexInvocation,
  startAppServer,
  writeBackAuthCredentials,
} from "../../src/app-server/app-server.js";
import { createLogger } from "../../src/core/logger.js";
import { RESPONSES_LITE_OVERRIDE_CATALOG_FILENAME } from "../../src/app-server/responses-lite-override.js";
import { fakeCodexScript } from "../support/fake-codex.js";
import { silentLogger } from "../support/logger.js";
import { waitForFile, waitForFileText } from "../support/poll.js";
import {
  protocolResponse,
  protocolServerRequest,
} from "../support/protocol-fixtures.js";
import { withTempDir } from "../support/temp.js";

/** Skips fake shebang executables that Windows cannot spawn without a shell. */
const testWithPosixExecutable = test.skipIf(process.platform === "win32");

test("stderr logging drops fragmented expected cancellation diagnostics only", () => {
  const stderr = new PassThrough();
  const entries: Array<Record<string, unknown>> = [];
  attachAppServerStderrLogging(stderr, {
    log: createLogger("debug", (entry) => entries.push(entry)),
  });

  stderr.write(
    "2026-07-29T07:34:47Z ERROR codex_core::tools::router: error=dynamic tool call was can",
  );
  stderr.end("celled before receiving a response\nreal diagnostic\n");

  assert.deepEqual(
    entries.filter((entry) => entry.event === "app_server_stderr"),
    [
      {
        time: entries[0]?.time,
        level: "warn",
        event: "app_server_stderr",
        message: "real diagnostic",
      },
    ],
  );
});

test("stderr logging suppresses every decoration of the expected record", () => {
  const stderr = new PassThrough();
  const entries: Array<Record<string, unknown>> = [];
  attachAppServerStderrLogging(stderr, {
    log: createLogger("debug", (entry) => entries.push(entry)),
  });

  // Interrupting a tool turn cancels one request per captured call, so the
  // reporting module and line decoration are app-server implementation detail
  // that must not resurface this expected result as a proxy warning.
  stderr.end(
    [
      "ERROR codex_core::tools::router: error=dynamic tool call was cancelled before receiving a response while draining",
      "ERROR codex_core::tools::registry: tool=codex_core::tools::router: error=dynamic tool call was cancelled before receiving a response",
      "",
    ].join("\n"),
  );

  assert.deepEqual(
    entries
      .filter((entry) => entry.event === "app_server_stderr")
      .map((entry) => entry.message),
    [],
  );
});

test("stderr logging emits a final line that never received a newline", async () => {
  const stderr = new PassThrough();
  const entries: Array<Record<string, unknown>> = [];
  attachAppServerStderrLogging(stderr, {
    log: createLogger("debug", (entry) => entries.push(entry)),
  });

  // A child killed mid-write leaves an unterminated line; the reader flushes
  // it once the stream ends rather than dropping it.
  stderr.end("terminated mid-write");
  await once(stderr, "end");

  assert.deepEqual(
    entries
      .filter((entry) => entry.event === "app_server_stderr")
      .map((entry) => entry.message),
    ["terminated mid-write"],
  );
});

test("auth write-back replaces an older target credential file", async () => {
  await withTempDir(async (directory) => {
    const sourceHome = join(directory, "source-home");
    const targetHome = join(directory, "target-home");
    const sourceAuth = join(sourceHome, "auth.json");
    const targetAuth = join(targetHome, "auth.json");
    await mkdir(sourceHome, { recursive: true });
    await mkdir(targetHome, { recursive: true });
    await writeFile(sourceAuth, '{"fixture":"recovered"}', "utf8");
    await writeFile(targetAuth, '{"fixture":"stale"}', "utf8");
    await utimes(targetAuth, new Date(1_000), new Date(1_000));

    await writeBackAuthCredentials(sourceHome, targetHome, silentLogger);

    assert.equal(await readFile(targetAuth, "utf8"), '{"fixture":"recovered"}');
    assert.equal(
      (await readdir(targetHome)).some((entry) =>
        /^auth\.json\..+\.tmp$/.test(entry),
      ),
      false,
    );
    if (process.platform !== "win32")
      assert.equal((await stat(targetAuth)).mode & 0o777, 0o600);
  }, "app-server-auth-write-back-replace-test-");
});

test("auth write-back leaves a missing target credential file absent", async () => {
  await withTempDir(async (directory) => {
    const sourceHome = join(directory, "source-home");
    const targetHome = join(directory, "target-home");
    await mkdir(sourceHome, { recursive: true });
    await mkdir(targetHome, { recursive: true });
    await writeFile(
      join(sourceHome, "auth.json"),
      '{"fixture":"recovered"}',
      "utf8",
    );

    await writeBackAuthCredentials(sourceHome, targetHome, silentLogger);

    await assert.rejects(stat(join(targetHome, "auth.json")), {
      code: "ENOENT",
    });
  }, "app-server-auth-write-back-missing-test-");
});

test("auth write-back retains a newer target credential file", async () => {
  await withTempDir(async (directory) => {
    const sourceHome = join(directory, "source-home");
    const targetHome = join(directory, "target-home");
    const sourceAuth = join(sourceHome, "auth.json");
    const targetAuth = join(targetHome, "auth.json");
    await mkdir(sourceHome, { recursive: true });
    await mkdir(targetHome, { recursive: true });
    await writeFile(sourceAuth, '{"fixture":"stale"}', "utf8");
    await writeFile(targetAuth, '{"fixture":"newer"}', "utf8");
    await utimes(sourceAuth, new Date(1_000), new Date(1_000));

    await writeBackAuthCredentials(sourceHome, targetHome, silentLogger);

    assert.equal(await readFile(targetAuth, "utf8"), '{"fixture":"newer"}');
  }, "app-server-auth-write-back-newer-target-test-");
});

test("auth write-back retains a target with the same credential mtime", async () => {
  await withTempDir(async (directory) => {
    const sourceHome = join(directory, "source-home");
    const targetHome = join(directory, "target-home");
    const sourceAuth = join(sourceHome, "auth.json");
    const targetAuth = join(targetHome, "auth.json");
    const equalMtime = new Date(2_000);
    await mkdir(sourceHome, { recursive: true });
    await mkdir(targetHome, { recursive: true });
    await writeFile(sourceAuth, '{"fixture":"source"}', "utf8");
    await writeFile(targetAuth, '{"fixture":"target"}', "utf8");
    await utimes(sourceAuth, equalMtime, equalMtime);
    await utimes(targetAuth, equalMtime, equalMtime);

    await writeBackAuthCredentials(sourceHome, targetHome, silentLogger);

    assert.equal(await readFile(targetAuth, "utf8"), '{"fixture":"target"}');
  }, "app-server-auth-write-back-equal-mtime-test-");
});

test("auth write-back replaces a temporary stranded by an earlier crash", async () => {
  await withTempDir(async (directory) => {
    const sourceHome = join(directory, "source-home");
    const targetHome = join(directory, "target-home");
    const sourceAuth = join(sourceHome, "auth.json");
    const targetAuth = join(targetHome, "auth.json");
    // The temporary name is scoped to this process, so anything already there
    // is this proxy's own crash debris rather than a concurrent writer.
    const temporary = `${targetAuth}.${process.pid}.tmp`;
    await mkdir(sourceHome, { recursive: true });
    await mkdir(targetHome, { recursive: true });
    await writeFile(sourceAuth, '{"fixture":"recovered"}', "utf8");
    await writeFile(targetAuth, '{"fixture":"target"}', "utf8");
    await utimes(targetAuth, new Date(1_000), new Date(1_000));
    await writeFile(temporary, '{"fixture":"stale"}', "utf8");

    await writeBackAuthCredentials(sourceHome, targetHome, silentLogger);

    assert.equal(await readFile(targetAuth, "utf8"), '{"fixture":"recovered"}');
    await assert.rejects(readFile(temporary, "utf8"));
  }, "app-server-auth-write-back-temp-collision-test-");
});

test("auth write-back is a no-op when source and target homes match", async () => {
  await withTempDir(async (directory) => {
    const home = join(directory, "codex-home");
    const auth = join(home, "auth.json");
    await mkdir(home, { recursive: true });
    await writeFile(auth, '{"fixture":"unchanged"}', "utf8");

    await writeBackAuthCredentials(home, home, silentLogger);

    assert.equal(await readFile(auth, "utf8"), '{"fixture":"unchanged"}');
  }, "app-server-auth-write-back-self-test-");
});

test("auth write-back failures are best-effort and logged plainly", async () => {
  await withTempDir(async (directory) => {
    const sourceHome = join(directory, "private-source-home");
    const targetHome = join(directory, "private-target-home");
    await mkdir(sourceHome, { recursive: true });
    await mkdir(join(targetHome, "auth.json"), { recursive: true });
    await writeFile(
      join(sourceHome, "auth.json"),
      '{"fixture":"recovered"}',
      "utf8",
    );
    await utimes(
      join(targetHome, "auth.json"),
      new Date(1_000),
      new Date(1_000),
    );
    const entries: Array<Record<string, unknown>> = [];

    await writeBackAuthCredentials(
      sourceHome,
      targetHome,
      createLogger("debug", (entry) => entries.push(entry)),
    );

    const failure = entries.find(
      (entry) => entry.event === "codex_auth_write_back_failed",
    );
    assert.equal(failure?.level, "warn");
    assert.equal(typeof failure?.code, "string");
    assert.equal(String(failure?.error).includes(targetHome), true);
  }, "app-server-auth-write-back-failure-test-");
});

/** Complete generated server requests embedded in the fail-closed fake. */
const embeddedDeclinedRequests = JSON.stringify([
  protocolServerRequest({
    id: "input",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread_decline",
      turnId: "turn_decline",
      itemId: "item_input",
      questions: [],
      autoResolutionMs: null,
    },
  }),
  protocolServerRequest({
    id: "elicit",
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread_decline",
      turnId: "turn_decline",
      serverName: "fixture",
      mode: "url",
      _meta: null,
      message: "Open the fixture URL.",
      url: "https://example.invalid/fixture",
      elicitationId: "elicitation_decline",
    },
  }),
  protocolServerRequest({
    id: "command",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread_decline",
      turnId: "turn_decline",
      itemId: "item_command",
      startedAtMs: 0,
      environmentId: null,
    },
  }),
  protocolServerRequest({
    id: "file",
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "thread_decline",
      turnId: "turn_decline",
      itemId: "item_file",
      startedAtMs: 0,
    },
  }),
  protocolServerRequest({
    id: "permissions",
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thread_decline",
      turnId: "turn_decline",
      itemId: "item_permissions",
      environmentId: null,
      startedAtMs: 0,
      cwd: "/tmp/codex-test-root",
      reason: null,
      permissions: { network: null, fileSystem: null },
    },
  }),
  protocolServerRequest({
    id: "apply",
    method: "applyPatchApproval",
    params: {
      conversationId: "thread_decline",
      callId: "call_apply",
      fileChanges: {},
      reason: null,
      grantRoot: null,
    },
  }),
  protocolServerRequest({
    id: "exec",
    method: "execCommandApproval",
    params: {
      conversationId: "thread_decline",
      callId: "call_exec",
      approvalId: null,
      command: ["pwd"],
      cwd: "/tmp/codex-test-root",
      reason: null,
      parsedCmd: [{ type: "unknown", cmd: "pwd" }],
    },
  }),
  // This deliberately unknown method verifies the generic fail-closed response.
  { id: "unknown", method: "__proto__", params: {} },
]);

test("default Codex resolution uses the package-owned executable", () => {
  const executable = resolveCodexExecutable("codex");
  assert.notEqual(executable, "codex");
  assert.match(executable, /@openai[/\\]codex[/\\]bin[/\\]codex\.js$/);
});

test("explicit Codex paths override package resolution", () => {
  assert.equal(
    resolveCodexExecutable("/tmp/custom-codex"),
    "/tmp/custom-codex",
  );
});

test("package Codex uses Node while explicit executables remain direct", () => {
  const packageInvocation = resolveCodexInvocation("codex");
  assert.equal(packageInvocation.command, process.execPath);
  assert.match(
    packageInvocation.prefixArgs[0] ?? "",
    /@openai[/\\]codex[/\\]bin[/\\]codex\.js$/,
  );
  assert.deepEqual(resolveCodexInvocation("/tmp/custom-codex"), {
    command: "/tmp/custom-codex",
    prefixArgs: [],
  });
});

testWithPosixExecutable(
  "app-server initializes in order and declines elicitation without advertising it",
  async () => {
    await withTempDir(async (directory) => {
      const executable = join(directory, "codex");
      const capture = join(directory, "capture.jsonl");
      await writeFile(
        executable,
        fakeCodexScript({
          version: PINNED_CODEX_VERSION,
          setup: `const fs = require("node:fs");
const capture = ${JSON.stringify(capture)};
let initialized = false;`,
          onLine: (message) => `  fs.appendFileSync(capture, line + "\\n");
  if (${message}.method === "initialized" && !initialized) {
    initialized = true;
    for (const request of ${embeddedDeclinedRequests}) {
      console.log(JSON.stringify(request));
    }
  }`,
        }),
        "utf8",
      );
      await chmod(executable, 0o755);
      const logs: string[] = [];
      const app = await startAppServer({
        codexPath: executable,
        root: directory,
        startupTimeoutMs: 1_000,
        shutdownTimeoutMs: 100,
        log: createLogger("debug", (entry) => logs.push(JSON.stringify(entry))),
      });
      try {
        assert.deepEqual(app.requirements, {
          allowedApprovalPolicies: null,
          allowedApprovalsReviewers: null,
          allowedSandboxModes: null,
          allowedWebSearchModes: null,
        });
        // The final response proves every preceding request was handled and
        // captured; a fixed delay races slower child-process I/O on macOS CI.
        await waitForFileText(capture, '"id":"unknown"', 2_000);
        const messages = (await readFile(capture, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.equal(messages[0]?.method, "initialize");
        assert.equal(messages[1]?.method, "initialized");
        const params = messages[0]?.params as {
          capabilities: Record<string, unknown>;
          clientInfo: { name: string; version: string };
        };
        assert.deepEqual(params.capabilities, { experimentalApi: true });
        assert.equal(params.clientInfo.name, "codex-openai-proxy");
        assert.equal(params.clientInfo.version, CLIENT_VERSION);
        assert.deepEqual(messages[2], {
          id: 2,
          method: "configRequirements/read",
        });
        const response = (id: string): Record<string, unknown> | undefined =>
          messages.find((message) => message.id === id);
        assert.deepEqual(response("input"), {
          id: "input",
          result: { answers: {} },
        });
        assert.deepEqual(response("elicit"), {
          id: "elicit",
          result: { action: "decline", content: null },
        });
        for (const id of ["command", "file"])
          assert.deepEqual(response(id), {
            id,
            result: { decision: "decline" },
          });
        assert.deepEqual(response("permissions"), {
          id: "permissions",
          result: { permissions: {}, scope: "turn" },
        });
        for (const id of ["apply", "exec"])
          assert.deepEqual(response(id), {
            id,
            result: { decision: "denied" },
          });
        assert.deepEqual(response("unknown"), {
          id: "unknown",
          error: { code: -32601, message: "Unsupported server request" },
        });
        app.child.stderr.emit(
          "data",
          "2026-07-29T07:34:47Z ERROR codex_core::tools::router: error=dynamic tool call was can",
        );
        app.child.stderr.emit(
          "data",
          `celled before receiving a response\n${homedir()}/private-file\n`,
        );
        const stderrLogs = logs
          .map((entry) => JSON.parse(entry) as Record<string, unknown>)
          .filter((entry) => entry.event === "app_server_stderr");
        assert.equal(stderrLogs.length, 1);
        assert.equal(stderrLogs[0]?.level, "warn");
        assert.equal(stderrLogs[0]?.message, `${homedir()}/private-file`);
        assert.equal(
          logs.some((entry) => entry.includes("app_server_stderr_detail")),
          false,
        );
      } finally {
        await app.stop();
      }
    }, "app-server-test-");
  },
);

testWithPosixExecutable(
  "app-server installs the Responses Lite override before spawning Codex",
  async () => {
    await withTempDir(async (directory) => {
      const executable = join(directory, "codex");
      const codexHome = join(directory, "codex-home");
      const capture = join(directory, "capture.txt");
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        join(codexHome, "models_cache.json"),
        JSON.stringify({
          fetched_at: "fixture",
          models: [
            { slug: "gpt-5.6-sol", use_responses_lite: true },
            { slug: "gpt-5.4", use_responses_lite: false },
          ],
        }),
        "utf8",
      );
      await writeFile(
        executable,
        fakeCodexScript({
          version: PINNED_CODEX_VERSION,
          setup: `const fs = require("node:fs");
const path = require("node:path");
const home = process.env.CODEX_HOME;
const config = fs.readFileSync(path.join(home, "config.toml"), "utf8");
const catalog = JSON.parse(fs.readFileSync(path.join(home, ${JSON.stringify(
            RESPONSES_LITE_OVERRIDE_CATALOG_FILENAME,
          )}), "utf8"));
fs.writeFileSync(${JSON.stringify(
            capture,
          )}, JSON.stringify({ config, models: catalog.models }));`,
        }),
        "utf8",
      );
      await chmod(executable, 0o755);

      const app = await startAppServer({
        codexPath: executable,
        codexHome,
        root: directory,
        startupTimeoutMs: 1_000,
        shutdownTimeoutMs: 100,
        log: silentLogger,
      });
      try {
        assert.equal(app.responsesLiteOverrideApplied, true);
        const captured = JSON.parse(await readFile(capture, "utf8")) as {
          config: string;
          models: Array<Record<string, unknown>>;
        };
        assert.ok(captured.config.includes("model_catalog_json"));
        assert.deepEqual(
          captured.models.map((model) => model.use_responses_lite),
          [false, false],
        );
      } finally {
        await app.stop();
      }
    }, "app-server-responses-lite-override-test-");
  },
);

testWithPosixExecutable(
  "app-server spawns Codex with the isolated CODEX_HOME created up front",
  async () => {
    await withTempDir(async (directory) => {
      const executable = join(directory, "codex");
      const capture = join(directory, "capture.txt");
      const codexHome = join(directory, "isolated", "codex-home");
      await writeFile(
        executable,
        fakeCodexScript({
          version: PINNED_CODEX_VERSION,
          setup: `require("node:fs").writeFileSync(
  ${JSON.stringify(capture)},
  process.env.CODEX_HOME ?? "<unset>",
);`,
        }),
        "utf8",
      );
      await chmod(executable, 0o755);
      const app = await startAppServer({
        codexPath: executable,
        codexHome,
        // A seed source that does not exist must not fail startup.
        seedAuthFrom: join(directory, "missing-home"),
        root: directory,
        startupTimeoutMs: 1_000,
        shutdownTimeoutMs: 100,
        log: silentLogger,
      });
      try {
        assert.equal(app.responsesLiteOverrideApplied, false);
        assert.equal(await readFile(capture, "utf8"), codexHome);
        const homeStat = await stat(codexHome);
        assert.ok(homeStat.isDirectory());
        // Auth material lands in the Codex home, so it must be owner-only.
        assert.equal(homeStat.mode & 0o777, 0o700);
      } finally {
        await app.stop();
      }
    }, "app-server-codex-home-test-");
  },
);

testWithPosixExecutable(
  "app-server seeds from a source home and skips updates without one",
  async () => {
    await withTempDir(async (directory) => {
      const executable = join(directory, "codex");
      const sourceHome = join(directory, "source-home");
      const codexHome = join(directory, "codex-home");
      await mkdir(sourceHome, { recursive: true });
      await writeFile(
        join(sourceHome, "auth.json"),
        '{"fixture":"credentials"}',
        "utf8",
      );
      await writeFile(
        executable,
        fakeCodexScript({ version: PINNED_CODEX_VERSION }),
        "utf8",
      );
      await chmod(executable, 0o755);
      const startOptions = {
        codexPath: executable,
        codexHome,
        seedAuthFrom: sourceHome,
        root: directory,
        startupTimeoutMs: 1_000,
        shutdownTimeoutMs: 100,
        log: silentLogger,
      };
      const app = await startAppServer(startOptions);
      try {
        assert.equal(
          await readFile(join(codexHome, "auth.json"), "utf8"),
          '{"fixture":"credentials"}',
        );
        const authStat = await stat(join(codexHome, "auth.json"));
        assert.equal(authStat.mode & 0o777, 0o600);
      } finally {
        await app.stop();
      }
      await writeFile(
        join(sourceHome, "auth.json"),
        '{"fixture":"rotated"}',
        "utf8",
      );
      // An absent source is how the CLI encodes `--sync-auth never`, so a
      // rotated source must not reach an opted-out proxy-only login.
      const second = await startAppServer({
        ...startOptions,
        seedAuthFrom: undefined,
      });
      try {
        assert.equal(
          await readFile(join(codexHome, "auth.json"), "utf8"),
          '{"fixture":"credentials"}',
        );
      } finally {
        await second.stop();
      }
    }, "app-server-auth-seed-test-");
  },
);

testWithPosixExecutable(
  "app-server always seeding adopts newer source credentials and cleans temporary files",
  async () => {
    await withTempDir(async (directory) => {
      const executable = join(directory, "codex");
      const sourceHome = join(directory, "source-home");
      const codexHome = join(directory, "codex-home");
      const sourceAuth = join(sourceHome, "auth.json");
      const targetAuth = join(codexHome, "auth.json");
      await mkdir(sourceHome, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(sourceAuth, '{"fixture":"rotated"}', "utf8");
      await writeFile(targetAuth, '{"fixture":"stale"}', "utf8");
      await utimes(sourceAuth, new Date(), new Date(Date.now() + 5_000));
      await writeFile(
        executable,
        fakeCodexScript({ version: PINNED_CODEX_VERSION }),
        "utf8",
      );
      await chmod(executable, 0o755);
      const app = await startAppServer({
        codexPath: executable,
        codexHome,
        seedAuthFrom: sourceHome,
        root: directory,
        startupTimeoutMs: 1_000,
        shutdownTimeoutMs: 100,
        log: silentLogger,
      });
      try {
        assert.equal(
          await readFile(targetAuth, "utf8"),
          '{"fixture":"rotated"}',
        );
        assert.equal((await stat(targetAuth)).mode & 0o777, 0o600);
        assert.equal(
          (await readdir(codexHome)).some((entry) =>
            /^auth\.json\.\d+\.tmp$/.test(entry),
          ),
          false,
        );
      } finally {
        await app.stop();
      }
    }, "app-server-auth-always-seed-test-");
  },
);

testWithPosixExecutable(
  "app-server always seeding copies credentials into a missing target",
  async () => {
    await withTempDir(async (directory) => {
      const executable = join(directory, "codex");
      const sourceHome = join(directory, "source-home");
      const codexHome = join(directory, "codex-home");
      const sourceAuth = join(sourceHome, "auth.json");
      const targetAuth = join(codexHome, "auth.json");
      await mkdir(sourceHome, { recursive: true });
      await writeFile(sourceAuth, '{"fixture":"credentials"}', "utf8");
      await writeFile(
        executable,
        fakeCodexScript({ version: PINNED_CODEX_VERSION }),
        "utf8",
      );
      await chmod(executable, 0o755);
      const app = await startAppServer({
        codexPath: executable,
        codexHome,
        seedAuthFrom: sourceHome,
        root: directory,
        startupTimeoutMs: 1_000,
        shutdownTimeoutMs: 100,
        log: silentLogger,
      });
      try {
        assert.equal(
          await readFile(targetAuth, "utf8"),
          '{"fixture":"credentials"}',
        );
        assert.equal((await stat(targetAuth)).mode & 0o777, 0o600);
        assert.equal(
          (await readdir(codexHome)).some((entry) =>
            /^auth\.json\.\d+\.tmp$/.test(entry),
          ),
          false,
        );
      } finally {
        await app.stop();
      }
    }, "app-server-auth-always-missing-target-test-");
  },
);

testWithPosixExecutable(
  "app-server always seeding keeps newer target credentials",
  async () => {
    await withTempDir(async (directory) => {
      const executable = join(directory, "codex");
      const sourceHome = join(directory, "source-home");
      const codexHome = join(directory, "codex-home");
      const sourceAuth = join(sourceHome, "auth.json");
      const targetAuth = join(codexHome, "auth.json");
      await mkdir(sourceHome, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(sourceAuth, '{"fixture":"stale"}', "utf8");
      await writeFile(targetAuth, '{"fixture":"rotated"}', "utf8");
      await utimes(sourceAuth, new Date(1_000), new Date(1_000));
      await writeFile(
        executable,
        fakeCodexScript({ version: PINNED_CODEX_VERSION }),
        "utf8",
      );
      await chmod(executable, 0o755);
      const app = await startAppServer({
        codexPath: executable,
        codexHome,
        seedAuthFrom: sourceHome,
        root: directory,
        startupTimeoutMs: 1_000,
        shutdownTimeoutMs: 100,
        log: silentLogger,
      });
      try {
        assert.equal(
          await readFile(targetAuth, "utf8"),
          '{"fixture":"rotated"}',
        );
      } finally {
        await app.stop();
      }
    }, "app-server-auth-newer-target-test-");
  },
);

testWithPosixExecutable(
  "app-server always seeding keeps target when source is missing",
  async () => {
    await withTempDir(async (directory) => {
      const executable = join(directory, "codex");
      const codexHome = join(directory, "codex-home");
      const targetAuth = join(codexHome, "auth.json");
      await mkdir(codexHome, { recursive: true });
      await writeFile(targetAuth, '{"fixture":"target"}', "utf8");
      await writeFile(
        executable,
        fakeCodexScript({ version: PINNED_CODEX_VERSION }),
        "utf8",
      );
      await chmod(executable, 0o755);
      const entries: Array<Record<string, unknown>> = [];
      const app = await startAppServer({
        codexPath: executable,
        codexHome,
        seedAuthFrom: join(directory, "missing-home"),
        root: directory,
        startupTimeoutMs: 1_000,
        shutdownTimeoutMs: 100,
        log: createLogger("debug", (entry) => entries.push(entry)),
      });
      try {
        assert.equal(
          await readFile(targetAuth, "utf8"),
          '{"fixture":"target"}',
        );
        assert.equal(
          entries.some((entry) => entry.event === "codex_auth_seed_failed"),
          false,
        );
      } finally {
        await app.stop();
      }
    }, "app-server-auth-missing-source-test-");
  },
);

testWithPosixExecutable(
  "auth-seed failures are logged plainly and do not block startup",
  async () => {
    await withTempDir(async (directory) => {
      const executable = join(directory, "codex");
      const sourceHome = join(directory, "private-source-home");
      const codexHome = join(directory, "codex-home");
      await mkdir(join(sourceHome, "auth.json"), { recursive: true });
      await writeFile(
        executable,
        fakeCodexScript({ version: PINNED_CODEX_VERSION }),
        "utf8",
      );
      await chmod(executable, 0o755);
      const entries: Array<Record<string, unknown>> = [];
      const app = await startAppServer({
        codexPath: executable,
        codexHome,
        seedAuthFrom: sourceHome,
        root: directory,
        startupTimeoutMs: 1_000,
        shutdownTimeoutMs: 100,
        log: createLogger("debug", (entry) => entries.push(entry)),
      });
      try {
        const failure = entries.find(
          (entry) => entry.event === "codex_auth_seed_failed",
        );
        assert.equal(failure?.level, "warn");
        assert.equal(typeof failure?.code, "string");
        assert.equal(String(failure?.error).includes(sourceHome), true);
        assert.equal(
          entries.some(
            (entry) => entry.event === "codex_auth_seed_failed_detail",
          ),
          false,
        );
      } finally {
        await app.stop();
      }
    }, "app-server-auth-seed-failure-test-");
  },
);

testWithPosixExecutable(
  "app-server bounds a Codex version check that never exits",
  async () => {
    await withTempDir(async (directory) => {
      const executable = join(directory, "codex");
      await writeFile(
        executable,
        `#!${process.execPath}\nsetInterval(() => {}, 1_000);\n`,
        "utf8",
      );
      await chmod(executable, 0o755);
      await assert.rejects(
        startAppServer({
          codexPath: executable,
          root: directory,
          startupTimeoutMs: 20,
          shutdownTimeoutMs: 100,
          log: silentLogger,
        }),
        /Codex version check timed out/,
      );
    }, "app-server-version-timeout-test-");
  },
);

testWithPosixExecutable(
  "app-server bounds initialization and terminates the child on failure",
  async () => {
    await withTempDir(async (directory) => {
      const executable = join(directory, "codex");
      const stopped = join(directory, "stopped");
      await writeFile(
        executable,
        `#!${process.execPath}\nconst fs=require('fs'); const path=require('path');\nif(process.argv.includes('--version')) { console.log('codex-cli ${PINNED_CODEX_VERSION}'); process.exit(0); }\nprocess.on('SIGTERM', () => { fs.writeFileSync(path.join(path.dirname(process.argv[1]),'stopped'),'yes'); process.exit(0); }); process.stdin.resume();\n`,
        "utf8",
      );
      await chmod(executable, 0o755);
      await assert.rejects(
        startAppServer({
          codexPath: executable,
          root: directory,
          startupTimeoutMs: 500,
          shutdownTimeoutMs: 100,
          log: silentLogger,
        }),
        /initialize timed out/,
      );
      assert.equal(await readFile(stopped, "utf8"), "yes");
    }, "app-server-timeout-test-");
  },
);

testWithPosixExecutable(
  "app-server cancellation terminates version and initialization children",
  async () => {
    for (const phase of ["version", "initialize"] as const) {
      await withTempDir(async (directory) => {
        const executable = join(directory, "codex");
        const started = join(directory, "started");
        await writeFile(
          executable,
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
        await chmod(executable, 0o755);
        const controller = new AbortController();
        const startup = startAppServer({
          codexPath: executable,
          root: directory,
          startupTimeoutMs: 30_000,
          shutdownTimeoutMs: 100,
          log: silentLogger,
          signal: controller.signal,
        });
        await waitForFile(started, 2_000);
        controller.abort(new Error(`cancel ${phase}`));
        await assert.rejects(startup, new RegExp(`cancel ${phase}`));
      }, `app-server-${phase}-cancel-test-`);
    }
  },
);

testWithPosixExecutable(
  "startup fails when managed policy allows no usable approval policy",
  async () => {
    await withTempDir(async (directory) => {
      const executable = join(directory, "codex");
      const emptyApprovalRequirements = protocolResponse(
        "configRequirements/read",
        0,
        {
          requirements: {
            allowedApprovalPolicies: [],
            allowedApprovalsReviewers: null,
            allowedSandboxModes: null,
            allowedWindowsSandboxImplementations: null,
            allowedPermissionProfiles: null,
            defaultPermissions: null,
            allowedWebSearchModes: null,
            allowManagedHooksOnly: null,
            allowAppshots: null,
            allowRemoteControl: null,
            computerUse: null,
            browserUse: null,
            featureRequirements: null,
            hooks: null,
            enforceResidency: null,
            network: null,
            models: null,
            sqliteHome: null,
            logDir: null,
            modelCatalogJson: null,
            checkForUpdateOnStartup: null,
            allowLoginShell: null,
            feedback: null,
            windowsSandboxPrivateDesktop: null,
          },
        },
      ).result;
      await writeFile(
        executable,
        fakeCodexScript({
          version: PINNED_CODEX_VERSION,
          requirementsResponse: emptyApprovalRequirements,
        }),
        "utf8",
      );
      await chmod(executable, 0o755);
      // An allowlist that permits no proxy-supported approval policy is a deployment
      // misconfiguration; it must fail startup rather than surface later as a
      // per-request 400 blaming the client's x_codex.
      await assert.rejects(
        startAppServer({
          codexPath: executable,
          root: directory,
          startupTimeoutMs: 1_000,
          shutdownTimeoutMs: 100,
          log: silentLogger,
        }),
        (error: unknown) =>
          error instanceof Error &&
          /no supported non-interactive approval policy/.test(error.message),
      );
    }, "app-server-managed-test-");
  },
);

testWithPosixExecutable(
  "startup rejects a Codex executable outside the pinned contract",
  async () => {
    await withTempDir(async (directory) => {
      const executable = join(directory, "codex");
      await writeFile(
        executable,
        fakeCodexScript({ version: "0.0.1" }),
        "utf8",
      );
      await chmod(executable, 0o755);
      await assert.rejects(
        startAppServer({
          codexPath: executable,
          root: directory,
          startupTimeoutMs: 1_000,
          shutdownTimeoutMs: 100,
          log: silentLogger,
        }),
        new RegExp(
          `Unsupported Codex version 0\\.0\\.1; expected ${PINNED_CODEX_VERSION.replaceAll(".", "\\.")}`,
        ),
      );
    }, "app-server-version-test-");
  },
);
