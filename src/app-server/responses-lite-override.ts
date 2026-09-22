import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../core/logger.js";

/** Cache filename owned and refreshable by Codex. */
const SOURCE_CATALOG_FILENAME = "models_cache.json";

/** Proxy-owned catalog filename that Codex loads instead of its cache. */
export const RESPONSES_LITE_OVERRIDE_CATALOG_FILENAME =
  "models.no-responses-lite.json";

/** Codex user configuration filename within the selected Codex home. */
const CODEX_CONFIG_FILENAME = "config.toml";

/** Start marker for the temporary proxy-owned configuration block. */
const CONFIG_BLOCK_START =
  "# BEGIN codex-openai-proxy temporary Responses Lite override";

/** End marker for the temporary proxy-owned configuration block. */
const CONFIG_BLOCK_END =
  "# END codex-openai-proxy temporary Responses Lite override";

/** Matches a previously installed temporary configuration block. */
const CONFIG_BLOCK_PATTERN =
  /^# BEGIN codex-openai-proxy temporary Responses Lite override\r?\n[\s\S]*?^# END codex-openai-proxy temporary Responses Lite override(?:\r?\n)?/gmu;

/** Matches an existing one-line top-level catalog override. */
const MODEL_CATALOG_KEY_PATTERN =
  /^[\t ]*(?:model_catalog_json|"model_catalog_json"|'model_catalog_json')[\t ]*=.*(?:\r?\n|$)/gmu;

/** Mutable JSON object used while patching the model catalog clone. */
type JsonObject = Record<string, unknown>;

/** Result of attempting to install the temporary catalog override. */
export type ResponsesLiteOverrideResult =
  | { status: "missing-cache" }
  | { status: "applied"; changed: boolean; modelCount: number };

/** Returns whether a JSON value is a mutable object rather than an array. */
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a UTF-8 file, returning undefined only when the file is absent. */
async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Atomically writes private content only when the target would change. */
async function writePrivateFileIfChanged(
  path: string,
  content: string,
): Promise<boolean> {
  const current = await readOptionalText(path);
  // Skipping an identical write keeps ordinary restarts from rewriting the
  // user's config.toml and from logging an install that did not happen.
  if (current === content) return false;

  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    return true;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Clones and patches every model entry in a Codex cache document. */
function disableResponsesLite(source: string): {
  content: string;
  modelCount: number;
} {
  let catalog: unknown;
  try {
    catalog = JSON.parse(source);
  } catch {
    throw new Error("Codex models_cache.json is not valid JSON.");
  }
  if (!isJsonObject(catalog) || !Array.isArray(catalog.models))
    throw new Error("Codex models_cache.json has no models array.");
  if (catalog.models.length === 0)
    throw new Error("Codex models_cache.json contains no models.");

  for (const [index, model] of catalog.models.entries()) {
    if (!isJsonObject(model))
      throw new Error(
        `Codex models_cache.json model ${index} is not an object.`,
      );
    const usedResponsesLite = model.use_responses_lite === true;
    model.use_responses_lite = false;
    // Code-only routing turns dynamic functions into nested exec callbacks.
    // Codex 0.154.0 no longer exposes supports_parallel_tool_calls in model
    // metadata. Gating on that removed field silently retains code-only tools.
    if (usedResponsesLite) delete model.tool_mode;
  }

  return {
    content: `${JSON.stringify(catalog, null, 2)}\n`,
    modelCount: catalog.models.length,
  };
}

/** Removes only the static catalog selection for a fresh Codex model fetch. */
export function configWithoutModelCatalogOverride(existing: string): string {
  const withoutManagedBlock = existing.replace(CONFIG_BLOCK_PATTERN, "");
  const withoutCatalogKey = withoutManagedBlock.replace(
    MODEL_CATALOG_KEY_PATTERN,
    "",
  );
  return withoutCatalogKey.replace(/^(?:\r?\n)+/u, "");
}

/** Renders the managed top-level override while preserving other Codex config. */
function renderConfig(existing: string, catalogPath: string): string {
  const remainder = configWithoutModelCatalogOverride(existing);
  const managedBlock = [
    CONFIG_BLOCK_START,
    "# Temporary workaround for the Codex 0.154.0 Responses request framing.",
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    CONFIG_BLOCK_END,
    "",
  ].join("\n");
  return remainder === "" ? managedBlock : `${managedBlock}\n${remainder}`;
}

/**
 * Installs a separate catalog that disables Responses Lite and restores direct
 * tools for converted models, without mutating the cache.
 */
export async function installResponsesLiteOverride(
  codexHome: string,
  log: Logger,
): Promise<ResponsesLiteOverrideResult> {
  const sourcePath = join(codexHome, SOURCE_CATALOG_FILENAME);
  const source = await readOptionalText(sourcePath);
  if (source === undefined) {
    log("debug", "responses_lite_override_waiting_for_catalog");
    return { status: "missing-cache" };
  }

  const overridePath = join(
    codexHome,
    RESPONSES_LITE_OVERRIDE_CATALOG_FILENAME,
  );
  const configPath = join(codexHome, CODEX_CONFIG_FILENAME);
  const { content, modelCount } = disableResponsesLite(source);
  const catalogChanged = await writePrivateFileIfChanged(overridePath, content);
  const existingConfig = (await readOptionalText(configPath)) ?? "";
  const configChanged = await writePrivateFileIfChanged(
    configPath,
    renderConfig(existingConfig, overridePath),
  );
  const changed = catalogChanged || configChanged;
  if (changed)
    log("info", "responses_lite_override_installed", {
      model_count: modelCount,
    });
  return { status: "applied", changed, modelCount };
}
