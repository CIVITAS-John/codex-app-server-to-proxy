import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { normalizeLoopbackHost, parseServeOptions } from "../dist/config.js";
import { createLogger } from "../dist/logger.js";
import { createProxyServer } from "../dist/server.js";

const silentLogger = createLogger("error", () => {});

function options(overrides = {}) {
  return { ...parseServeOptions(["--port", "0"]), ...overrides };
}

async function withServer(overrides, run) {
  const proxy = createProxyServer(options(overrides), silentLogger);
  const address = await proxy.listen();
  try {
    await run(
      `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`,
      proxy,
    );
  } finally {
    await proxy.close();
  }
}

test("loopback validation accepts only exact safe forms", () => {
  assert.equal(normalizeLoopbackHost("127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeLoopbackHost("::1"), "::1");
  assert.equal(normalizeLoopbackHost("LOCALHOST"), "127.0.0.1");
  for (const host of [
    "0.0.0.0",
    "::",
    "192.168.1.2",
    "example.test",
    "127.0.0.2",
    "::ffff:127.0.0.1",
    "[::1]",
    "localhost.",
  ]) {
    assert.throws(
      () => normalizeLoopbackHost(host),
      /Only 127\.0\.0\.1, ::1, and localhost/,
    );
  }
});

test("serve options have safe documented defaults and reject ambiguity", () => {
  const parsed = parseServeOptions([], "/tmp/project");
  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(parsed.port, 8787);
  assert.equal(parsed.root, "/tmp/project");
  assert.equal(parsed.toolTimeoutMs, 300_000);
  assert.equal(parsed.stateDir, "/tmp/project/.codex-openai-proxy");
  assert.throws(
    () => parseServeOptions(["--port", "80", "--port", "81"]),
    /Duplicate/,
  );
  assert.throws(() => parseServeOptions(["--unknown", "x"]), /Unknown/);
});

test("health is live while readiness remains false", async () => {
  await withServer({}, async (origin, proxy) => {
    let response = await fetch(`${origin}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
    assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
    response = await fetch(`${origin}/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "not_ready" });
    proxy.setReady(true);
    response = await fetch(`${origin}/ready`);
    assert.equal(response.status, 200);
  });
});

test("HTTP failures use OpenAI-shaped JSON and never leak warnings", async () => {
  await withServer({}, async (origin) => {
    const cases = [
      [fetch(`${origin}/missing`), 404, "route_not_found"],
      [
        fetch(`${origin}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
        400,
        "invalid_json",
      ],
      [
        fetch(`${origin}/v1/chat/completions`, { method: "POST", body: "{}" }),
        415,
        "unsupported_media_type",
      ],
      [
        fetch(`${origin}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        503,
        "app_server_not_ready",
      ],
    ];
    for (const [pending, status, code] of cases) {
      const response = await pending;
      assert.equal(response.status, status);
      const body = await response.json();
      assert.deepEqual(Object.keys(body), ["error"]);
      assert.equal(body.error.code, code);
      assert.equal(body.error.param, null);
    }
  });
});

test("body limit applies to declared and streamed bodies", async () => {
  await withServer({ bodyLimitBytes: 8 }, async (origin) => {
    for (const body of [JSON.stringify({ value: "too long" }), "123456789"]) {
      const response = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(response.status, 413);
      assert.equal((await response.json()).error.code, "body_too_large");
    }
  });
});

test("an incomplete request receives the configured timeout error", async () => {
  await withServer({ requestTimeoutMs: 50 }, async (origin) => {
    const url = new URL(origin);
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "2" },
    });
    request.flushHeaders();
    const [response] = await once(request, "response");
    assert.equal(response.statusCode, 408);
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      body += chunk;
    });
    await once(response, "end");
    assert.equal(JSON.parse(body).error.code, "request_timeout");
    request.destroy();
  });
});

test("CLI rejects unsafe binds before opening a socket", async () => {
  const child = spawn(
    process.execPath,
    ["dist/bin.js", "serve", "--host", "0.0.0.0"],
    { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
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
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  while (!stderr.includes("server_listening")) await once(child.stderr, "data");
  child.kill("SIGTERM");
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.match(stderr, /shutdown_complete/);
});
