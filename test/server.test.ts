import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test } from "vitest";
import { parseServeOptions, type ServeOptions } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createProxyServer, type ProxyServer } from "../src/server.js";

const silentLogger = createLogger("error", () => {});

function options(overrides: Partial<ServeOptions> = {}): ServeOptions {
  return { ...parseServeOptions(["--port", "0"]), ...overrides };
}

async function withServer(
  overrides: Partial<ServeOptions>,
  run: (origin: string, proxy: ProxyServer) => Promise<void>,
): Promise<void> {
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

test("health is live while readiness remains false", async () => {
  await withServer({}, async (origin, proxy) => {
    let response = await fetch(`${origin}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
    assert.match(response.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
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
    const cases: Array<[Promise<Response>, number, string]> = [
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
      const body = (await response.json()) as {
        error: { code: string; param: unknown };
      };
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
      const result = (await response.json()) as { error: { code: string } };
      assert.equal(result.error.code, "body_too_large");
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
    assert(response instanceof http.IncomingMessage);
    assert.equal(response.statusCode, 408);
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      body += chunk;
    });
    await once(response, "end");
    assert.equal(
      (JSON.parse(body) as { error: { code: string } }).error.code,
      "request_timeout",
    );
    request.destroy();
  });
});
