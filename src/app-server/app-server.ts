import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import { JsonRpcTransport, RpcError, type ServerRequest } from "./json-rpc.js";
import type { Logger } from "../core/logger.js";
import {
  parsePolicyRequirements,
  selectApprovalPolicy,
  selectApprovalsReviewer,
  UNRESTRICTED_POLICY_REQUIREMENTS,
  type PolicyRequirements,
} from "../core/policy.js";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { redact } from "../core/redact.js";
import { listenForAbort, withDeadline } from "../core/abort.js";

/** Identifies this proxy to app-server during initialization. */
export const CLIENT_NAME = "codex-openai-proxy";

/** Minimal proxy package metadata used in public version diagnostics. */
interface ProxyPackageMetadata {
  version: string;
}

/** Version of this proxy package and app-server client. */
export const CLIENT_VERSION = (
  createRequire(import.meta.url)("../../package.json") as ProxyPackageMetadata
).version;

/** Package metadata that owns the runtime and generated protocol version. */
interface CodexPackageMetadata {
  version: string;
  bin?: string | Record<string, string>;
}

/** Reads the exact runtime dependency used as the compatibility contract. */
function codexPackageMetadata(): {
  packageJsonPath: string;
  packageJson: CodexPackageMetadata;
} {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("@openai/codex/package.json");
  return {
    packageJsonPath,
    packageJson: require(packageJsonPath) as CodexPackageMetadata,
  };
}

/** Exact Codex CLI version supported by this proxy build. */
export const PINNED_CODEX_VERSION = codexPackageMetadata().packageJson.version;

/** Process command and argument prefix used to invoke Codex without a shell. */
export interface CodexInvocation {
  command: string;
  prefixArgs: string[];
}

/** Resolves the package-owned Codex executable unless explicitly overridden. */
export function resolveCodexExecutable(configuredPath: string): string {
  if (configuredPath !== "codex") return configuredPath;
  const { packageJsonPath, packageJson } = codexPackageMetadata();
  const bin =
    typeof packageJson.bin === "string"
      ? packageJson.bin
      : packageJson.bin?.codex;
  if (!bin) throw new Error("@openai/codex does not declare a codex binary");
  return resolve(dirname(packageJsonPath), bin);
}

/** Resolves a cross-platform process invocation for package-owned or explicit Codex. */
export function resolveCodexInvocation(
  configuredPath: string,
): CodexInvocation {
  const executable = resolveCodexExecutable(configuredPath);
  return configuredPath === "codex"
    ? { command: process.execPath, prefixArgs: [executable] }
    : { command: executable, prefixArgs: [] };
}

/** Owns the initialized app-server process and its JSON-RPC transport. */
export interface AppServer {
  rpc: JsonRpcTransport;
  requirements: PolicyRequirements;
  child: ChildProcessWithoutNullStreams;
  stop(): Promise<void>;
}

/** Configures app-server process startup and shutdown. */
export interface StartAppServerOptions {
  codexPath: string;
  root: string;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  log: Logger;
  diagnosticLogging?: boolean;
  spawnProcess?: typeof spawn;
  signal?: AbortSignal;
}

/** Starts, verifies, and initializes an app-server child process. */
export async function startAppServer(
  options: StartAppServerOptions,
): Promise<AppServer> {
  const spawnProcess = options.spawnProcess ?? spawn;
  const invocation = resolveCodexInvocation(options.codexPath);
  await verifyCodex(
    invocation,
    options.root,
    options.startupTimeoutMs,
    spawnProcess,
    options.signal,
  );
  if (options.signal?.aborted) throw abortReason(options.signal);
  const child = spawnProcess(
    invocation.command,
    [...invocation.prefixArgs, "app-server"],
    {
      cwd: options.root,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  await waitForSpawn(child, options.signal);
  const rpc = new JsonRpcTransport(child.stdout, child.stdin);
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopping ??= stopChild(child, rpc, options.shutdownTimeoutMs));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    options.log("warn", "app_server_stderr", {
      message: "[REDACTED_DIAGNOSTIC]",
    });
    if (options.diagnosticLogging)
      options.log("debug", "app_server_stderr_detail", {
        message: redact(chunk, options.root).trim().slice(0, 2_000),
      });
  });
  rpc.on("malformed", () =>
    options.log("error", "app_server_malformed_output"),
  );
  rpc.on("request", (request: ServerRequest) =>
    failClosed(rpc, request, options.log),
  );
  child.once("exit", (code, signal) => {
    rpc.close(new Error(`app-server exited (${code ?? signal ?? "unknown"})`));
    options.log("error", "app_server_exited", { code, signal });
  });

  let requirements: PolicyRequirements;
  try {
    await requestWithTimeout(
      rpc,
      "initialize",
      {
        clientInfo: {
          name: CLIENT_NAME,
          title: "Codex OpenAI proxy",
          version: CLIENT_VERSION,
        },
        capabilities: { experimentalApi: true },
      },
      options.startupTimeoutMs,
      options.signal,
    );
    rpc.notify("initialized");
    requirements = await readConfigRequirements(
      rpc,
      options.startupTimeoutMs,
      options.signal,
    );
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    rpc,
    requirements,
    child,
    async stop() {
      await stop();
    },
  };
}

