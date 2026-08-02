import type { JsonRpcTransport } from "./json-rpc.js";
import { record } from "../core/canonical.js";

/**
 * A validated app-server catalog model. Only the selector and its visibility
 * are required, so an entry carrying unfamiliar presentation metadata never
 * fails the whole catalog; every other field is retained untouched.
 */
export interface CatalogModel {
  model: string;
  hidden: boolean;
  [metadata: string]: unknown;
}

/** Options that control the app-server model catalog request. */
export interface ReadModelCatalogOptions {
  includeHidden?: boolean;
  signal?: AbortSignal;
}

/** Reads every app-server model-list page while validating only its used shape. */
export async function readModelCatalog(
  rpc: Pick<JsonRpcTransport, "request">,
  options: ReadModelCatalogOptions = {},
): Promise<CatalogModel[]> {
  const includeHidden = options.includeHidden ?? false;
  const models: CatalogModel[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  do {
    const response = await rpc.request(
      "model/list",
      { cursor, limit: 100, includeHidden },
      options.signal,
    );
    const page = validatePage(response);
    for (const model of page.data) models.push(validateModel(model));

    cursor = page.nextCursor;
    if (cursor !== null && seenCursors.has(cursor))
      throw new Error("model/list returned a repeated pagination cursor.");
    if (cursor !== null) seenCursors.add(cursor);
  } while (cursor !== null);

  return models;
}

/** The narrow, runtime-validated portion of an app-server model-list page. */
interface ModelCatalogPage {
  data: unknown[];
  nextCursor: string | null;
}

/** Validates the pagination envelope without imposing generated Model details. */
function validatePage(value: unknown): ModelCatalogPage {
  const page = record(value);
  if (
    !page ||
    !Array.isArray(page.data) ||
    !(page.nextCursor === null || typeof page.nextCursor === "string")
  )
    throw new Error("model/list returned an invalid page.");
  return { data: page.data, nextCursor: page.nextCursor };
}

/** Validates the two required catalog fields while preserving metadata. */
function validateModel(value: unknown): CatalogModel {
  const model = record(value);
  if (
    !model ||
    typeof model.model !== "string" ||
    model.model.trim() === "" ||
    typeof model.hidden !== "boolean"
  )
    throw new Error("model/list returned an invalid model.");
  return model as CatalogModel;
}
