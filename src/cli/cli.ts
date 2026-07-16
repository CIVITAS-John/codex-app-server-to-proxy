import {
  DEFAULT_STATE_DIR_DESCRIPTION,
  parseServeOptions,
  resolveServeOptions,
  type ParsedServeOptions,
  type ServeOptions,
} from "../core/config.js";
import {
  createLogger,
  type Logger,
  type RedactionContext,
} from "../core/logger.js";
import { createProxyServer } from "../http/server.js";
import { startAppServer, type AppServer } from "../app-server/app-server.js";
import { ensureAuthenticated } from "../app-server/auth.js";

/** Delays before bounded app-server restart attempts after an unexpected exit. */
export const APP_SERVER_RECOVERY_DELAYS_MS = [
  1_000, 3_000, 5_000, 10_000,
] as const;

/** Documents the CLI's supported command and options. */
export const usage = `Usage: codex-openai-proxy serve [options]

Options:
  --host <host>                 Loopback host (default: 127.0.0.1)
  --port <port>                 TCP port, or 0 for an ephemeral port (default: 8787)
  --root <directory>            Allowed working-directory root (default: launch directory)
  --codex-path <path>           Override the package-owned Codex executable
  --tool-timeout <duration>     Dynamic tool deadline (default: 5m)
  --implicit-tool-continuation <true|false>
                                Resolve tool results by tool_call_id (default: true)
  --request-timeout <duration>  HTTP request deadline (default: 30s)
  --shutdown-timeout <duration> Graceful shutdown deadline (default: 10s)
  --body-limit <bytes>          Maximum request body (default: 1048576)
  --max-requests <count>        Maximum concurrent requests (default: 100)
  --log-level <level>           debug, info, warn, or error (default: info)
  --state-dir <directory>       State directory (default: ${DEFAULT_STATE_DIR_DESCRIPTION})`;

/** Runs the CLI lifecycle and returns its eventual process exit code. */
export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  if (argv[0] !== "serve")
    throw new Error(`Unknown command: ${argv[0]}\n\n${usage}`);
  const parsed = parseServeOptions(argv.slice(1));
  let log = createLogger(parsed.logLevel, undefined, redactionContext(parsed));
  try {
    const options = await resolveServeOptions(parsed);
    log = createLogger(options.logLevel, undefined, redactionContext(options));
    return await runServer(options, log);
  } catch (error) {
    log.failure("startup_failed", {}, error);
    return 1;
  }
}

/** Derives one redaction context from parsed or finalized configuration. */
function redactionContext(
  options: Pick<ParsedServeOptions, "root" | "codexPath" | "stateDir">,
): RedactionContext {
  return {
    root: options.root,
    sensitivePaths: [options.stateDir, options.codexPath].filter(
      (path): path is string => path !== undefined,
    ),
  };
}