/** Reads optional managed constraints without hiding malformed responses. */
async function readConfigRequirements(
  rpc: JsonRpcTransport,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PolicyRequirements> {
  let value: unknown;
  try {
    value = await requestWithTimeout(
      rpc,
      "configRequirements/read",
      undefined,
      timeoutMs,
      signal,
    );
  } catch (error) {
    if (error instanceof RpcError && error.rpcCode === -32601)
      return UNRESTRICTED_POLICY_REQUIREMENTS;
    throw error;
  }
  const requirements = parsePolicyRequirements(value);
  // Managed requirements are fixed for the process lifetime, so an allowlist
  // that permits no proxy-supported approval policy or reviewer is a deployment
  // misconfiguration. Fail startup here rather than surfacing it as a per-request
  // 400 that misleadingly blames the client's x_codex.
  selectApprovalPolicy(requirements);
  selectApprovalsReviewer(requirements);
  return requirements;
}

/** Verifies that a configured executable matches the pinned contract version. */
async function verifyCodex(
  invocation: CodexInvocation,
  cwd: string,
  timeoutMs: number,
  spawnProcess: typeof spawn,
  externalSignal?: AbortSignal,
): Promise<void> {
  if (externalSignal?.aborted) throw abortReason(externalSignal);
  const child = spawnProcess(
    invocation.command,
    [...invocation.prefixArgs, "--version"],
    {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitForSpawn(child, externalSignal);
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  const timeoutReason = new Error("Codex version check timed out.");
  await withDeadline(
    externalSignal,
    {
      milliseconds: timeoutMs,
      timeoutReason,
      abortReason,
    },
    async (deadlineSignal) => {
      const disposeAbort = listenForAbort(deadlineSignal, () => {
        child.kill("SIGKILL");
      });
      try {
        const [code, exitSignal] = await once(child, "exit");
        // A parent cancellation wins even when it races the version deadline.
        if (externalSignal?.aborted) throw abortReason(externalSignal);
        if (deadlineSignal.reason === timeoutReason && exitSignal === "SIGKILL")
          throw timeoutReason;
        if (code !== 0) throw new Error("Codex version check failed.");
        const value = Buffer.concat(output).toString("utf8").trim();
        const match = /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(
          value,
        );
        if (!match)
          throw new Error(
            "The configured executable did not identify itself as Codex.",
          );
        if (match[1] !== PINNED_CODEX_VERSION)
          throw new Error(
            `Unsupported Codex version ${match[1]}; expected ${PINNED_CODEX_VERSION}.`,
          );
      } finally {
        disposeAbort();
      }
    },
  );
}

/** Bounds an initialization request with an abortable deadline. */
async function requestWithTimeout(
  rpc: JsonRpcTransport,
  method: string,
  params: unknown,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<unknown> {
  return await withDeadline(
    externalSignal,
    {
      milliseconds: timeoutMs,
      timeoutReason: new Error(`${method} timed out.`),
      abortReason,
    },
    async (deadlineSignal) => await rpc.request(method, params, deadlineSignal),
  );
}

/** Gracefully stops app-server, escalating to SIGKILL after the deadline. */
async function stopChild(
  child: ChildProcessWithoutNullStreams,
  rpc: JsonRpcTransport,
  timeoutMs: number,
): Promise<void> {
  rpc.close(new Error("proxy shutting down"));
  child.stdin.end();
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await withDeadline(
    undefined,
    {
      milliseconds: timeoutMs,
      timeoutReason: new Error("app-server shutdown timed out"),
    },
    async (deadlineSignal) => {
      const disposeDeadline = listenForAbort(deadlineSignal, () => {
        child.kill("SIGKILL");
      });
      try {
        await once(child, "exit");
      } finally {
        disposeDeadline();
      }
    },
  );
}

/** Waits until a child either spawns successfully or reports an error. */
async function waitForSpawn(
  child: ChildProcess,
  signal?: AbortSignal,
): Promise<void> {
  if (child.pid !== undefined) return;
  await new Promise<void>((resolve, reject) => {
    let disposeAbort = (): void => undefined;
    const cleanup = (): void => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
      disposeAbort();
    };
    const onSpawn = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (abortedSignal: AbortSignal): void => {
      cleanup();
      child.kill("SIGKILL");
      reject(abortReason(abortedSignal));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    disposeAbort = listenForAbort(signal, onAbort);
  });
}

/** Returns a stable Error reason for lifecycle cancellation. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("app-server startup cancelled");
}

/** Method-specific result bodies for unsolicited app-server requests. */
const FAIL_CLOSED_RESPONSES: ReadonlyMap<string, unknown> = new Map([
  ["item/tool/requestUserInput", { answers: {} }],
  ["mcpServer/elicitation/request", { action: "decline", content: null }],
  ["item/commandExecution/requestApproval", { decision: "decline" }],
  ["item/fileChange/requestApproval", { decision: "decline" }],
  ["applyPatchApproval", { decision: "denied" }],
  ["execCommandApproval", { decision: "denied" }],
  [
    "item/permissions/requestApproval",
    // Omitting every requested permission is the protocol's explicit denial.
    { permissions: {}, scope: "turn" },
  ],
]);

/** Declines one unsolicited app-server request with its method-specific response. */
function failClosed(
  rpc: JsonRpcTransport,
  request: ServerRequest,
  log: Logger,
): void {
  if (request.method === "item/tool/call") {
    // The continuation coordinator centrally routes this callback by thread.
    return;
  } else {
    const response = FAIL_CLOSED_RESPONSES.get(request.method);
    if (response === undefined)
      rpc.respondError(request.id, {
        code: -32601,
        message: "Unsupported server request",
      });
    else rpc.respond(request.id, response);
  }
  log("warn", "app_server_request_declined", { method: request.method });
}
