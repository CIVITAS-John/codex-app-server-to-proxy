import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "vitest";
import { ensureAuthenticated } from "../../src/app-server/auth.js";
import { JsonRpcTransport } from "../../src/app-server/json-rpc.js";
import { createLogger } from "../../src/core/logger.js";
import { silentLogger } from "../support/logger.js";
import {
  protocolAuthenticatedAccountResponse,
  protocolNotification,
  protocolResponse,
} from "../support/protocol-fixtures.js";

/** Authentication scenario simulated by fakeRpc. */
type LoginKind =
  | "logged-in"
  | "missing-requirement"
  | "malformed-requirement"
  | "browser"
  | "early"
  | "device"
  | "failure"
  | "timeout"
  | "stall-read"
  | "stall-start"
  | "close"
  | "refresh-error"
  | "refresh-error-logout-fails"
  | "refresh-error-still-unauthenticated";

/** Creates an in-memory app-server authentication transport. */
function fakeRpc(
  kind: LoginKind,
  observeRequest?: (method: string) => void,
): JsonRpcTransport {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new JsonRpcTransport(input, output);
  let buffered = "";
  let readCount = 0;
  output.setEncoding("utf8").on("data", (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const message = JSON.parse(buffered.slice(0, newline)) as {
        id: number;
        method: string;
        params: { type?: string };
      };
      buffered = buffered.slice(newline + 1);
      observeRequest?.(message.method);
      if (message.method === "account/read") {
        // A probe the app-server never answers must be deadline-bounded.
        if (kind === "stall-read") continue;
        readCount += 1;
        if (
          (kind === "refresh-error" ||
            kind === "refresh-error-logout-fails" ||
            kind === "refresh-error-still-unauthenticated") &&
          readCount === 1
        ) {
          // Use an unwrapped JSON-RPC error frame, as the app-server does.
          input.write(
            `${JSON.stringify({ id: message.id, error: { code: -32000, message: "ROTATED_REFRESH_TOKEN_SECRET" } })}\n`,
          );
        } else if (kind === "refresh-error-still-unauthenticated") {
          input.write(
            `${JSON.stringify(protocolResponse("account/read", message.id, { account: null, requiresOpenaiAuth: true }))}\n`,
          );
        } else if (
          kind === "refresh-error" ||
          kind === "refresh-error-logout-fails"
        ) {
          input.write(
            `${JSON.stringify(protocolResponse("account/read", message.id, protocolAuthenticatedAccountResponse()))}\n`,
          );
        } else if (kind === "missing-requirement") {
          // Deliberately incomplete response proves authentication fails closed.
          input.write(
            `${JSON.stringify({ id: message.id, result: { account: null } })}\n`,
          );
        } else if (kind === "malformed-requirement") {
          // Deliberately wrong scalar type proves authentication fails closed.
          input.write(
            `${JSON.stringify({ id: message.id, result: { account: null, requiresOpenaiAuth: "yes" } })}\n`,
          );
        } else {
          input.write(
            `${JSON.stringify(
              protocolResponse(
                "account/read",
                message.id,
                kind === "logged-in"
                  ? protocolAuthenticatedAccountResponse()
                  : { account: null, requiresOpenaiAuth: true },
              ),
            )}\n`,
          );
        }
      } else if (message.method === "account/logout") {
        if (kind === "refresh-error-logout-fails")
          input.write(
            `${JSON.stringify({ id: message.id, error: { code: -32001, message: "logout is unavailable" } })}\n`,
          );
        else
          input.write(
            `${JSON.stringify(protocolResponse("account/logout", message.id, {}))}\n`,
          );
      } else if (message.method === "account/login/start") {
        // A login start the app-server never answers must also be bounded.
        if (kind === "stall-start") continue;
        const device = message.params.type === "chatgptDeviceCode";
        input.write(
          `${JSON.stringify(
            protocolResponse(
              "account/login/start",
              message.id,
              device
                ? {
                    type: "chatgptDeviceCode",
                    loginId: "login",
                    verificationUrl: "https://example.invalid/device",
                    userCode: "SAFE-CODE",
                  }
                : {
                    type: "chatgpt",
                    loginId: "login",
                    authUrl: "https://example.invalid/oauth?token=secret",
                  },
            ),
          )}\n`,
        );
        if (kind === "close")
          // Simulate the app-server dying after the login exchange started.
          setImmediate(() => input.end());
        else if (kind === "early")
          input.write(
            `${JSON.stringify(protocolNotification({ method: "account/login/completed", params: { loginId: "login", success: true, error: null } }))}\n`,
          );
        else if (kind !== "timeout")
          setImmediate(() =>
            input.write(
              `${JSON.stringify(protocolNotification({ method: "account/login/completed", params: { loginId: "login", success: kind !== "failure", error: kind === "failure" ? "denied" : null } }))}\n`,
            ),
          );
      }
    }
  });
  return rpc;
}

