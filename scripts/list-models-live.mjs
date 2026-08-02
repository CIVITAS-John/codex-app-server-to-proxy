import { pathToFileURL } from "node:url";
import { startAppServer } from "../dist/app-server/app-server.js";
import { ensureAuthenticated } from "../dist/app-server/auth.js";
import { readModelCatalog } from "../dist/app-server/models.js";

const REQUEST_TIMEOUT_MS = 30_000;
const AUTH_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Logger used when catalog output must remain the only normal output. */
const silentLogger = Object.assign(() => undefined, {
  failure: () => undefined,
});

/** Parses the intentionally small live-model command surface. */
export function parseModelListArguments(argv) {
  const options = { includeHidden: false, json: false };
  for (const argument of argv) {
    if (argument === "--include-hidden") options.includeHidden = true;
    else if (argument === "--json") options.json = true;
    else
      throw new Error(
        `Unknown option ${argument}. Expected --include-hidden or --json.`,
      );
  }
  return options;
}

/** Formats model identifiers and their advertised reasoning efforts for humans. */
export function formatModelCatalog(models) {
  if (models.length === 0) return "No models are available.";
  return models
    .map((model) => {
      const flags = [
        model.isDefault ? "default" : undefined,
        model.hidden ? "hidden" : undefined,
      ].filter(Boolean);
      const suffix = flags.length === 0 ? "" : ` (${flags.join(", ")})`;
      // Presentation metadata is advisory: the catalog reader requires only the
      // selector and visibility, so absent fields degrade instead of throwing.
      const efforts = (model.supportedReasoningEfforts ?? [])
        .map((option) => option.reasoningEffort)
        .join(", ");
      return `${model.model}${suffix}\n  ${model.displayName ?? model.model}; reasoning: ${efforts || "not advertised"}`;
    })
    .join("\n");
}

/** Starts authenticated live Codex, prints its catalog, and always stops it. */
export async function runLiveModelList(argv) {
  const options = parseModelListArguments(argv);
  const lifecycle = new globalThis.AbortController();
  let appServer;

  const stop = () =>
    lifecycle.abort(new Error("Live model listing was interrupted."));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    appServer = await startAppServer({
      codexPath: process.env.CODEX_PATH ?? "codex",
      root: process.cwd(),
      startupTimeoutMs: REQUEST_TIMEOUT_MS,
      shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
      log: silentLogger,
      signal: lifecycle.signal,
    });
    await ensureAuthenticated({
      rpc: appServer.rpc,
      log: silentLogger,
      timeoutMs: AUTH_TIMEOUT_MS,
      interactive: Boolean(process.stderr.isTTY),
      terminal: (message) => process.stderr.write(message),
      signal: lifecycle.signal,
    });
    const models = await readModelCatalog(appServer.rpc, {
      includeHidden: options.includeHidden,
      // One deadline bounds the full pagination sequence, not each page alone.
      signal: AbortSignal.any([
        lifecycle.signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(models, null, 2)}\n`
        : `${formatModelCatalog(models)}\n`,
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await appServer?.stop();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runLiveModelList(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `Failed to list live Codex models: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
