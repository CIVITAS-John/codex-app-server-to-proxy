import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { startAppServer, type AppServer } from "../../src/app-server.js";
import { ensureAuthenticated } from "../../src/auth.js";
import { parseServeOptions } from "../../src/config.js";
import { JsonRpcTransport } from "../../src/json-rpc.js";
import { createLogger } from "../../src/logger.js";
import { createProxyServer, type ProxyServer } from "../../src/server.js";
import type { ChatContractBackend } from "./chat-contract.js";
import { protocolNotification, protocolTurn } from "./protocol-fixtures.js";

/** Silent logger used by both contract backends. */
const silentLogger = createLogger("error", () => {});

/** Starts the deterministic scripted app-server contract backend. */
export async function startFakeChatBackend(): Promise<ChatContractBackend> {
  const scripted = createScriptedTransport();
  return startProxy(scripted.rpc, async () => scripted.close());
}

/** Starts the authenticated package-owned Codex contract backend. */
export async function startLiveChatBackend(): Promise<ChatContractBackend> {
  const root = process.cwd();
  let appServer: AppServer | undefined;
  try {
    appServer = await startAppServer({
      codexPath: process.env.CODEX_PATH ?? "codex",
      root,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000,
      log: silentLogger,
    });
    await ensureAuthenticated({
      rpc: appServer.rpc,
      log: silentLogger,
      timeoutMs: 120_000,
      interactive: Boolean(process.stderr.isTTY),
      terminal: (message) => process.stderr.write(message),
    });
    return await startProxy(appServer.rpc, async () => appServer?.stop());
  } catch (error) {
    await appServer?.stop().catch(() => undefined);
    throw new Error(
      `Live Codex backend failed to start or authenticate: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** A scripted transport and its cleanup hook. */
interface ScriptedTransport {
  rpc: JsonRpcTransport;
  close(): Promise<void>;
}

/** Creates deterministic app-server behavior for the shared HTTP contract. */
function createScriptedTransport(): ScriptedTransport {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const rpc = new JsonRpcTransport(fromServer, toServer);
  let nextThread = 0;
  let nextTurn = 0;
  let nextServerRequest = 10_000;
  const active = new Map<
    string,
    { threadId: string; timer?: NodeJS.Timeout }
  >();
  const injected = new Map<string, unknown[]>();
  const pendingTools = new Map<number, { threadId: string; turnId: string }>();
  const send = (value: unknown): void => {
    const frame = `${JSON.stringify(value)}\n`;
    const middle = Math.max(1, Math.floor(frame.length / 2));
    fromServer.write(frame.slice(0, middle));
    fromServer.write(frame.slice(middle));
  };
  const complete = (threadId: string, turnId: string): void => {
    send(
      protocolNotification({
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          turnId,
          tokenUsage: {
            total: {
              inputTokens: 4,
              cachedInputTokens: 0,
              outputTokens: 2,
              reasoningOutputTokens: 0,
              totalTokens: 6,
            },
            last: {
              inputTokens: 4,
              cachedInputTokens: 0,
              outputTokens: 2,
              reasoningOutputTokens: 0,
              totalTokens: 6,
            },
            modelContextWindow: null,
          },
        },
      }),
    );
    send(
      protocolNotification({
        method: "turn/completed",
        params: { threadId, turn: protocolTurn(turnId, "completed") },
      }),
    );
    active.delete(turnId);
  };
  const lines = createInterface({ input: toServer });
  lines.on("line", (line) => {
    const message = JSON.parse(line) as {
      id: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
    };
    if (message.method === undefined) {
      const pending = pendingTools.get(message.id);
      if (!pending || message.result === undefined) return;
      pendingTools.delete(message.id);
      send(
        protocolNotification({
          method: "item/agentMessage/delta",
          params: {
            threadId: pending.threadId,
            turnId: pending.turnId,
            itemId: "tool-result-message",
            delta: "contract-tool-ok",
          },
        }),
      );
      complete(pending.threadId, pending.turnId);
      return;
    }
    const params = message.params ?? {};
    if (message.method === "thread/start") {
      const threadId = `thr_contract_${++nextThread}`;
      send({ id: message.id, result: { thread: { id: threadId } } });
      return;
    }
    if (message.method === "thread/inject_items") {
      const threadId = String(params.threadId);
      const items = Array.isArray(params.items) ? params.items : [];
      injected.set(threadId, items);
      send({ id: message.id, result: {} });
      return;
    }
    if (message.method === "turn/start") {
      const threadId = String(params.threadId);
      const turnId = `turn_contract_${++nextTurn}`;
      const input = params.input as Array<{ text?: string }>;
      const prompt = input?.[0]?.text ?? "";
      if (
        prompt.includes("remembered word") &&
        injected.get(threadId)?.length !== 4
      )
        throw new Error("role history was not injected before the turn");
      send({ id: message.id, result: { turn: { id: turnId } } });
      active.set(turnId, { threadId });
      if (prompt.includes("contract_lookup")) {
        const requestId = ++nextServerRequest;
        pendingTools.set(requestId, { threadId, turnId });
        send({
          id: requestId,
          method: "item/tool/call",
          params: {
            threadId,
            turnId,
            callId: "call_contract_lookup",
            namespace: null,
            tool: "contract_lookup",
            arguments: { key: "cedar" },
          },
        });
        return;
      }
      send(
        protocolNotification({
          method: "item/agentMessage/delta",
          params: {
            threadId,
            turnId,
            itemId: "message",
            delta: prompt.includes("10000") ? "1\n2\n" : "Hello",
          },
        }),
      );
      if (prompt.includes("10000")) return;
      const timer = setTimeout(() => complete(threadId, turnId), 1);
      active.set(turnId, { threadId, timer });
      return;
    }
    if (message.method === "turn/interrupt") {
      const turnId = String(params.turnId);
      const pending = active.get(turnId);
      if (pending?.timer) clearTimeout(pending.timer);
      send({ id: message.id, result: {} });
      if (pending) {
        send(
          protocolNotification({
            method: "turn/completed",
            params: {
              threadId: pending.threadId,
              turn: protocolTurn(turnId, "interrupted"),
            },
          }),
        );
      }
      active.delete(turnId);
    }
  });
  return {
    rpc,
    async close() {
      for (const pending of active.values())
        if (pending.timer) clearTimeout(pending.timer);
      lines.close();
      rpc.close(new Error("scripted backend closed"));
      fromServer.destroy();
      toServer.destroy();
    },
  };
}

/** Starts a ready ephemeral proxy for a supplied app-server transport. */
async function startProxy(
  rpc: JsonRpcTransport,
  closeTransport: () => Promise<void>,
): Promise<ChatContractBackend> {
  let proxy: ProxyServer | undefined;
  let modelCalls = 0;
  let interrupts = 0;
  const interruptWaiters = new Set<() => void>();
  const request = rpc.request.bind(rpc);
  rpc.request = (method, params, signal) => {
    if (method === "turn/start") modelCalls += 1;
    if (method === "turn/interrupt") {
      interrupts += 1;
      for (const resolve of interruptWaiters) resolve();
      interruptWaiters.clear();
    }
    return request(method, params, signal);
  };
  try {
    proxy = createProxyServer(
      parseServeOptions([
        "--port",
        "0",
        "--request-timeout",
        "2m",
        "--shutdown-timeout",
        "10s",
        "--state-dir",
        `${tmpdir()}/codex-proxy-contract-tests-${process.pid}`,
      ]),
      silentLogger,
    );
    proxy.setTransport(rpc);
    proxy.setReady(true);
    const address = await proxy.listen();
    const host = address.address.includes(":")
      ? `[${address.address}]`
      : address.address;
    return {
      origin: `http://${host}:${address.port}`,
      modelCalls: () => modelCalls,
      async waitForInterrupt() {
        if (interrupts > 0) return;
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            interruptWaiters.delete(onInterrupt);
            reject(
              new Error("app-server turn was not interrupted after disconnect"),
            );
          }, 10_000);
          const onInterrupt = (): void => {
            clearTimeout(timeout);
            resolve();
          };
          interruptWaiters.add(onInterrupt);
        });
      },
      async close() {
        proxy?.setReady(false);
        proxy?.setTransport(undefined);
        await proxy?.close().catch(() => undefined);
        rpc.request = request;
        await closeTransport();
      },
    };
  } catch (error) {
    await proxy?.close().catch(() => undefined);
    rpc.request = request;
    await closeTransport().catch(() => undefined);
    throw error;
  }
}
