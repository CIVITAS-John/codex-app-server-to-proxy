import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { test } from "vitest";
import {
  PINNED_CODEX_VERSION,
  resolveCodexExecutable,
  resolveCodexInvocation,
  startAppServer,
} from "../../src/app-server/app-server.js";
import { createLogger } from "../../src/core/logger.js";
import {
  protocolInitializeResponse,
  protocolResponse,
  protocolServerRequest,
} from "../support/protocol-fixtures.js";

/** Skips fake shebang executables that Windows cannot spawn without a shell. */
const testWithPosixExecutable = test.skipIf(process.platform === "win32");

/** Generated initialize result embedded in fake child-process scripts. */
const embeddedInitializeResult = JSON.stringify(protocolInitializeResponse());

/** Generated unrestricted requirements result embedded in fake scripts. */
const embeddedRequirementsResult = JSON.stringify(
  protocolResponse("configRequirements/read", 0, { requirements: null }).result,
);

/** Complete generated server requests embedded in the fail-closed fake. */
const embeddedDeclinedRequests = JSON.stringify([
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
]);

/** Waits until a fake executable reports that its blocking phase began. */
async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for fake app-server marker ${path}`);
}

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
    const directory = await mkdtemp(join(tmpdir(), "app-server-test-"));
    const executable = join(directory, "codex");
    const capture = join(directory, "capture.jsonl");
    await writeFile(
      executable,
      `#!${process.execPath}
const fs=require('fs'); const path=require('path');
const capture=path.join(path.dirname(process.argv[1]),'capture.jsonl');
if(process.argv.includes('--version')) { console.log('codex-cli ${PINNED_CODEX_VERSION}'); process.exit(0); }
const rl=require('readline').createInterface({input:process.stdin}); let initialized=false;
rl.on('line', line => {
  const m=JSON.parse(line); fs.appendFileSync(capture, line+'\\n');
  if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:${embeddedInitializeResult}}));
  else if(m.method==='initialized'&&!initialized) {
    initialized=true;
    for (const request of ${embeddedDeclinedRequests}) console.log(JSON.stringify(request));
  }
  else if(m.method==='configRequirements/read') console.log(JSON.stringify({id:m.id,result:${embeddedRequirementsResult}}));
});
`,
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
      diagnosticLogging: true,
    });
    try {
      assert.deepEqual(app.requirements, {
        allowedApprovalPolicies: null,
        allowedApprovalsReviewers: null,
        allowedSandboxModes: null,
        allowedWebSearchModes: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const messages = (await readFile(capture, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(messages[0]?.method, "initialize");
      assert.equal(messages[1]?.method, "initialized");
      const params = messages[0]?.params as {
        capabilities: Record<string, unknown>;
        clientInfo: { name: string };
      };
      assert.deepEqual(params.capabilities, { experimentalApi: true });
      assert.equal(params.clientInfo.name, "codex-openai-proxy");
      assert.deepEqual(messages[2], {
        id: 2,
        method: "configRequirements/read",
      });
      const response = (id: string): Record<string, unknown> | undefined =>
        messages.find((message) => message.id === id);
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
      app.child.stderr.emit("data", `${homedir()}/private-file`);
      assert.doesNotMatch(logs.join(""), new RegExp(homedir()));
      assert.match(logs.join(""), /\[REDACTED_HOME\]/);
    } finally {
      await app.stop();
      await rm(directory, { recursive: true });
    }
  },
);

testWithPosixExecutable(
  "app-server bounds initialization and terminates the child on failure",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "app-server-timeout-test-"));
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
        log: createLogger("error", () => {}),
      }),
      /initialize timed out/,
    );
    assert.equal(await readFile(stopped, "utf8"), "yes");
    await rm(directory, { recursive: true });
  },
);

testWithPosixExecutable(
  "app-server cancellation terminates version and initialization children",
  async () => {
    for (const phase of ["version", "initialize"] as const) {
      const directory = await mkdtemp(
        join(tmpdir(), `app-server-${phase}-cancel-test-`),
      );
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
        log: createLogger("error", () => {}),
        signal: controller.signal,
      });
      await waitForFile(started);
      controller.abort(new Error(`cancel ${phase}`));
      await assert.rejects(startup, new RegExp(`cancel ${phase}`));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

testWithPosixExecutable(
  "startup fails when managed policy allows no usable approval policy",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "app-server-managed-test-"));
    const executable = join(directory, "codex");
    const emptyApprovalRequirements = JSON.stringify(
      protocolResponse("configRequirements/read", 0, {
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
          featureRequirements: null,
          hooks: null,
          enforceResidency: null,
          network: null,
          models: null,
        },
      }).result,
    );
    await writeFile(
      executable,
      `#!${process.execPath}
if(process.argv.includes('--version')) { console.log('codex-cli ${PINNED_CODEX_VERSION}'); process.exit(0); }
const rl=require('readline').createInterface({input:process.stdin});
rl.on('line', line => {
  const m=JSON.parse(line);
  if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:${embeddedInitializeResult}}));
  else if(m.method==='configRequirements/read') console.log(JSON.stringify({id:m.id,result:${emptyApprovalRequirements}}));
});
`,
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
        log: createLogger("error", () => {}),
      }),
      (error: unknown) =>
        error instanceof Error &&
        /no supported non-interactive approval policy/.test(error.message),
    );
    await rm(directory, { recursive: true });
  },
);

testWithPosixExecutable(
  "startup rejects a Codex executable outside the pinned contract",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "app-server-version-test-"));
    const executable = join(directory, "codex");
    await writeFile(
      executable,
      `#!${process.execPath}\nif(process.argv.includes('--version')) { console.log('codex-cli 0.0.1'); process.exit(0); }\n`,
      "utf8",
    );
    await chmod(executable, 0o755);
    try {
      await assert.rejects(
        startAppServer({
          codexPath: executable,
          root: directory,
          startupTimeoutMs: 1_000,
          shutdownTimeoutMs: 100,
          log: createLogger("error", () => {}),
        }),
        new RegExp(
          `Unsupported Codex version 0\\.0\\.1; expected ${PINNED_CODEX_VERSION.replaceAll(".", "\\.")}`,
        ),
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  },
);
