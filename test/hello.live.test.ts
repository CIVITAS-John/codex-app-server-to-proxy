import assert from "node:assert/strict";
import { test } from "vitest";
import { startAppServer, type AppServer } from "../src/app-server.js";
import { ensureAuthenticated } from "../src/auth.js";
import { parseServeOptions } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createProxyServer, type ProxyServer } from "../src/server.js";

/** Model fixed by the repository's live-test cost policy. */
const LIVE_MODEL = "gpt-5.4-mini";

/** Maximum assistant characters retained or printed by this smoke test. */
const MAX_CAPTURED_OUTPUT = 1_000;

/** Runs only when the caller has explicitly opted into a paid live request. */
const liveTest = process.env.CODEX_PROXY_LIVE === "1" ? test : test.skip;

liveTest(
  "real app-server answers a hello-world request through the HTTP proxy",
  async () => {
    const root = process.cwd();
    const codexPath = process.env.CODEX_PATH ?? "codex";
    const log = createLogger("error", () => {});
    let appServer: AppServer | undefined;
    let proxy: ProxyServer | undefined;
    try {
      appServer = await startAppServer({
        codexPath,
        root,
        startupTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000,
        log,
      });
      await ensureAuthenticated({
        rpc: appServer.rpc,
        log,
        timeoutMs: 120_000,
        interactive: Boolean(process.stderr.isTTY),
        terminal: (message) => process.stderr.write(message),
      });
      const options = parseServeOptions([
        "--port",
        "0",
        "--request-timeout",
        "2m",
      ]);
      proxy = createProxyServer(options, log);
      proxy.setTransport(appServer.rpc);
      proxy.setReady(true);
      const address = await proxy.listen();
      const host = address.address.includes(":")
        ? `[${address.address}]`
        : address.address;
      const response = await fetch(
        `http://${host}:${address.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: LIVE_MODEL,
            messages: [
              {
                role: "user",
                content: 'Reply with exactly "Hello, world!" and nothing else.',
              },
            ],
            stream: false,
          }),
        },
      );
      const raw = (await response.text()).slice(0, MAX_CAPTURED_OUTPUT);
      assert.equal(response.status, 200, raw);
      const body = JSON.parse(raw) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string")
        assert.fail("Live response did not contain assistant text.");
      assert.match(content, /hello, world!/i);
      process.stdout.write(`live hello: ${content.slice(0, 100)}\n`);
    } finally {
      proxy?.setReady(false);
      proxy?.setTransport(undefined);
      await proxy?.close().catch(() => undefined);
      await appServer?.stop().catch(() => undefined);
    }
  },
  180_000,
);
