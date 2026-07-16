import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { test } from "vitest";
import {
  PINNED_CODEX_VERSION,
  resolveCodexExecutable,
  startAppServer,
} from "../../src/app-server/app-server.js";
import { createLogger } from "../../src/core/logger.js";

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

test("app-server initializes in order and declines elicitation without advertising it", async () => {
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
  if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}}));
  else if(m.method==='initialized'&&!initialized) {
    initialized=true;
    for (const request of [
      {id:'elicit',method:'mcpServer/elicitation/request',params:{mode:'url'}},
      {id:'command',method:'item/commandExecution/requestApproval',params:{}},
      {id:'file',method:'item/fileChange/requestApproval',params:{}},
      {id:'permissions',method:'item/permissions/requestApproval',params:{}},
      {id:'apply',method:'applyPatchApproval',params:{}},
      {id:'exec',method:'execCommandApproval',params:{}},
    ]) console.log(JSON.stringify(request));
  }
  else if(m.method==='configRequirements/read') console.log(JSON.stringify({id:m.id,result:{requirements:null}}));
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
});

test("app-server bounds initialization and terminates the child on failure", async () => {
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
});

test("startup fails when managed policy allows no usable approval policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-server-managed-test-"));
  const executable = join(directory, "codex");
  await writeFile(
    executable,
    `#!${process.execPath}
if(process.argv.includes('--version')) { console.log('codex-cli ${PINNED_CODEX_VERSION}'); process.exit(0); }
const rl=require('readline').createInterface({input:process.stdin});
rl.on('line', line => {
  const m=JSON.parse(line);
  if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}}));
  else if(m.method==='configRequirements/read') console.log(JSON.stringify({id:m.id,result:{requirements:{allowedApprovalPolicies:[]}}}));
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
});

test("startup rejects a Codex executable outside the pinned contract", async () => {
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
});