/** Runs the proxy lifecycle after configuration has been fully resolved. */
async function runServer(options: ServeOptions, log: Logger): Promise<number> {
  const proxy = createProxyServer(options, log);
  const address = await proxy.listen();
  log("info", "server_listening", {
    host: address.address,
    port: address.port,
    default_sandbox: "read-only",
    default_web_search: "disabled",
    ready: false,
  });
  log("debug", "server_root", { root: options.root });

  let appServer: AppServer | undefined;
  let startingAppServer: AppServer | undefined;
  let lifecycleStopping = false;
  const lifecycle = new AbortController();
  let settleShutdown!: (code: number) => void;
  const shutdown = new Promise<number>((resolve) => {
    settleShutdown = resolve;
  });
  let stopping: Promise<void> | undefined;
  const childStops = new Map<AppServer, Promise<void>>();
  const stopChild = (child: AppServer): Promise<void> => {
    const existing = childStops.get(child);
    if (existing) return existing;
    const pending = child.stop();
    childStops.set(child, pending);
    return pending;
  };
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    lifecycleStopping = true;
    lifecycle.abort(new Error(`proxy received ${signal}`));
    log("info", "shutdown_started", { signal });
    proxy.setReady(false);
    // Disposing the coordinator first rejects suspended dynamic tool calls
    // before the child transport is terminated.
    proxy.setTransport(undefined);
    const children = [...new Set([appServer, startingAppServer])].filter(
      (child): child is AppServer => child !== undefined,
    );
    stopping = Promise.all(children.map(stopChild)).then(
      async () => {
        await proxy.close();
        log("info", "shutdown_complete");
        settleShutdown(0);
      },
      async (error: unknown) => {
        await proxy.close().catch(() => undefined);
        log.failure("shutdown_failed", {}, error);
        settleShutdown(1);
      },
    );
  };
  const onSigint = (): void => stop("SIGINT");
  const onSigterm = (): void => stop("SIGTERM");
  // Install lifecycle handlers before authentication so login is cancellable.
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  // Authentication must finish before readiness admits proxy traffic.
  const initializeAppServer = async (): Promise<AppServer> => {
    const next = await startAppServer({
      codexPath: options.codexPath,
      root: options.root,
      startupTimeoutMs: options.toolTimeoutMs,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
      log,
      diagnosticLogging: options.logLevel === "debug",
      signal: lifecycle.signal,
    });
    startingAppServer = next;
    let exited = false;
    next.child.once("exit", () => {
      exited = true;
      if (!lifecycleStopping && appServer === next) {
        appServer = undefined;
        proxy.setReady(false);
        proxy.setTransport(undefined);
        void recoverAppServer();
      }
    });
    try {
      await ensureAuthenticated({
        rpc: next.rpc,
        log,
        timeoutMs: options.toolTimeoutMs,
        interactive: Boolean(process.stderr.isTTY),
        terminal: (message) => process.stderr.write(message),
        signal: lifecycle.signal,
      });
    } catch (error) {
      await stopChild(next).catch(() => undefined);
      if (startingAppServer === next) startingAppServer = undefined;
      throw error;
    }
    if (lifecycleStopping || lifecycle.signal.aborted || exited) {
      await stopChild(next).catch(() => undefined);
      if (startingAppServer === next) startingAppServer = undefined;
      throw (
        lifecycle.signal.reason ?? new Error("app-server exited during startup")
      );
    }
    startingAppServer = undefined;
    return next;
  };
  let recovering = false;
  // Keep the HTTP listener alive while bounded retries restore app-server.
  const recoverAppServer = async (): Promise<void> => {
    if (recovering || lifecycleStopping) return;
    recovering = true;
    proxy.setReady(false);
    try {
      for (const [index, delayMs] of APP_SERVER_RECOVERY_DELAYS_MS.entries()) {
        if (lifecycleStopping) return;
        const attempt = index + 1;
        try {
          await abortableDelay(delayMs, lifecycle.signal);
        } catch {
          if (lifecycleStopping) return;
          throw new Error("App-server recovery delay failed.");
        }
        try {
          const next = await initializeAppServer();
          if (lifecycleStopping) {
            await stopChild(next).catch(() => undefined);
            return;
          }
          appServer = next;
          proxy.setTransport(next.rpc, next.requirements);
          proxy.setReady(true);
          log("info", "app_server_restarted", { attempt });
          return;
        } catch (error) {
          if (lifecycleStopping) return;
          log.failure("app_server_restart_failed", { attempt }, error);
        }
      }
      log("error", "app_server_restart_exhausted");
    } finally {
      recovering = false;
    }
  };
  try {
    appServer = await initializeAppServer();
    if (lifecycleStopping) return await shutdown;
    proxy.setTransport(appServer.rpc, appServer.requirements);
    proxy.setReady(true);
  } catch (error) {
    if (lifecycleStopping) {
      const code = await shutdown;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      return code;
    }
    await (appServer ? stopChild(appServer) : undefined)?.catch(
      () => undefined,
    );
    await proxy.close().catch(() => undefined);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    throw error;
  }
  // Announce readiness only after shutdown handlers can observe an immediate signal.
  log("info", "app_server_ready");
  try {
    return await shutdown;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

/** Waits for a recovery backoff unless lifecycle shutdown aborts it. */
async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    timer.unref();
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    function done(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
