import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  startAppServer,
  type AppServer,
} from "../../src/app-server/app-server.js";
import { ensureAuthenticated } from "../../src/app-server/auth.js";
import type { JsonRpcTransport } from "../../src/app-server/json-rpc.js";
import type { Logger } from "../../src/core/logger.js";
import type { ProxyServer } from "../../src/http/server.js";
import {
  UNRESTRICTED_POLICY_REQUIREMENTS,
  type PolicyRequirements,
} from "../../src/core/policy.js";
import {
  OBSERVATION_COMMAND,
  OBSERVATION_FIXTURE,
  type ChatContractBackend,
} from "./chat-contract.js";
import {
  protocolNotification,
  protocolResponse,
  protocolServerRequest,
  protocolThread,
  protocolThreadResumeResponse,
  protocolThreadStartResponse,
  protocolTurn,
} from "./protocol-fixtures.js";
import { startProxyWithTransport } from "./http.js";
import { silentLogger } from "./logger.js";
import {
  completeTurn,
  createFakeTransport,
  type FakeTransport,
} from "./transport.js";

/** Starts the deterministic scripted app-server contract backend. */
export async function startFakeChatBackend(
  log: Logger = silentLogger,
): Promise<ChatContractBackend> {
  const environment = await createContractEnvironment();
  return startRestartableBackend(environment, async () => {
    const scripted = createScriptedTransport(
      environment.root,
      environment.observationToken,
    );
    return startProxy(
      scripted.rpc,
      async () => scripted.close(),
      environment,
      UNRESTRICTED_POLICY_REQUIREMENTS,
      log,
    );
  });
}

/** Starts the authenticated package-owned Codex contract backend. */
export async function startLiveChatBackend(): Promise<ChatContractBackend> {
  const environment = await createContractEnvironment();
  return startRestartableBackend(environment, () =>
    startLiveChatBackendOnce(environment),
  );
}

