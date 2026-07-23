import { pathToFileURL } from "node:url";
import { startAppServer } from "../dist/app-server/app-server.js";
import { ensureAuthenticated } from "../dist/app-server/auth.js";

const REQUEST_TIMEOUT_MS = 30_000;
const AUTH_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 100;

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

/** Reads and validates every page in the live app-server model catalog. */
export async function readModelCatalog(request, includeHidden = false) {
  const models = [];
  const seenCursors = new Set();
  let cursor = null;

  do {
    const response = await request({
      cursor,
      limit: PAGE_LIMIT,
      includeHidden,
    });
    if (
      typeof response !== "object" ||
      response === null ||
      !Array.isArray(response.data) ||
      !(
        response.nextCursor === null ||
        typeof response.nextCursor === "string"
      )
    )
      throw new Error("model/list returned an invalid page.");

    for (const model of response.data) {
      validateModel(model);
      models.push(model);
    }

    cursor = response.nextCursor;
    if (cursor !== null && seenCursors.has(cursor))
      throw new Error("model/list returned a repeated pagination cursor.");
    if (cursor !== null) seenCursors.add(cursor);
  } while (cursor !== null);

  return models;
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
      const efforts = model.supportedReasoningEfforts
        .map((option) => option.reasoningEffort)
        .join(", ");
      return `${model.model}${suffix}\n  ${model.displayName}; reasoning: ${efforts || "not advertised"}`;
    })
    .join("\n");
}

/** Requires the catalog fields used by human and JSON output. */
function validateModel(model) {
  if (
    typeof model !== "object" ||
    model === null ||
    typeof model.model !== "string" ||
    model.model.length === 0 ||
    typeof model.displayName !== "string" ||
    typeof model.hidden !== "boolean" ||
    typeof model.isDefault !== "boolean" ||
    !Array.isArray(model.supportedReasoningEfforts) ||
    model.supportedReasoningEfforts.some(
      (option) =>
        typeof option !== "object" ||
        option === null ||
        typeof option.reasoningEffort !== "string",
    )
  )
    throw new Error("model/list returned an invalid model.");
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
    const models = await readModelCatalog(
      async (params) =>
        await appServer.rpc.request(
          "model/list",
          params,
          AbortSignal.any([
            lifecycle.signal,
            AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ]),
        ),
      options.includeHidden,
    );
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
