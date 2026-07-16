import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "vitest";
import { APP_SERVER_RECOVERY_DELAYS_MS } from "../../src/cli/cli.js";
import { repoRootPath } from "../support/repo-root.js";

test("CLI recovery uses the documented bounded retry schedule", () => {
  assert.deepEqual(
    APP_SERVER_RECOVERY_DELAYS_MS,
    [1_000, 3_000, 5_000, 10_000],
  );
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

test("CLI exits cleanly after a termination signal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-test-"));
  const fake = join(directory, "codex");
  await writeFile(
    fake,
    `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(0); }
const rl=require('readline').createInterface({input:process.stdin});
rl.on('line', line => {
  const m=JSON.parse(line);
  if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}}));
  if(m.method==='configRequirements/read') console.log(JSON.stringify({id:m.id,result:{requirements:null}}));
  if(m.method==='account/read') console.log(JSON.stringify({id:m.id,result:{account:{type:'chatgpt'},requiresOpenaiAuth:true}}));
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
  assert.equal(stderr.includes(repoRootPath), false);
  await rm(directory, { recursive: true });
});