/** Starts one replaceable authenticated app-server and proxy pair. */
async function startLiveChatBackendOnce(
  environment: ContractEnvironment,
): Promise<ChatContractBackend> {
  let appServer: AppServer | undefined;
  try {
    appServer = await startAppServer({
      codexPath: process.env.CODEX_PATH ?? "codex",
      root: environment.root,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000,
      log: silentLogger,
    });
    assertLivePolicyPrerequisites(appServer.requirements);
    const interactive = !process.env.CI && Boolean(process.stderr.isTTY);
    await ensureAuthenticated({
      rpc: appServer.rpc,
      log: silentLogger,
      timeoutMs: 120_000,
      interactive,
      // Headless CI must never disclose a device-code URL or one-time code.
      terminal: interactive
        ? (message) => process.stderr.write(message)
        : () => {},
    });
    return await startProxy(
      appServer.rpc,
      async () => appServer?.stop(),
      environment,
      appServer.requirements,
      silentLogger,
    );
  } catch (error) {
    await appServer?.stop().catch(() => undefined);
    throw new Error(
      `Live Codex backend failed to start or authenticate: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Shared root and external state retained across contract backend restarts. */
interface ContractEnvironment {
  base: string;
  root: string;
  stateDir: string;
  observationToken: string;
}

/** Allocates one isolated live-compatible root and sibling state directory. */
async function createContractEnvironment(): Promise<ContractEnvironment> {
  const base = await mkdtemp(join(tmpdir(), "codex-proxy-contract-"));
  try {
    const root = join(base, "root");
    const stateDir = join(base, "state");
    await mkdir(root, { mode: 0o700 });
    await mkdir(stateDir, { mode: 0o700 });
    const canonicalRoot = await realpath(root);
    const observationToken = `contract-built-in-retained-${randomBytes(16).toString("hex")}`;
    await writeFile(
      join(canonicalRoot, OBSERVATION_FIXTURE),
      `${observationToken}\n`,
      { mode: 0o600 },
    );
    return {
      base,
      root: canonicalRoot,
      stateDir,
      observationToken,
    };
  } catch (error) {
    // No backend wrapper exists yet to own a partially initialized directory.
    await rm(base, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Requires the native read-only mode underlying both safe live scenarios. */
function assertLivePolicyPrerequisites(requirements: PolicyRequirements): void {
  if (
    requirements.allowedSandboxModes !== null &&
    !requirements.allowedSandboxModes.includes("read-only")
  )
    throw new Error(
      "Live contract prerequisite unsupported: managed policy disallows the read-only realization used by disabled and explicit read-only sandboxing.",
    );
  if (
    requirements.allowedWebSearchModes !== null &&
    !requirements.allowedWebSearchModes.includes("disabled")
  )
    throw new Error(
      "Live contract prerequisite unsupported: managed policy disallows disabled web search.",
    );
}

/** Wraps replaceable proxy/app-server pairs while retaining their shared state path. */
async function startRestartableBackend(
  environment: ContractEnvironment,
  startOnce: () => Promise<ChatContractBackend>,
): Promise<ChatContractBackend> {
  let current: ChatContractBackend;
  try {
    current = await startOnce();
  } catch (error) {
    // No backend close hook exists yet, so the wrapper owns startup cleanup.
    await rm(environment.base, { recursive: true, force: true });
    throw error;
  }
  let priorModelCalls = 0;
  let priorResumeCalls = 0;
  return {
    get origin() {
      return current.origin;
    },
    root: environment.root,
    observationToken: environment.observationToken,
    modelCalls: () => priorModelCalls + current.modelCalls(),
    resumeCalls: () => priorResumeCalls + current.resumeCalls(),
    waitForInterrupt: () => current.waitForInterrupt(),
    async restart() {
      priorModelCalls += current.modelCalls();
      priorResumeCalls += current.resumeCalls();
      await current.close();
      current = await startOnce();
    },
    async close() {
      try {
        await current.close();
      } finally {
        await rm(environment.base, { recursive: true, force: true });
      }
    },
  };
}

/** A scripted transport and its cleanup hook. */
type ScriptedTransport = FakeTransport;

/** Creates deterministic app-server behavior for the shared HTTP contract. */
function createScriptedTransport(
  root: string,
  observationToken: string,
): ScriptedTransport {
  let nextThread = 0;
  let nextTurn = 0;
  let nextServerRequest = 10_000;
  const active = new Map<
    string,
    { threadId: string; timer?: NodeJS.Timeout }
  >();
  const injected = new Map<string, unknown[]>();
  const pendingTools = new Map<number, { threadId: string; turnId: string }>();
  const successfulBuiltInThreads = new Set<string>();
  const environmentDisabledThreads = new Set<string>();
  const complete = (threadId: string, turnId: string): void => {
    completeTurn(scripted.send, threadId, turnId);
    active.delete(turnId);
  };
  const scripted = createFakeTransport({
    fragmentCount: 2,
    onMessage(rawMessage, send) {
      const message = rawMessage as {
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
        if (
          Array.isArray(params.environments) &&
          params.environments.length === 0
        )
          environmentDisabledThreads.add(threadId);
        send(
          protocolResponse(
            "thread/start",
            message.id,
            protocolThreadStartResponse(protocolThread(threadId), root),
          ),
        );
        return;
      }
      if (message.method === "thread/read") {
        send(
          protocolResponse("thread/read", message.id, {
            thread: protocolThread(String(params.threadId)),
          }),
        );
        return;
      }
      if (message.method === "thread/resume") {
        send(
          protocolResponse(
            "thread/resume",
            message.id,
            protocolThreadResumeResponse(
              protocolThread(String(params.threadId)),
              root,
            ),
          ),
        );
        return;
      }
      if (message.method === "thread/inject_items") {
        const threadId = String(params.threadId);
        const items = Array.isArray(params.items) ? params.items : [];
        injected.set(threadId, items);
        send(protocolResponse("thread/inject_items", message.id, {}));
        return;
      }
      if (message.method === "turn/start") {
        const threadId = String(params.threadId);
        const turnId = `turn_contract_${++nextTurn}`;
        const input = params.input as Array<{ text?: string }>;
        const prompt = input?.[0]?.text ?? "";
        if (
          prompt.includes("contract-history-") &&
          (params.effort !== "high" || params.summary !== "detailed")
        )
          throw new Error(
            "role history did not apply high reasoning effort with a detailed summary",
          );
        if (
          prompt.includes("remembered word") &&
          injected.get(threadId)?.length !== 4
        )
          throw new Error("role history was not injected before the turn");
        send(
          protocolResponse("turn/start", message.id, {
            turn: protocolTurn(turnId, "inProgress"),
          }),
        );
        active.set(turnId, { threadId });
        if (prompt.includes("contract-disabled-sandbox")) {
          if (
            !environmentDisabledThreads.has(threadId) ||
            !Array.isArray(params.environments) ||
            params.environments.length !== 0
          )
            throw new Error(
              "disabled sandbox did not remove the execution environment on thread and turn start",
            );
          send(
            protocolNotification({
              method: "item/agentMessage/delta",
              params: {
                threadId,
                turnId,
                itemId: "disabled-sandbox-message",
                delta: "No execution environment is available.",
              },
            }),
          );
          complete(threadId, turnId);
          return;
        }
        if (prompt.includes("contract-history-one"))
          send(
            protocolNotification({
              method: "item/reasoning/summaryTextDelta",
              params: {
                threadId,
                turnId,
                itemId: "contract-history-reasoning",
                summaryIndex: 0,
                delta: "checked replay history",
              },
            }),
          );
        if (prompt.includes("contract_lookup")) {
          const requestId = ++nextServerRequest;
          pendingTools.set(requestId, { threadId, turnId });
          send(
            protocolServerRequest({
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
            }),
          );
          return;
        }
        if (prompt.includes("built-in shell command")) {
          const itemId = "contract-observation";
          const command = `/bin/sh -lc '${OBSERVATION_COMMAND}'`;
          const baseItem = {
            type: "commandExecution" as const,
            id: itemId,
            command,
            cwd: root,
            processId: null,
            source: "agent" as const,
            commandActions: [{ type: "unknown" as const, command }],
            exitCode: null,
            durationMs: null,
          };
          send(
            protocolNotification({
              method: "item/started",
              params: {
                threadId,
                turnId,
                startedAtMs: Date.now(),
                item: {
                  ...baseItem,
                  status: "inProgress",
                  aggregatedOutput: null,
                },
              },
            }),
          );
          send(
            protocolNotification({
              method: "item/completed",
              params: {
                threadId,
                turnId,
                completedAtMs: Date.now(),
                item: {
                  ...baseItem,
                  status: "completed",
                  aggregatedOutput: `${observationToken}\n`,
                  exitCode: 0,
                  durationMs: 1,
                },
              },
            }),
          );
          successfulBuiltInThreads.add(threadId);
          send(
            protocolNotification({
              method: "item/agentMessage/delta",
              params: {
                threadId,
                turnId,
                itemId: "built-in-message",
                delta: "observation-complete",
              },
            }),
          );
          complete(threadId, turnId);
          return;
        }
        send(
          protocolNotification({
            method: "item/agentMessage/delta",
            params: {
              threadId,
              turnId,
              itemId: "message",
              delta: prompt.includes("10000")
                ? "1\n2\n"
                : prompt.includes("contract-history-one")
                  ? "contract-history-one"
                  : prompt.includes("contract-history-two")
                    ? "contract-history-two"
                    : prompt.includes("contract-resume-ok")
                      ? "contract-resume-ok"
                      : prompt.includes("contract-internal-replay-ok")
                        ? "contract-internal-replay-ok"
                        : prompt.includes(
                              "complete stdout from the prior built-in",
                            )
                          ? successfulBuiltInThreads.has(threadId)
                            ? observationToken
                            : "contract-built-in-retained-missing"
                          : "Hello",
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
        send(protocolResponse("turn/interrupt", message.id, {}));
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
    },
  });
  return {
    ...scripted,
    close(reason = new Error("scripted backend closed")): void {
      for (const pending of active.values())
        if (pending.timer) clearTimeout(pending.timer);
      scripted.close(reason);
    },
  };
}

/** Starts a ready ephemeral proxy for a supplied app-server transport. */
async function startProxy(
  rpc: JsonRpcTransport,
  closeTransport: () => Promise<void>,
  environment: ContractEnvironment,
  requirements: PolicyRequirements,
  log: Logger,
): Promise<ChatContractBackend> {
  let proxy: ProxyServer | undefined;
  let modelCalls = 0;
  let resumeCalls = 0;
  let interrupts = 0;
  const interruptWaiters = new Set<() => void>();
  const request = rpc.request.bind(rpc);
  rpc.request = (method, params, signal) => {
    if (method === "turn/start") modelCalls += 1;
    if (method === "thread/resume") resumeCalls += 1;
    if (method === "turn/interrupt") {
      interrupts += 1;
      for (const resolve of interruptWaiters) resolve();
      interruptWaiters.clear();
    }
    return request(method, params, signal);
  };
  let origin = "";
  /** Starts one proxy process view over the retained transport and state directory. */
  const listen = async (): Promise<void> => {
    const started = await startProxyWithTransport(rpc, {
      root: environment.root,
      stateDir: environment.stateDir,
      requestTimeoutMs: 120_000,
      shutdownTimeoutMs: 10_000,
      log,
      requirements,
    });
    proxy = started.proxy;
    origin = started.origin;
  };
  try {
    await listen();
    return {
      get origin() {
        return origin;
      },
      root: environment.root,
      observationToken: environment.observationToken,
      modelCalls: () => modelCalls,
      resumeCalls: () => resumeCalls,
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
      async restart() {
        throw new Error("restart must be coordinated with the app-server");
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
