import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "vitest";
import { ensureAuthenticated } from "../../src/app-server/auth.js";
import { JsonRpcTransport } from "../../src/app-server/json-rpc.js";
import { createLogger } from "../../src/core/logger.js";
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
  | "timeout";

/** Creates an in-memory app-server authentication transport. */
function fakeRpc(kind: LoginKind): JsonRpcTransport {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new JsonRpcTransport(input, output);
  let buffered = "";
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
      if (message.method === "account/read") {
        if (kind === "missing-requirement") {
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
      } else if (message.method === "account/login/start") {
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
        if (kind === "early")
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

/** Suppresses expected logs during authentication tests. */
const silent = createLogger("error", () => {});

test("authentication accepts an existing account", async () => {
  await ensureAuthenticated({
    rpc: fakeRpc("logged-in"),
    log: silent,
    timeoutMs: 100,
    interactive: true,
    terminal: () => assert.fail("unexpected terminal output"),
  });
});

test("authentication fails closed when the auth requirement is missing", async () => {
  for (const kind of ["missing-requirement", "malformed-requirement"] as const)
    await assert.rejects(
      ensureAuthenticated({
        rpc: fakeRpc(kind),
        log: silent,
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
    log: silent,
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
    log: silent,
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
  await ensureAuthenticated({
    rpc: fakeRpc("device"),
    log: silent,
    timeoutMs: 100,
    interactive: false,
    terminal: (value) => terminal.push(value),
  });
  assert.match(terminal.join(""), /SAFE-CODE/);
  await assert.rejects(
    ensureAuthenticated({
      rpc: fakeRpc("failure"),
      log: silent,
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
      log: silent,
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
      log: silent,
      timeoutMs: 1,
      interactive: true,
      terminal: () => {},
      launch: async () => true,
    }),
    /timed out/,
  );
});
