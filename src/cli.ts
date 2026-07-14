import { access, constants, stat } from "node:fs/promises";
import { parseServeOptions } from "./config.js";
import { createLogger } from "./logger.js";
import { createProxyServer } from "./server.js";
import { startAppServer, type AppServer } from "./app-server.js";
import { ensureAuthenticated } from "./auth.js";

/** Documents the CLI's supported command and options. */
export const usage = `Usage: codex-openai-proxy serve [options]

Options:
  --host <host>                 Loopback host (default: 127.0.0.1)
  --port <port>                 TCP port, or 0 for an ephemeral port (default: 8787)
  --root <directory>            Allowed working-directory root (default: launch directory)
  --codex-path <path>           Override the package-owned Codex executable
  --tool-timeout <duration>     Dynamic tool deadline (default: 5m)
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
  const options = parseServeOptions(argv.slice(1));
  await assertDirectory(options.root, "--root");
  const log = createLogger(options.logLevel);
  const proxy = createProxyServer(options, log);
  const address = await proxy.listen();
  log("info", "server_listening", {
    host: address.address,
    port: address.port,
    root: options.root,
    ready: false,
  });

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
    for (let attempt = 1; attempt <= 3 && !lifecycleStopping; attempt += 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, 100 * 2 ** (attempt - 1)),
      );
      try {
        appServer = await initializeAppServer();
        proxy.setTransport(appServer.rpc);
        proxy.setReady(true);
        log("info", "app_server_restarted", { attempt });
        recovering = false;
        return;
      } catch (error) {
        log("error", "app_server_restart_failed", {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    recovering = false;
    log("error", "app_server_restart_exhausted");
  };
  try {
    appServer = await initializeAppServer();
    proxy.setTransport(appServer.rpc);
    proxy.setReady(true);
    log("info", "app_server_ready");
  } catch (error) {
    await appServer?.stop().catch(() => undefined);
    await proxy.close().catch(() => undefined);
    throw error;
  }

  return await new Promise<number>((resolve) => {
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
            log("error", "shutdown_failed", {
              error: error instanceof Error ? error.message : String(error),
            });
            resolve(1);
          },
        );
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

/** Validates that a CLI path names a readable directory. */
async function assertDirectory(path: string, option: string): Promise<void> {
  await access(path, constants.R_OK);
  if (!(await stat(path)).isDirectory())
    throw new Error(`${option} must name a readable directory.`);
}
