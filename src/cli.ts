import { access, constants, stat } from "node:fs/promises";
import { parseServeOptions } from "./config.js";
import { createLogger } from "./logger.js";
import { createProxyServer } from "./server.js";

export const usage = `Usage: codex-openai-proxy serve [options]

Options:
  --host <host>                 Loopback host (default: 127.0.0.1)
  --port <port>                 TCP port, or 0 for an ephemeral port (default: 8787)
  --root <directory>            Allowed working-directory root (default: launch directory)
  --codex-path <path>           Codex executable (default: codex)
  --tool-timeout <duration>     Dynamic tool deadline (default: 5m)
  --request-timeout <duration>  HTTP request deadline (default: 30s)
  --shutdown-timeout <duration> Graceful shutdown deadline (default: 10s)
  --body-limit <bytes>          Maximum request body (default: 1048576)
  --max-requests <count>        Maximum concurrent requests (default: 100)
  --log-level <level>           debug, info, warn, or error (default: info)
  --state-dir <directory>       State directory (default: <root>/.codex-openai-proxy)`;

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

  return await new Promise<number>((resolve) => {
    let stopping = false;
    const stop = (signal: NodeJS.Signals): void => {
      if (stopping) return;
      stopping = true;
      log("info", "shutdown_started", { signal });
      void proxy.close().then(
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

async function assertDirectory(path: string, option: string): Promise<void> {
  await access(path, constants.R_OK);
  if (!(await stat(path)).isDirectory())
    throw new Error(`${option} must name a readable directory.`);
}
