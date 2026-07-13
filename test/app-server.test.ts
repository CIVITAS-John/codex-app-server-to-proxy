import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "vitest";
import { startAppServer } from "../src/app-server.js";
import { createLogger } from "../src/logger.js";

test("app-server initializes in order and declines elicitation without advertising it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-server-test-"));
  const executable = join(directory, "codex");
  const capture = join(directory, "capture.jsonl");
  await writeFile(
    executable,
    `#!${process.execPath}\nconst fs=require('fs'); const path=require('path'); const capture=path.join(path.dirname(process.argv[1]),'capture.jsonl');\nif(process.argv.includes('--version')) { console.log('codex-cli 1.2.3'); process.exit(0); }\nconst rl=require('readline').createInterface({input:process.stdin}); let initialized=false;\nrl.on('line', line => { const m=JSON.parse(line); fs.appendFileSync(capture, line+'\\n'); if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}})); else if(m.method==='initialized'&&!initialized) { initialized=true; console.log(JSON.stringify({id:'elicit',method:'mcpServer/elicitation/request',params:{mode:'url'}})); } });\n`,
    "utf8",
  );
  await chmod(executable, 0o755);
  const app = await startAppServer({
    codexPath: executable,
    root: directory,
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 100,
    log: createLogger("error", () => {}),
  });
  try {
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
      id: "elicit",
      result: { action: "decline", content: null },
    });
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
    `#!${process.execPath}\nconst fs=require('fs'); const path=require('path');\nif(process.argv.includes('--version')) { console.log('codex-cli 1.2.3'); process.exit(0); }\nprocess.on('SIGTERM', () => { fs.writeFileSync(path.join(path.dirname(process.argv[1]),'stopped'),'yes'); process.exit(0); }); process.stdin.resume();\n`,
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
