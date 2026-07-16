import { parseServeOptions } from "../core/config.js";
import { createLogger, logFailure } from "../core/logger.js";
import { canonicalizeRoot } from "../core/policy.js";
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
  --state-dir <directory>       State directory (default: <root>/.codex-openai-proxy)`;

/** Runs the CLI lifecycle and returns its eventual process exit code. */
export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  if (argv[0] !== "serve")
    throw new Error(`Unknown command: ${argv[0]}\n\n${usage}`);
  const parsed = parseServeOptions(argv.slice(1));
  const canonicalRoot = await canonicalizeRoot(parsed.root);
  // The state directory is intentionally kept outside the root (see config.ts),
  // so it is used verbatim; only the root is canonicalized here.
  const options = { ...parsed, root: canonicalRoot };
  const log = createLogger(options.logLevel);
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
  let lifecycleStopping = false;
  // Authentication must finish before readiness admits proxy traffic.
  const initializeAppServer = async () => {
    const next = await startAppServer({
      codexPath: options.codexPath,
      root: options.root,
      startupTimeoutMs: options.toolTimeoutMs,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
      log,
      diagnosticLogging: options.logLevel === "debug",
    });
    try {
      await ensureAuthenticated({
        rpc: next.rpc,
        log,
        timeoutMs: options.toolTimeoutMs,
        interactive: Boolean(process.stderr.isTTY),
        terminal: (message) => process.stderr.write(message),
      });
    } catch (error) {
      await next.stop().catch(() => undefined);
      throw error;
    }
    next.child.once("exit", () => {
      if (!lifecycleStopping) void recoverAppServer();
    });
    return next;
  };
  let recovering = false;
  // Keep the HTTP listener alive while bounded retries restore app-server.
  const recoverAppServer = async (): Promise<void> => {
    if (recovering || lifecycleStopping) return;
    recovering = true;
    proxy.setReady(false);
    for (const [index, delayMs] of APP_SERVER_RECOVERY_DELAYS_MS.entries()) {
      if (lifecycleStopping) break;
      const attempt = index + 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        appServer = await initializeAppServer();
        proxy.setTransport(appServer.rpc, appServer.requirements);
        proxy.setReady(true);
        log("info", "app_server_restarted", { attempt });
        recovering = false;
        return;
      } catch (error) {
        logFailure(log, "app_server_restart_failed", { attempt }, error, options.root);
      }
    }
    recovering = false;
    log("error", "app_server_restart_exhausted");
  };
  try {
    appServer = await initializeAppServer();
    proxy.setTransport(appServer.rpc, appServer.requirements);
    proxy.setReady(true);
  } catch (error) {
    await appServer?.stop().catch(() => undefined);
    await proxy.close().catch(() => undefined);
    throw error;
  }

  const shutdown = new Promise<number>((resolve) => {
    let stopping = false;
    const stop = (signal: NodeJS.Signals): void => {
      if (stopping) return;
      stopping = true;
      lifecycleStopping = true;
      log("info", "shutdown_started", { signal });
      proxy.setReady(false);
      proxy.setTransport(undefined);
      void appServer!
        .stop()
        .then(() => proxy.close())
        .then(
          () => {
            log("info", "shutdown_complete");
            resolve(0);
          },
          (error: unknown) => {
            logFailure(log, "shutdown_failed", {}, error, options.root);
            resolve(1);
          },
        );
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  // Announce readiness only after shutdown handlers can observe an immediate signal.
  log("info", "app_server_ready");
  return await shutdown;
}
