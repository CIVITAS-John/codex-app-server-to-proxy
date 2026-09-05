import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  startAppServer,
  type AppServer,
} from "../../src/app-server/app-server.js";
import { ensureAuthenticated } from "../../src/app-server/auth.js";
import type { JsonRpcTransport } from "../../src/app-server/json-rpc.js";
import { installResponsesLiteOverride } from "../../src/app-server/responses-lite-override.js";
import type { Logger } from "../../src/core/logger.js";
import type { ProxyServer } from "../../src/http/server.js";
import {
  UNRESTRICTED_POLICY_REQUIREMENTS,
  type PolicyRequirements,
} from "../../src/core/policy.js";
import {
  CONTRACT_TOOL_BATCHES,
  CONTRACT_MODEL,
  MAX_LIVE_PROVIDER_CALLS,
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
import {
  ProviderCallBudget,
  type ProviderCallStats,
} from "./provider-call-budget.js";
import { startProxyWithTransport } from "./http.js";
import { silentLogger } from "./logger.js";
import {
  completeTurn,
  createFakeTransport,
  sendTokenUsage,
  tokenUsageFixture,
  type CompleteTurnOptions,
  type FakeTransport,
} from "./transport.js";

/** Starts the deterministic scripted app-server contract backend. */
export async function startFakeChatBackend(
  log: Logger = silentLogger,
): Promise<ChatContractBackend> {
  return startConfiguredFakeChatBackend(false, log);
}

/** Starts a fake whose filesystem turn needs one corrective write continuation. */
export async function startFakeFilesystemCorrectionChatBackend(
  log: Logger = silentLogger,
): Promise<ChatContractBackend> {
  return startConfiguredFakeChatBackend(true, log);
}

/** Starts one deterministic fake with optional first-turn write omission. */
async function startConfiguredFakeChatBackend(
  deferFilesystemWrite: boolean,
  log: Logger,
): Promise<ChatContractBackend> {
  const environment = await createContractEnvironment();
  return startRestartableBackend(environment, async () => {
    const scripted = createScriptedTransport(
      environment.root,
      environment.observationToken,
      environment.writePath,
      deferFilesystemWrite,
    );
    return startProxy(
      scripted.rpc,
      async () => scripted.close(),
      environment,
      UNRESTRICTED_POLICY_REQUIREMENTS,
      log,
      undefined,
      scripted.childProviderCalls,
      scripted.hasChildProviderThread,
    );
  });
}

/** Starts the authenticated package-owned Codex contract backend. */
export async function startLiveChatBackend(
  providerBudget = new ProviderCallBudget(MAX_LIVE_PROVIDER_CALLS),
): Promise<ChatContractBackend> {
  return startConfiguredLiveChatBackend(false, false, providerBudget);
}

/** Starts the isolated live backend whose process may spawn child agents. */
export async function startLiveSpawnChatBackend(
  providerBudget = new ProviderCallBudget(MAX_LIVE_PROVIDER_CALLS),
): Promise<ChatContractBackend> {
  return startConfiguredLiveChatBackend(true, true, providerBudget);
}

/** Creates one restartable live backend with a process-level agent policy. */
async function startConfiguredLiveChatBackend(
  agentsEnabled: boolean,
  requireChildProviderCalls: boolean,
  providerBudget: ProviderCallBudget,
): Promise<ChatContractBackend> {
  const environment = await createContractEnvironment();
  return startRestartableBackend(
    environment,
    () => startLiveChatBackendOnce(environment, agentsEnabled, providerBudget),
    { providerBudget, requireChildProviderCalls },
  );
}

/** Starts one replaceable authenticated app-server and proxy pair. */
async function startLiveChatBackendOnce(
  environment: ContractEnvironment,
  agentsEnabled: boolean,
  providerBudget: ProviderCallBudget,
): Promise<ChatContractBackend> {
  let appServer: AppServer | undefined;
  try {
    await seedLiveModelCache(environment.codexHome);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      appServer = await startAppServer({
        codexPath: process.env.CODEX_PATH ?? "codex",
        // Subagent availability is a process policy, not a thread setting.
        subagentsEnabled: agentsEnabled,
        codexHome: environment.codexHome,
        seedAuthFrom: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
        root: environment.root,
        startupTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000,
        log: silentLogger,
      });
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
      if (appServer.responsesLiteOverrideApplied) break;

      let override = await installResponsesLiteOverride(
        environment.codexHome,
        silentLogger,
      );
      if (override.status === "missing-cache") {
        // Catalog listing can force a first-run metadata refresh but never
        // starts a model turn, so it does not consume the live-call budget.
        await appServer.rpc.request(
          "model/list",
          { cursor: null, limit: 1, includeHidden: true },
          AbortSignal.timeout(30_000),
        );
        override = await installResponsesLiteOverride(
          environment.codexHome,
          silentLogger,
        );
      }
      if (override.status === "missing-cache")
        throw new Error(
          "live contract could not prepare the Responses Lite model-catalog override",
        );
      await appServer.stop();
      appServer = undefined;
      if (attempt === 1)
        throw new Error(
          "live contract replacement app-server did not load the Responses Lite override",
        );
    }
    if (appServer === undefined || !appServer.responsesLiteOverrideApplied)
      throw new Error(
        "live contract started without the Responses Lite model-catalog override",
      );
    assertLivePolicyPrerequisites(appServer.requirements);
    // Report only the dynamic-tool dispatch offset; token-usage notifications
    // are asserted through HTTP output and stay off stdout.
    let turnStartedAt = 0;
    const baseRequest = appServer.rpc.request.bind(appServer.rpc);
    appServer.rpc.request = (method, params, signal) => {
      if (method === "turn/start") turnStartedAt = Date.now();
      return baseRequest(method, params, signal);
    };
    appServer.rpc.on("request", ({ method }) => {
      if (method === "item/tool/call")
        console.info(
          `[live] item/tool/call at +${Date.now() - turnStartedAt} ms after turn/start`,
        );
    });
    return await startProxy(
      appServer.rpc,
      async () => appServer?.stop(),
      environment,
      appServer.requirements,
      silentLogger,
      providerBudget,
    );
  } catch (error) {
    await appServer?.stop().catch(() => undefined);
    throw new Error(
      `Live Codex backend failed to start or authenticate: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Seeds isolated live runs from existing metadata without changing its owner. */
async function seedLiveModelCache(codexHome: string): Promise<void> {
  const sourceHomes = [
    process.env.CODEX_HOME,
    join(homedir(), ".codex-openai-proxy", "codex-home"),
    join(homedir(), ".codex"),
  ].filter((candidate): candidate is string => candidate !== undefined);
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  for (const sourceHome of new Set(sourceHomes)) {
    try {
      const source = JSON.parse(
        await readFile(join(sourceHome, "models_cache.json"), "utf8"),
      ) as { models?: Array<{ slug?: unknown }> };
      if (!source.models?.some((model) => model.slug === CONTRACT_MODEL))
        continue;
      const target = join(codexHome, "models_cache.json");
      await copyFile(join(sourceHome, "models_cache.json"), target);
      await chmod(target, 0o600);
      return;
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Shared root and external state retained across contract backend restarts. */
interface ContractEnvironment {
  base: string;
  root: string;
  stateDir: string;
  codexHome: string;
  observationToken: string;
  writePath: string;
}

/** Allocates one isolated live-compatible root and sibling state directory. */
async function createContractEnvironment(): Promise<ContractEnvironment> {
  const base = await mkdtemp(join(tmpdir(), "codex-proxy-contract-"));
  try {
    const root = join(base, "root");
    const stateDir = join(base, "state");
    const codexHome = join(base, "codex-home");
    await mkdir(root, { mode: 0o700 });
    await mkdir(stateDir, { mode: 0o700 });
    const canonicalRoot = await realpath(root);
    const observationToken = `contract-built-in-retained-${randomBytes(16).toString("hex")}`;
    const writePath = join(
      canonicalRoot,
      `.codex-contract-write-${randomBytes(8).toString("hex")}.txt`,
    );
    await writeFile(
      join(canonicalRoot, OBSERVATION_FIXTURE),
      `${observationToken}\n`,
      { mode: 0o600 },
    );
    return {
      base,
      root: canonicalRoot,
      stateDir,
      codexHome,
      observationToken,
      writePath,
    };
  } catch (error) {
    // No backend wrapper exists yet to own a partially initialized directory.
    await removeContractEnvironment(base).catch(() => undefined);
    throw error;
  }
}

/** Requires every sandbox and web mode exercised by the paid live contract. */
export function assertLivePolicyPrerequisites(
  requirements: PolicyRequirements,
): void {
  if (
    requirements.allowedSandboxModes !== null &&
    !requirements.allowedSandboxModes.includes("read-only")
  )
    throw new Error(
      "Live contract prerequisite unsupported: managed policy disallows the read-only realization used by disabled and explicit read-only sandboxing.",
    );
  if (
    requirements.allowedSandboxModes !== null &&
    !requirements.allowedSandboxModes.includes("workspace-write")
  )
    throw new Error(
      "Live contract prerequisite unsupported: managed policy disallows workspace-write sandboxing.",
    );
  if (
    requirements.allowedWebSearchModes !== null &&
    !requirements.allowedWebSearchModes.includes("disabled")
  )
    throw new Error(
      "Live contract prerequisite unsupported: managed policy disallows disabled web search.",
    );
  if (
    requirements.allowedWebSearchModes !== null &&
    !requirements.allowedWebSearchModes.includes("live")
  )
    throw new Error(
      "Live contract prerequisite unsupported: managed policy disallows live web search.",
    );
}

/** Optional accounting shared by every app-server generation in a live run. */
interface RestartableBackendOptions {
  providerBudget?: ProviderCallBudget;
  requireChildProviderCalls?: boolean;
}

/** Wraps replaceable proxy/app-server pairs while retaining their shared state path. */
async function startRestartableBackend(
  environment: ContractEnvironment,
  startOnce: () => Promise<ChatContractBackend>,
  options: RestartableBackendOptions = {},
): Promise<ChatContractBackend> {
  let current: ChatContractBackend;
  try {
    current = await startOnce();
  } catch (error) {
    // No backend close hook exists yet, so the wrapper owns startup cleanup.
    await removeContractEnvironment(environment.base);
    throw error;
  }
  let priorModelCalls = 0;
  let priorResumeCalls = 0;
  let priorProviderCalls: ProviderCallStats = {
    parent: 0,
    child: 0,
    total: 0,
  };
  /** Returns either shared live totals or accumulated fake-backend totals. */
  const providerCalls = (): ProviderCallStats => {
    if (options.providerBudget) return options.providerBudget.stats();
    const currentCalls = current.providerCalls();
    return {
      parent: priorProviderCalls.parent + currentCalls.parent,
      child: priorProviderCalls.child + currentCalls.child,
      total: priorProviderCalls.total + currentCalls.total,
    };
  };
  return {
    get origin() {
      return current.origin;
    },
    root: environment.root,
    observationToken: environment.observationToken,
    writePath: environment.writePath,
    providerCalls,
    assertChildProviderCallsObserved: (childThreadId) => {
      if (options.providerBudget)
        options.providerBudget.assertChildThreadCallsObserved(childThreadId);
      else current.assertChildProviderCallsObserved(childThreadId);
    },
    modelCalls: () => priorModelCalls + current.modelCalls(),
    resumeCalls: () => priorResumeCalls + current.resumeCalls(),
    waitForInterrupt: () => current.waitForInterrupt(),
    async restart() {
      priorModelCalls += current.modelCalls();
      priorResumeCalls += current.resumeCalls();
      if (!options.providerBudget) {
        const calls = current.providerCalls();
        priorProviderCalls = {
          parent: priorProviderCalls.parent + calls.parent,
          child: priorProviderCalls.child + calls.child,
          total: priorProviderCalls.total + calls.total,
        };
      }
      let failure: unknown;
      try {
        await options.providerBudget?.settle();
      } catch (error) {
        failure = error;
      }
      try {
        await current.close();
      } catch (error) {
        failure ??= error;
      }
      try {
        await options.providerBudget?.settle();
      } catch (error) {
        failure ??= error;
      }
      if (failure) throw failure;
      current = await startOnce();
    },
    async close() {
      let failure: unknown;
      try {
        try {
          await options.providerBudget?.settle();
        } catch (error) {
          failure = error;
        }
        try {
          await current.close();
        } catch (error) {
          failure ??= error;
        }
        try {
          await options.providerBudget?.settle();
          if (options.requireChildProviderCalls)
            options.providerBudget?.assertChildCallsObserved();
        } catch (error) {
          failure ??= error;
        }
      } finally {
        await removeContractEnvironment(environment.base);
      }
      if (failure) throw failure;
    },
  };
}

/** Removes a released contract root with bounded Windows lock retries. */
async function removeContractEnvironment(base: string): Promise<void> {
  await rm(base, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

/** A scripted transport and its cleanup hook. */
type ScriptedTransport = FakeTransport & {
  childProviderCalls(): number;
  hasChildProviderThread(threadId: string): boolean;
};

/** Creates deterministic app-server behavior for the shared HTTP contract. */
function createScriptedTransport(
  root: string,
  observationToken: string,
  writePath: string,
  deferFilesystemWrite = false,
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
  /** Tool-call turns awaiting their interrupt, by turn id. */
  const toolTurns = new Map<string, string>();
  const modelRequests = new Map<string, number>();
  const successfulBuiltInThreads = new Set<string>();
  const environmentDisabledThreads = new Set<string>();
  let childProviderCalls = 0;
  const childProviderThreads = new Set<string>();
  const complete = (
    threadId: string,
    turnId: string,
    options: CompleteTurnOptions = {},
  ): void => {
    const priorRequests = modelRequests.get(threadId) ?? 0;
    completeTurn(scripted.send, threadId, turnId, {
      ...options,
      priorRequests,
    });
    modelRequests.set(threadId, priorRequests + 1);
    active.delete(turnId);
  };
  /** Emits and accounts for one nonterminal model request on a thread. */
  const sendUsage = (
    threadId: string,
    turnId: string,
    reasoningOutputTokens = 0,
  ): void => {
    const priorRequests = modelRequests.get(threadId) ?? 0;
    sendTokenUsage(
      scripted.send,
      threadId,
      turnId,
      tokenUsageFixture(reasoningOutputTokens, priorRequests),
    );
    modelRequests.set(threadId, priorRequests + 1);
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
        // The only responses the proxy writes are the post-interrupt
        // rejections of issued tool requests; they need no reply.
        if (pendingTools.has(message.id) && message.result === undefined)
          pendingTools.delete(message.id);
        return;
      }
      const params = message.params ?? {};
      if (message.method === "thread/start") {
        const threadId = `thr_contract_${++nextThread}`;
        if (params.experimentalRawEvents !== true)
          throw new Error(
            "contract thread did not opt into raw response events",
          );
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
        send(
          protocolResponse("turn/start", message.id, {
            turn: protocolTurn(turnId, "inProgress"),
          }),
        );
        active.set(turnId, { threadId });
        // Emit every request in one batch synchronously so the proxy observes
        // the same parallel callback shape expected from live app-server.
        const sendToolBatch = (batchIndex: number): void => {
          const batch = CONTRACT_TOOL_BATCHES[batchIndex];
          if (batch === undefined)
            throw new Error("contract requested an unknown tool batch");
          toolTurns.set(turnId, threadId);
          for (const [callIndex, call] of batch.entries()) {
            const requestId = ++nextServerRequest;
            pendingTools.set(requestId, { threadId, turnId });
            send(
              protocolServerRequest({
                id: requestId,
                method: "item/tool/call",
                params: {
                  threadId,
                  turnId,
                  callId: `call_contract_lookup_${batchIndex + 1}_${callIndex + 1}`,
                  namespace: null,
                  tool: call.name,
                  arguments: { key: call.key },
                },
              }),
            );
          }
          send(
            protocolNotification({
              method: "rawResponse/completed",
              params: {
                threadId,
                turnId,
                responseId: `raw_contract_${turnId}_${batchIndex}`,
                usage: null,
              },
            }),
          );
        };
        /**
         * Emits the fixed single-call batch requested by the restart-fallback
         * continuation. It registers the turn in the same maps as
         * sendToolBatch so it parks at its batch until turn/interrupt and the
         * proxy captures and interrupts it exactly like the other batches.
         */
        const sendRestartBatch = (): void => {
          toolTurns.set(turnId, threadId);
          const requestId = ++nextServerRequest;
          pendingTools.set(requestId, { threadId, turnId });
          send(
            protocolServerRequest({
              id: requestId,
              method: "item/tool/call",
              params: {
                threadId,
                turnId,
                callId: "call_contract_restart_1",
                namespace: null,
                tool: "contract_lookup",
                arguments: { key: "pine" },
              },
            }),
          );
          send(
            protocolNotification({
              method: "rawResponse/completed",
              params: {
                threadId,
                turnId,
                responseId: `raw_contract_${turnId}_restart`,
                usage: null,
              },
            }),
          );
        };
        /** Emits one completed file-change lifecycle and performs its write. */
        const sendFilesystemWrite = (): void => {
          const change = {
            path: writePath,
            kind: { type: "add" as const },
            diff: `+${observationToken}\n`,
          };
          send(
            protocolNotification({
              method: "item/started",
              params: {
                threadId,
                turnId,
                startedAtMs: Date.now(),
                item: {
                  type: "fileChange",
                  id: "contract-filesystem-write",
                  changes: [change],
                  status: "inProgress",
                },
              },
            }),
          );
          void writeFile(writePath, `${observationToken}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          })
            .then(() => {
              send(
                protocolNotification({
                  method: "item/completed",
                  params: {
                    threadId,
                    turnId,
                    completedAtMs: Date.now(),
                    item: {
                      type: "fileChange",
                      id: "contract-filesystem-write",
                      changes: [change],
                      status: "completed",
                    },
                  },
                }),
              );
              send(
                protocolNotification({
                  method: "item/agentMessage/delta",
                  params: {
                    threadId,
                    turnId,
                    itemId: "filesystem-message",
                    delta: "filesystem-complete",
                  },
                }),
              );
              complete(threadId, turnId);
            })
            .catch((error: unknown) =>
              scripted.close(
                error instanceof Error ? error : new Error(String(error)),
              ),
            );
        };
        if (prompt.includes("contract-disabled-sandbox")) {
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
        if (prompt.includes("contract-filesystem-read-write")) {
          // The model first requests the read, then requests apply_patch, then
          // produces its final response after both internal results are known.
          sendUsage(threadId, turnId);
          const command = `read ${OBSERVATION_FIXTURE}`;
          const commandBase = {
            type: "commandExecution" as const,
            id: "contract-filesystem-read",
            pluginId: null,
            scriptPath: null,
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
                  ...commandBase,
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
                  ...commandBase,
                  status: "completed",
                  aggregatedOutput: `${observationToken}\n`,
                  exitCode: 0,
                  durationMs: 1,
                },
              },
            }),
          );
          sendUsage(threadId, turnId);
          if (deferFilesystemWrite) {
            send(
              protocolNotification({
                method: "item/agentMessage/delta",
                params: {
                  threadId,
                  turnId,
                  itemId: "filesystem-write-omitted-message",
                  delta: "read-complete",
                },
              }),
            );
            complete(threadId, turnId);
            return;
          }
          sendFilesystemWrite();
          return;
        }
        if (prompt.includes("Complete the missing mandatory write now")) {
          sendUsage(threadId, turnId);
          sendFilesystemWrite();
          return;
        }
        if (prompt.includes("contract-live-web-search")) {
          const query = "IANA reserved example domains";
          const action = { type: "search" as const, query, queries: [query] };
          send(
            protocolNotification({
              method: "item/started",
              params: {
                threadId,
                turnId,
                startedAtMs: Date.now(),
                item: {
                  type: "webSearch",
                  id: "contract-web-search",
                  query,
                  action: null,
                  results: null,
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
                  type: "webSearch",
                  id: "contract-web-search",
                  query,
                  action,
                  results: null,
                },
              },
            }),
          );
          send(
            protocolNotification({
              method: "item/agentMessage/delta",
              params: {
                threadId,
                turnId,
                itemId: "web-message",
                delta: "web-search-complete",
              },
            }),
          );
          complete(threadId, turnId);
          return;
        }
        if (prompt.includes("contract-spawn-child")) {
          const childThreadId = `thr_contract_child_${threadId}`;
          childProviderThreads.add(childThreadId);
          const spawnBase = {
            type: "collabAgentToolCall" as const,
            id: "contract-spawn",
            tool: "spawnAgent" as const,
            senderThreadId: threadId,
            receiverThreadIds: [childThreadId],
            prompt: `Return only ${observationToken}`,
            model: null,
            reasoningEffort: null,
          };
          sendUsage(threadId, turnId);
          send(
            protocolNotification({
              method: "item/started",
              params: {
                threadId,
                turnId,
                startedAtMs: Date.now(),
                item: {
                  ...spawnBase,
                  status: "inProgress",
                  agentsStates: {
                    [childThreadId]: { status: "pendingInit", message: null },
                  },
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
                  ...spawnBase,
                  status: "completed",
                  agentsStates: {
                    [childThreadId]: { status: "running", message: null },
                  },
                },
              },
            }),
          );
          childProviderCalls += 1;
          send(
            protocolNotification({
              method: "rawResponse/completed",
              params: {
                threadId: childThreadId,
                turnId: "turn_contract_child",
                responseId: `raw_contract_child_${childThreadId}`,
                usage: null,
              },
            }),
          );
          sendUsage(threadId, turnId);
          const waitBase = {
            type: "collabAgentToolCall" as const,
            id: "contract-wait",
            tool: "wait" as const,
            senderThreadId: threadId,
            receiverThreadIds: [childThreadId],
            prompt: null,
            model: null,
            reasoningEffort: null,
          };
          send(
            protocolNotification({
              method: "item/started",
              params: {
                threadId,
                turnId,
                startedAtMs: Date.now(),
                item: {
                  ...waitBase,
                  status: "inProgress",
                  agentsStates: {
                    [childThreadId]: { status: "running", message: null },
                  },
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
                  ...waitBase,
                  status: "completed",
                  agentsStates: {
                    [childThreadId]: {
                      status: "completed",
                      message: observationToken,
                    },
                  },
                },
              },
            }),
          );
          send(
            protocolNotification({
              method: "item/agentMessage/delta",
              params: {
                threadId,
                turnId,
                itemId: "spawn-message",
                delta: observationToken,
              },
            }),
          );
          complete(threadId, turnId);
          return;
        }
        if (prompt.includes("contract-history-one"))
          send(
            protocolNotification({
              method: "item/completed",
              params: {
                threadId,
                turnId,
                completedAtMs: Date.now(),
                item: {
                  type: "reasoning",
                  id: "contract-history-reasoning",
                  summary: ["checked replay history"],
                  content: [],
                },
              },
            }),
          );
        if (prompt.includes("contract-restart-fallback")) {
          // One fresh-thread batch after restart: the fallback thread has raw
          // boundaries, so the requested call is delivered like any live batch.
          sendRestartBatch();
          return;
        }
        if (prompt.includes("contract_lookup")) {
          sendToolBatch(0);
          return;
        }
        if (input.length === 0) {
          // A tool-result continuation starts with no user input; the injected
          // function_call/function_call_output pairs are the model input. Their
          // shape is asserted by the tests that own it, so this fake reads only
          // the batch they answered to decide what to send next.
          const pairs = (injected.get(threadId) ?? []) as Array<
            Record<string, unknown>
          >;
          const answeredBatches = pairs
            .map((item) =>
              /^call_contract_lookup_(\d+)_\d+$/.exec(
                typeof item.call_id === "string" ? item.call_id : "",
              ),
            )
            .filter((match): match is RegExpExecArray => match !== null)
            .map((match) => Number(match[1]) - 1);
          const completedBatchIndex = answeredBatches.at(-1);
          if (
            completedBatchIndex !== undefined &&
            CONTRACT_TOOL_BATCHES[completedBatchIndex + 1] !== undefined
          ) {
            sendToolBatch(completedBatchIndex + 1);
            return;
          }
          send(
            protocolNotification({
              method: "item/agentMessage/delta",
              params: {
                threadId,
                turnId,
                itemId: "tool-result-message",
                delta: "contract-tool-ok",
              },
            }),
          );
          complete(threadId, turnId);
          return;
        }
        if (prompt.includes("built-in shell command")) {
          // Running a built-in command splits the turn into two model requests:
          // one that asks for the command and one that answers with its result.
          // App-server reports usage for each as it finishes.
          sendUsage(threadId, turnId);
          const itemId = "contract-observation";
          const command = `/bin/sh -lc '${OBSERVATION_COMMAND}'`;
          const baseItem = {
            type: "commandExecution" as const,
            id: itemId,
            pluginId: null,
            scriptPath: null,
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
          // The answering request completes the turn, and its usage arrives
          // after completion to exercise the documented separate usage stream.
          complete(threadId, turnId, { usageOrder: "after_completion" });
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
        const timer = setTimeout(
          () =>
            complete(threadId, turnId, {
              reasoningOutputTokens: prompt.includes("contract-history-one")
                ? 128
                : 0,
            }),
          1,
        );
        active.set(turnId, { threadId, timer });
        return;
      }
      if (message.method === "turn/interrupt") {
        const turnId = String(params.turnId);
        const pending = active.get(turnId);
        if (pending?.timer) clearTimeout(pending.timer);
        send(protocolResponse("turn/interrupt", message.id, {}));
        const toolThread = toolTurns.get(turnId);
        if (toolThread) {
          // Live app-server flushes the parked turn's usage within
          // milliseconds of the interrupt; mirror that wire order exactly.
          toolTurns.delete(turnId);
          sendUsage(toolThread, turnId, 3);
        }
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
          send(
            protocolNotification({
              method: "thread/status/changed",
              params: {
                threadId: pending.threadId,
                status: { type: "idle" },
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
    childProviderCalls: () => childProviderCalls,
    hasChildProviderThread: (threadId) => childProviderThreads.has(threadId),
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
  providerBudget?: ProviderCallBudget,
  childProviderCalls: () => number = () => 0,
  hasChildProviderThread: (threadId: string) => boolean = () => false,
): Promise<ChatContractBackend> {
  let proxy: ProxyServer | undefined;
  let modelCalls = 0;
  let resumeCalls = 0;
  let interrupts = 0;
  let ownedActiveRootTurn: { threadId: string; turnId: string } | undefined;
  const interruptWaiters = new Set<() => void>();
  const request = rpc.request.bind(rpc);
  rpc.request = (method, params, signal) => {
    const values = protocolRecord(params);
    if (method === "turn/start") modelCalls += 1;
    if (method === "thread/resume") resumeCalls += 1;
    if (method === "thread/resume" && typeof values?.threadId === "string")
      providerBudget?.registerRootThread(values.threadId);
    if (method === "turn/interrupt") {
      interrupts += 1;
      for (const resolve of interruptWaiters) resolve();
      interruptWaiters.clear();
    }
    const response = request(method, params, signal);
    if (
      !providerBudget ||
      (method !== "thread/start" && method !== "turn/start")
    )
      return response;
    return response.then((result) => {
      const responseValues = protocolRecord(result);
      if (method === "thread/start") {
        const thread = protocolRecord(responseValues?.thread);
        if (typeof thread?.id !== "string")
          throw new Error(
            "Live provider-call accounting could not identify the root thread returned by thread/start.",
          );
        providerBudget.registerRootThread(thread.id);
        return result;
      }
      const turn = protocolRecord(responseValues?.turn);
      if (typeof values?.threadId !== "string" || typeof turn?.id !== "string")
        throw new Error(
          "Live provider-call accounting could not identify the root turn returned by turn/start.",
        );
      providerBudget.activateRootTurn(values.threadId, turn.id);
      ownedActiveRootTurn = { threadId: values.threadId, turnId: turn.id };
      return result;
    });
  };
  /** Counts provider completions globally, including spawned child threads. */
  const onNotification = (method: string, params: unknown): void => {
    providerBudget?.observe(method, params, async ({ threadId, turnId }) => {
      await rpc.request(
        "turn/interrupt",
        { threadId, turnId },
        AbortSignal.timeout(10_000),
      );
    });
  };
  if (providerBudget) rpc.on("notification", onNotification);
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
      writePath: environment.writePath,
      providerCalls: () =>
        providerBudget?.stats() ?? {
          parent: modelCalls,
          child: childProviderCalls(),
          total: modelCalls + childProviderCalls(),
        },
      assertChildProviderCallsObserved: (childThreadId) => {
        if (providerBudget)
          providerBudget.assertChildThreadCallsObserved(childThreadId);
        else if (!hasChildProviderThread(childThreadId))
          throw new Error(
            `The deterministic contract backend emitted no provider call for expected child thread ${JSON.stringify(childThreadId)}.`,
          );
      },
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
        try {
          await closeTransport();
        } finally {
          if (ownedActiveRootTurn)
            providerBudget?.releaseRootTurn(ownedActiveRootTurn);
          if (providerBudget) rpc.off("notification", onNotification);
        }
      },
    };
  } catch (error) {
    await proxy?.close().catch(() => undefined);
    rpc.request = request;
    await closeTransport().catch(() => undefined);
    if (ownedActiveRootTurn)
      providerBudget?.releaseRootTurn(ownedActiveRootTurn);
    if (providerBudget) rpc.off("notification", onNotification);
    throw error;
  }
}

/** Narrows untrusted JSON-RPC parameters and results to object records. */
function protocolRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