test("authentication accepts an existing account", async () => {
  const result = await ensureAuthenticated({
    rpc: fakeRpc("logged-in"),
    log: silentLogger,
    timeoutMs: 100,
    interactive: true,
    terminal: () => assert.fail("unexpected terminal output"),
  });
  assert.deepEqual(result, { recoveredLogin: false });
});

test("authentication fails closed when the auth requirement is missing", async () => {
  for (const kind of ["missing-requirement", "malformed-requirement"] as const)
    await assert.rejects(
      ensureAuthenticated({
        rpc: fakeRpc(kind),
        log: silentLogger,
        timeoutMs: 100,
        interactive: false,
        terminal: () => {},
      }),
      /invalid requiresOpenaiAuth/,
    );
});

test("browser login launches without printing the authorization URL", async () => {
  const terminal: string[] = [];
  let launched = "";
  await ensureAuthenticated({
    rpc: fakeRpc("browser"),
    log: silentLogger,
    timeoutMs: 100,
    interactive: true,
    terminal: (value) => terminal.push(value),
    launch: async (url) => {
      launched = url;
      return true;
    },
  });
  assert.match(launched, /oauth/);
  assert.deepEqual(terminal, []);
});

test("authentication observes completion delivered with the start response", async () => {
  await ensureAuthenticated({
    rpc: fakeRpc("early"),
    log: silentLogger,
    timeoutMs: 100,
    interactive: true,
    terminal: () => {},
    launch: async () => true,
  });
});

test("failed browser launch prints the URL only to the terminal sink", async () => {
  const terminal: string[] = [];
  const logs: string[] = [];
  await ensureAuthenticated({
    rpc: fakeRpc("browser"),
    log: createLogger("debug", (entry) => logs.push(JSON.stringify(entry))),
    timeoutMs: 100,
    interactive: true,
    terminal: (value) => terminal.push(value),
    launch: async () => false,
  });
  assert.match(terminal.join(""), /token=secret/);
  assert.doesNotMatch(logs.join(""), /token=secret|example\.invalid/);
});

test("headless auth uses device code and login failures reject", async () => {
  const terminal: string[] = [];
  const result = await ensureAuthenticated({
    rpc: fakeRpc("device"),
    log: silentLogger,
    timeoutMs: 100,
    interactive: false,
    terminal: (value) => terminal.push(value),
  });
  assert.deepEqual(result, { recoveredLogin: false });
  assert.match(terminal.join(""), /SAFE-CODE/);
  await assert.rejects(
    ensureAuthenticated({
      rpc: fakeRpc("failure"),
      log: silentLogger,
      timeoutMs: 100,
      interactive: true,
      terminal: () => {},
      launch: async () => true,
    }),
    /denied/,
  );
});

test("authentication supports cancellation and timeout", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    ensureAuthenticated({
      rpc: fakeRpc("browser"),
      log: silentLogger,
      timeoutMs: 100,
      interactive: true,
      terminal: () => {},
      signal: controller.signal,
    }),
    /cancelled/,
  );
  const rpc = fakeRpc("timeout");
  await assert.rejects(
    ensureAuthenticated({
      rpc,
      log: silentLogger,
      timeoutMs: 1,
      interactive: true,
      terminal: () => {},
      launch: async () => true,
    }),
    /timed out/,
  );
});

