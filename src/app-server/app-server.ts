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
  UNRESTRICTED_POLICY_REQUIREMENTS,
  type PolicyRequirements,
} from "../core/policy.js";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/** Identifies this proxy to app-server during initialization. */
export const CLIENT_NAME = "codex-openai-proxy";

/** Resolves the bundled Codex executable when the default command is used. */
export function resolveCodexExecutable(configuredPath: string): string {
  if (configuredPath !== "codex") return configuredPath;
  try {
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve("@openai/codex/package.json");
    const packageJson = require(packageJsonPath) as {
      bin?: string | Record<string, string>;
    };
    const bin =
      typeof packageJson.bin === "string"
        ? packageJson.bin
        : packageJson.bin?.codex;
    if (!bin) throw new Error("@openai/codex does not declare a codex binary");
    return resolve(dirname(packageJsonPath), bin);
  } catch {
    // PATH remains a compatibility fallback for development and custom installs.
    return configuredPath;
  }
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
}

/** Starts, verifies, and initializes an app-server child process. */
export async function startAppServer(
  options: StartAppServerOptions,
): Promise<AppServer> {
  const spawnProcess = options.spawnProcess ?? spawn;
  const codexPath = resolveCodexExecutable(options.codexPath);
  await verifyCodex(
    codexPath,
    options.root,
    options.startupTimeoutMs,
    spawnProcess,
  );
  const child = spawnProcess(codexPath, ["app-server"], {
    cwd: options.root,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await waitForSpawn(child);
  const rpc = new JsonRpcTransport(child.stdout, child.stdin);
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
          version: "0.0.0",
        },
        capabilities: { experimentalApi: true },
      },
      options.startupTimeoutMs,
    );
    rpc.notify("initialized");
    requirements = await readConfigRequirements(rpc, options.startupTimeoutMs);
  } catch (error) {
    await stopChild(child, rpc, options.shutdownTimeoutMs);
    throw error;
  }

  return {
    rpc,
    requirements,
    child,
    async stop() {
      await stopChild(child, rpc, options.shutdownTimeoutMs);
    },
  };
}

/** Reads optional managed constraints without hiding malformed responses. */
async function readConfigRequirements(
  rpc: JsonRpcTransport,
  timeoutMs: number,
): Promise<PolicyRequirements> {
  let value: unknown;
  try {
    value = await requestWithTimeout(
      rpc,
      "configRequirements/read",
      undefined,
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof RpcError && error.rpcCode === -32601)
      return UNRESTRICTED_POLICY_REQUIREMENTS;
    throw error;
  }
  return parsePolicyRequirements(value);
}

/** Verifies that a configured executable identifies itself as Codex. */
async function verifyCodex(
  path: string,
  cwd: string,
  timeoutMs: number,
  spawnProcess: typeof spawn,
): Promise<void> {
  const child = spawnProcess(path, ["--version"], {
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForSpawn(child);
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  timer.unref();
  const [code, signal] = await once(child, "exit");
  clearTimeout(timer);
  if (signal === "SIGKILL") throw new Error("Codex version check timed out.");
  if (code !== 0) throw new Error("Codex version check failed.");
  if (!/codex/i.test(Buffer.concat(output).toString("utf8")))
    throw new Error(
      "The configured executable did not identify itself as Codex.",
    );
}

/** Bounds an initialization request with an abortable deadline. */
async function requestWithTimeout(
  rpc: JsonRpcTransport,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`${method} timed out.`)),
    timeoutMs,
  );
  timer.unref();
  try {
    return await rpc.request(method, params, controller.signal);
  } finally {
    clearTimeout(timer);
  }
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
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  timer.unref();
  await once(child, "exit");
  clearTimeout(timer);
}

/** Waits until a child either spawns successfully or reports an error. */
async function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) return;
  await Promise.race([
    once(child, "spawn"),
    once(child, "error").then(([error]) => Promise.reject(error)),
  ]);
}

/** Declines unsolicited app-server requests that the proxy cannot safely serve. */
function failClosed(
  rpc: JsonRpcTransport,
  request: ServerRequest,
  log: Logger,
): void {
  if (request.method === "item/tool/call") {
    // The continuation coordinator centrally routes this callback by thread.
    return;
  } else if (request.method === "item/tool/requestUserInput") {
    rpc.respond(request.id, { answers: {} });
  } else if (request.method === "mcpServer/elicitation/request") {
    rpc.respond(request.id, { action: "decline", content: null });
  } else if (
    request.method === "item/commandExecution/requestApproval" ||
    request.method === "item/fileChange/requestApproval"
  ) {
    rpc.respond(request.id, { decision: "decline" });
  } else if (
    request.method === "applyPatchApproval" ||
    request.method === "execCommandApproval"
  ) {
    rpc.respond(request.id, { decision: "denied" });
  } else if (request.method === "item/permissions/requestApproval") {
    // Omitting every requested permission is the protocol's explicit denial.
    rpc.respond(request.id, { permissions: {}, scope: "turn" });
  } else {
    rpc.respondError(request.id, {
      code: -32601,
      message: "Unsupported server request",
    });
  }
  log("warn", "app_server_request_declined", { method: request.method });
}

/** Removes common URL and credential forms from app-server diagnostics. */
function redact(value: string, root: string): string {
  const home = homedir();
  return value
    .replaceAll(home, "[REDACTED_HOME]")
    .replaceAll(root, "[REDACTED_CWD]")
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/\b(token|code|secret)=\S+/gi, "$1=[REDACTED]");
}
