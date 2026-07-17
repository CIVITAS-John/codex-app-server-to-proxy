import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  parseServeOptions,
  resolveServeOptions,
  type ServeOptions,
} from "../../src/core/config.js";
import { createLogger } from "../../src/core/logger.js";
import { createProxyServer, type ProxyServer } from "../../src/http/server.js";
import { silentLogger } from "../support/logger.js";

/** Builds safe ephemeral listener options for a server test. */
async function options(
  overrides: Partial<ServeOptions> = {},
): Promise<ServeOptions> {
  return {
    ...(await resolveServeOptions(
      parseServeOptions([
        "--port",
        "0",
        "--state-dir",
        join(tmpdir(), `codex-proxy-server-test-${process.pid}`),
      ]),
    )),
    ...overrides,
  };
}

/** Runs a test callback against an ephemeral proxy and always closes it. */
async function withServer(
  overrides: Partial<ServeOptions>,
  run: (origin: string, proxy: ProxyServer) => Promise<void>,
): Promise<void> {
  const proxy = createProxyServer(await options(overrides), silentLogger);
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

test("every route rejects missing, malformed, and non-loopback Host headers", async () => {
  await withServer({}, async (origin) => {
    const url = new URL(origin);
    const request = (host: string | undefined): Promise<http.IncomingMessage> =>
      new Promise((resolve, reject) => {
        const headers = host === undefined ? {} : { host };
        const pending = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: "/health",
            method: "GET",
            headers,
            setHost: false,
          },
          resolve,
        );
        pending.once("error", reject);
        pending.end();
      });

    const socket = net.connect(Number(url.port), url.hostname);
    await once(socket, "connect");
    socket.end("GET /health HTTP/1.0\r\n\r\n");
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (raw += chunk));
    await once(socket, "close");
    assert.match(raw, /^HTTP\/1\.1 403 /);
    assert.equal(
      (
        JSON.parse(raw.slice(raw.indexOf("\r\n\r\n") + 4)) as {
          error: { code: string };
        }
      ).error.code,
      "invalid_host_header",
    );

    for (const host of [
      "evil.example",
      "127.0.0.2",
      "localhost:0",
      "localhost:65536",
      "localhost:not-a-port",
    ]) {
      const response = await request(host);
      assert.equal(response.statusCode, 403);
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      await once(response, "end");
      assert.equal(
        (JSON.parse(body) as { error: { code: string } }).error.code,
        "invalid_host_header",
      );
    }

    for (const host of [
      "localhost",
      `localhost:${url.port}`,
      "127.0.0.1",
      `127.0.0.1:${url.port}`,
      "[::1]",
      `[::1]:${url.port}`,
    ])
      assert.equal((await request(host)).statusCode, 200);
  });
});

test("every route rejects browser Origin headers", async () => {
  await withServer({}, async (origin) => {
    for (const [path, init] of [
      ["/health", {}],
      ["/ready", {}],
      ["/missing", {}],
      [
        "/v1/chat/completions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      ],
    ] as const) {
      const headers = new Headers(init.headers);
      headers.set("origin", "https://hostile.example");
      const response = await fetch(`${origin}${path}`, { ...init, headers });
      assert.equal(response.status, 403);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        "invalid_origin_header",
      );
    }
  });
});

test("default request logs retain only the pathname", async () => {
  const entries: Array<Record<string, unknown>> = [];
  const proxy = createProxyServer(
    await options({}),
    createLogger("info", (entry) => entries.push(entry)),
  );
  const address = await proxy.listen();
  const origin = `http://${address.address}:${address.port}`;
  try {
    await fetch(`${origin}/health?token=secret-value`);
  } finally {
    await proxy.close();
  }
  const request = entries.find((entry) => entry.event === "http_request");
  assert.equal(request?.path, "/health");
  assert.equal(JSON.stringify(entries).includes("secret-value"), false);
});

test("authority-rejected requests still emit an http_request log entry", async () => {
  const entries: Array<Record<string, unknown>> = [];
  const proxy = createProxyServer(
    await options({}),
    createLogger("info", (entry) => entries.push(entry)),
  );
  const address = await proxy.listen();
  const origin = `http://${address.address}:${address.port}`;
  try {
    const headers = new Headers();
    headers.set("origin", "https://hostile.example");
    const response = await fetch(`${origin}/health`, { headers });
    assert.equal(response.status, 403);
  } finally {
    await proxy.close();
  }
  const request = entries.find((entry) => entry.event === "http_request");
  assert.equal(request?.status, 403);
  assert.equal(request?.path, "/health");
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

/**
 * Polls /health until it reports the expected status, because the server
 * counts a request against capacity only after accepting it and releases
 * capacity only after observing the disconnect.
 */
async function pollHealth(origin: string, expected: number): Promise<Response> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const response = await fetch(`${origin}/health`);
    if (response.status === expected || Date.now() >= deadline) return response;
    await response.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("capacity rejects with overloaded and a disconnect releases it", async () => {
  await withServer({ maxRequests: 1 }, async (origin) => {
    const url = new URL(origin);
    const socket = net.connect(Number(url.port), url.hostname);
    await once(socket, "connect");
    socket.write(
      "POST /v1/chat/completions HTTP/1.1\r\n" +
        `Host: ${url.host}\r\n` +
        "Content-Type: application/json\r\n" +
        "Content-Length: 2\r\n\r\n",
    );
    const overloaded = await pollHealth(origin, 429);
    assert.equal(overloaded.status, 429);
    assert.equal(
      ((await overloaded.json()) as { error: { code: string } }).error.code,
      "overloaded",
    );
    socket.destroy();
    await once(socket, "close");
    const response = await pollHealth(origin, 200);
    assert.equal(response.status, 200);
  });
});