test("authentication records timeout while allowing browser launch to finish", async () => {
  let finishLaunch!: () => void;
  const launch = new Promise<void>((resolve) => {
    finishLaunch = resolve;
  });
  let settled = false;
  const authentication = ensureAuthenticated({
    rpc: fakeRpc("timeout"),
    log: silentLogger,
    timeoutMs: 1,
    interactive: true,
    terminal: () => {},
    launch: async () => {
      await launch;
      return true;
    },
  });
  void authentication.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  finishLaunch();
  await assert.rejects(authentication, /timed out/);
});

test("authentication bounds an account/read the app-server never answers", async () => {
  await assert.rejects(
    ensureAuthenticated({
      rpc: fakeRpc("stall-read"),
      log: silentLogger,
      timeoutMs: 10,
      interactive: true,
      terminal: () => {},
    }),
    /account\/read timed out/,
  );
});

test("refresh errors log out before re-running the device-code login", async () => {
  const methods: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const result = await ensureAuthenticated({
    rpc: fakeRpc("refresh-error", (method) => methods.push(method)),
    log: createLogger("debug", (entry) => logs.push(entry)),
    timeoutMs: 100,
    interactive: false,
    terminal: () => {},
  });
  assert.deepEqual(result, { recoveredLogin: true });

  assert.deepEqual(methods, [
    "account/read",
    "account/logout",
    "account/login/start",
    "account/read",
  ]);
  const unusableWarning = logs.find(
    (entry) => entry.event === "codex_auth_unusable",
  );
  assert.deepEqual(unusableWarning?.rpc_code, -32000);
  assert.doesNotMatch(
    JSON.stringify(unusableWarning),
    /ROTATED_REFRESH_TOKEN_SECRET/,
  );
  assert.deepEqual(
    logs.find((entry) => entry.event === "codex_auth_unusable_detail")?.error,
    "ROTATED_REFRESH_TOKEN_SECRET",
  );
});

test("refresh recovery continues after a failed logout", async () => {
  const methods: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const result = await ensureAuthenticated({
    rpc: fakeRpc("refresh-error-logout-fails", (method) =>
      methods.push(method),
    ),
    log: createLogger("debug", (entry) => logs.push(entry)),
    timeoutMs: 100,
    interactive: false,
    terminal: () => {},
  });
  assert.deepEqual(result, { recoveredLogin: true });

  assert.deepEqual(methods, [
    "account/read",
    "account/logout",
    "account/login/start",
    "account/read",
  ]);
  const logoutWarning = logs.find(
    (entry) => entry.event === "codex_auth_logout_failed",
  );
  assert.deepEqual(logoutWarning?.rpc_code, -32001);
  assert.doesNotMatch(JSON.stringify(logoutWarning), /logout is unavailable/);
});

test("refresh recovery rejects when login leaves no authenticated account", async () => {
  await assert.rejects(
    ensureAuthenticated({
      rpc: fakeRpc("refresh-error-still-unauthenticated"),
      log: silentLogger,
      timeoutMs: 100,
      interactive: false,
      terminal: () => {},
    }),
    /still reports no account/,
  );
});

test("authentication bounds a login start the app-server never answers", async () => {
  await assert.rejects(
    ensureAuthenticated({
      rpc: fakeRpc("stall-start"),
      log: silentLogger,
      timeoutMs: 10,
      interactive: true,
      terminal: () => {},
      launch: async () => true,
    }),
    /timed out/,
  );
});

test("authentication fails fast when the transport closes mid-login", async () => {
  // The generous deadline proves closure settles the wait, not the timeout.
  await assert.rejects(
    ensureAuthenticated({
      rpc: fakeRpc("close"),
      log: silentLogger,
      timeoutMs: 60_000,
      interactive: true,
      terminal: () => {},
      launch: async () => true,
    }),
    /transport closed/,
  );
});
