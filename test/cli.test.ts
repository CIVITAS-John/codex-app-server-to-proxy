import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "vitest";

test("CLI rejects unsafe binds before opening a socket", async () => {
  const child = spawn(
    process.execPath,
    ["dist/bin.js", "serve", "--host", "0.0.0.0"],
    { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
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
  const child = spawn(
    process.execPath,
    ["dist/bin.js", "serve", "--port", "0", "--root", "."],
    { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  while (!stderr.includes("server_listening")) {
    await once(child.stderr, "data");
  }
  child.kill("SIGTERM");
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.match(stderr, /shutdown_complete/);
});
