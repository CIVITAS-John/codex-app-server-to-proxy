import {
  DEFAULT_CODEX_HOME_DESCRIPTION,
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_STATE_DIR_DESCRIPTION,
  parseServeOptions,
  resolveServeOptions,
  type ServeOptions,
} from "../core/config.js";
import { createLogger, type Logger } from "../core/logger.js";
import { createProxyServer, type ProxyServer } from "../http/server.js";
import {
  CLIENT_VERSION,
  PINNED_CODEX_VERSION,
  startAppServer,
  writeBackAuthCredentials,
  type AppServer,
} from "../app-server/app-server.js";
import { ensureAuthenticated } from "../app-server/auth.js";
import { installResponsesLiteOverride } from "../app-server/responses-lite-override.js";
import { abortableDelay } from "../core/abort.js";
import { homedir } from "node:os";
import { join } from "node:path";

/** Delays before bounded app-server restart attempts after an unexpected exit. */
export const APP_SERVER_RECOVERY_DELAYS_MS = [
  1_000, 3_000, 5_000, 10_000,
] as const;

/** Documents the CLI's supported command and options. */
export const usage = `Usage: codex-openai-proxy serve [options]

Options:
  --version                     Print the proxy version
  --help                        Print this help
  --host <host>                 Loopback host (default: 127.0.0.1)
  --port <port>                 TCP port, or 0 for an ephemeral port (default: 8787)
  --root <directory>            Allowed working-directory root (default: launch directory)
  --codex-path <path>           Override the package-owned Codex executable
  --codex-home <directory>      Codex home for the spawned app-server
                                (default: ${DEFAULT_CODEX_HOME_DESCRIPTION})
  --sync-auth <always|never>
                                Synchronize credentials from the main Codex home (default: always)
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
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  if (argv.includes("--version")) {
    process.stdout.write(`${CLIENT_VERSION}\n`);
    return 0;
  }
  if (argv[0] !== "serve")
    throw new Error(`Unknown command: ${argv[0]}\n\n${usage}`);
  const parsed = parseServeOptions(argv.slice(1));
  let log = createLogger(parsed.logLevel);
  try {
    const options = await resolveServeOptions(parsed);
    log = createLogger(options.logLevel);
    return await runServer(options, log);
  } catch (error) {
    log.failure("startup_failed", {}, error);
    return 1;
  }
}

/** Installs one-shot process signal handlers and returns an idempotent disposer. */
function installSignalHandlers(
  stop: (signal: NodeJS.Signals) => void,
): () => void {
  const onSigint = (): void => stop("SIGINT");
  const onSigterm = (): void => stop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  // `process.off` is idempotent, so the disposer needs no repeat guard.
  return (): void => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

/** Dependencies required to supervise the app-server lifecycle. */
interface AppServerSupervisorOptions {
  options: ServeOptions;
  log: Logger;
  proxy: ProxyServer;
  lifecycle: AbortController;
}

/** Owns app-server startup, authentication, transport installation, and recovery. */
class AppServerSupervisor {
  readonly #options: ServeOptions;
  readonly #log: Logger;
  readonly #proxy: ProxyServer;
  readonly #lifecycle: AbortController;
  #active: AppServer | undefined;
  #starting: AppServer | undefined;
  #initializing: Promise<AppServer> | undefined;
  #recovering = false;

  constructor({ options, log, proxy, lifecycle }: AppServerSupervisorOptions) {
    this.#options = options;
    this.#log = log;
    this.#proxy = proxy;
    this.#lifecycle = lifecycle;
  }

  /** Starts the initial child and installs its transport before returning. */
  async start(): Promise<void> {
    await this.#startAndInstall();
  }

  /** Waits for initialization to settle, then stops every current child. */
  async stop(): Promise<void> {
    // startAppServer owns cancellation before it can expose an AppServer. Await
    // that task so shutdown cannot complete while a recovery child is still
    // being verified, initialized, or authenticated.
    let initialized: AppServer | undefined;
    try {
      initialized = await this.#initializing;
    } catch {
      // Startup and recovery errors stay with the callers that requested them.
    }
    const children = [
      ...new Set([this.#active, this.#starting, initialized]),
    ].filter((child): child is AppServer => child !== undefined);
    // AppServer.stop() memoizes its own shutdown, so repeated calls are safe.
    const results = await Promise.allSettled(
      children.map(async (child) => await child.stop()),
    );
    // A child that will not stop cannot be recovered from during shutdown, so
    // it is reported rather than propagated.
    for (const result of results)
      if (result.status === "rejected")
        this.#log.failure("app_server_stop_failed", {}, result.reason);
  }

  /** Stops one partial child without masking the failure that preceded it. */
  async #stopPartial(next: AppServer): Promise<void> {
    try {
      await next.stop();
    } catch (error) {
      this.#log.failure("app_server_stop_failed", {}, error);
    }
  }

  /** Starts and authenticates one child without exposing a partial transport. */
  async #initialize(): Promise<AppServer> {
    // A user-provided proxy-only login must remain untouched when opted out,
    // which an absent source already encodes for both seeding and write-back.
    const seedSource =
      this.#options.syncAuth === "never"
        ? undefined
        : (process.env.CODEX_HOME ?? join(homedir(), ".codex"));
    // A first-run app-server can create models_cache.json during setup. Keep
    // that unpatched child private and restart it once with the new catalog
    // before the proxy becomes ready.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const next = await startAppServer({
        codexPath: this.#options.codexPath,
        codexHome: this.#options.codexHome,
        seedAuthFrom: seedSource,
        root: this.#options.root,
        startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
        shutdownTimeoutMs: this.#options.shutdownTimeoutMs,
        log: this.#log,
        signal: this.#lifecycle.signal,
      });
      this.#starting = next;
      let exited = false;
      next.child.once("exit", () => {
        exited = true;
        if (!this.#lifecycle.signal.aborted && this.#active === next) {
          this.#active = undefined;
          this.#proxy.setReady(false);
          this.#proxy.setTransport(undefined);
          void this.#recover();
        }
      });
      try {
        const { recoveredLogin } = await ensureAuthenticated({
          rpc: next.rpc,
          log: this.#log,
          timeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
          interactive: Boolean(process.stderr.isTTY),
          terminal: (message) => process.stderr.write(message),
          signal: this.#lifecycle.signal,
        });
        if (
          recoveredLogin &&
          next.authSeeded &&
          seedSource !== undefined &&
          !this.#lifecycle.signal.aborted &&
          !exited
        )
          await writeBackAuthCredentials(
            this.#options.codexHome,
            seedSource,
            this.#log,
          );
        if (this.#lifecycle.signal.aborted || exited)
          throw (
            this.#lifecycle.signal.reason ??
            new Error("app-server exited during startup")
          );

        if (!next.responsesLiteOverrideApplied && attempt === 0) {
          const override = await installResponsesLiteOverride(
            this.#options.codexHome,
            this.#log,
          );
          if (override.status === "applied") {
            // model_catalog_json is startup-only, so the bootstrap child must
            // exit before a replacement can load the generated catalog.
            await next.stop();
            if (this.#starting === next) this.#starting = undefined;
            continue;
          }
        }
      } catch (error) {
        await this.#stopPartial(next);
        if (this.#starting === next) this.#starting = undefined;
        throw error;
      }
      this.#starting = undefined;
      return next;
    }
    throw new Error("Responses Lite override restart did not settle.");
  }

  /** Atomically promotes one initialized child into the live proxy transport. */
  async #startAndInstall(): Promise<void> {
    const initializing = this.#initialize();
    this.#initializing = initializing;
    try {
      const next = await initializing;
      if (this.#lifecycle.signal.aborted) {
        await this.#stopPartial(next);
        throw this.#lifecycle.signal.reason;
      }
      this.#active = next;
      this.#proxy.setTransport(next.rpc, next.requirements);
      this.#proxy.setReady(true);
    } finally {
      if (this.#initializing === initializing) this.#initializing = undefined;
    }
  }

  /** Runs the single bounded recovery loop while leaving HTTP listening. */
  async #recover(): Promise<void> {
    if (this.#recovering || this.#lifecycle.signal.aborted) return;
    this.#recovering = true;
    this.#proxy.setReady(false);
    try {
      for (const [index, delayMs] of APP_SERVER_RECOVERY_DELAYS_MS.entries()) {
        if (this.#lifecycle.signal.aborted) return;
        const attempt = index + 1;
        try {
          await abortableDelay(delayMs, this.#lifecycle.signal);
        } catch {
          if (this.#lifecycle.signal.aborted) return;
          throw new Error("App-server recovery delay failed.");
        }
        try {
          await this.#startAndInstall();
          this.#log("info", "app_server_restarted", { attempt });
          return;
        } catch (error) {
          if (this.#lifecycle.signal.aborted) return;
          this.#log.failure("app_server_restart_failed", { attempt }, error);
        }
      }
      this.#log("error", "app_server_restart_exhausted");
    } finally {
      this.#recovering = false;
    }
  }
}

/** Runs the proxy lifecycle after configuration has been fully resolved. */
async function runServer(options: ServeOptions, log: Logger): Promise<number> {
  const proxy = createProxyServer(options, log);
  const address = await proxy.listen();
  log("info", "server_listening", {
    proxy_version: CLIENT_VERSION,
    codex_version: PINNED_CODEX_VERSION,
    host: address.address,
    port: address.port,
    default_sandbox: "disabled",
    default_web_search: "disabled",
    ready: false,
  });
  log("debug", "server_root", { root: options.root });

  const lifecycle = new AbortController();
  const supervisor = new AppServerSupervisor({
    options,
    log,
    proxy,
    lifecycle,
  });
  let settleShutdown!: (code: number) => void;
  const shutdown = new Promise<number>((resolve) => {
    settleShutdown = resolve;
  });
  let stopping: Promise<void> | undefined;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    lifecycle.abort(new Error(`proxy received ${signal}`));
    log("info", "shutdown_started", { signal });
    proxy.setReady(false);
    // Disposing the coordinator first rejects suspended dynamic tool calls
    // before the child transport is terminated.
    proxy.setTransport(undefined);
    stopping = (async () => {
      try {
        await supervisor.stop();
        await proxy.close();
        log("info", "shutdown_complete");
        settleShutdown(0);
      } catch (error) {
        await proxy.close().catch(() => undefined);
        log.failure("shutdown_failed", {}, error);
        settleShutdown(1);
      }
    })();
  };
  // Install lifecycle handlers before authentication so login is cancellable.
  const disposeSignals = installSignalHandlers(stop);
  try {
    // Authentication must finish before readiness admits proxy traffic.
    await supervisor.start();
    if (lifecycle.signal.aborted) return await shutdown;
    // Announce readiness only after shutdown handlers can observe an immediate signal.
    log("info", "app_server_ready", {
      proxy_version: CLIENT_VERSION,
      codex_version: PINNED_CODEX_VERSION,
    });
    return await shutdown;
  } catch (error) {
    if (lifecycle.signal.aborted) return await shutdown;
    await supervisor.stop().catch(() => undefined);
    await proxy.close().catch(() => undefined);
    throw error;
  } finally {
    disposeSignals();
  }
}
