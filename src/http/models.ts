import type { ServerResponse } from "node:http";
import { readModelCatalog, type CatalogModel } from "../app-server/models.js";
import type { JsonRpcTransport } from "../app-server/json-rpc.js";
import type { Logger } from "../core/logger.js";
import { appServerError, writeJson } from "./errors.js";

/** Standard OpenAI-compatible representation of one available model. */
export interface ModelListItem {
  id: string;
  object: "model";
  created: 0;
  owned_by: "openai";
}

/** Standard OpenAI-compatible response returned by the models collection. */
export interface ModelListResponse {
  object: "list";
  data: ModelListItem[];
}

/** Dependencies required to translate one app-server model catalog request. */
export interface ModelListHandlerOptions {
  rpc: Pick<JsonRpcTransport, "request">;
  log: Logger;
  requestId: string;
  signal: AbortSignal;
}

/** Lists visible app-server models using the standard OpenAI collection shape. */
export async function handleModelList(
  response: ServerResponse,
  { rpc, log, requestId, signal }: ModelListHandlerOptions,
): Promise<void> {
  let catalog: CatalogModel[];
  try {
    catalog = await readModelCatalog(rpc, { includeHidden: false, signal });
  } catch (cause) {
    // The router owns cancellation's OpenAI-shaped timeout mapping so every
    // endpoint reports client disconnects and request deadlines consistently.
    if (signal.aborted) throw signal.reason;
    log.failure("models_list_failed", { request_id: requestId }, cause);
    throw appServerError("The app-server could not list models.");
  }
  // App-server's includeHidden flag is advisory, so hidden entries are dropped
  // again here. Keying by selector also keeps a slug repeated across pages from
  // becoming a duplicate id that clients index by.
  const visible = new Map(
    catalog
      .filter((model) => !model.hidden)
      .map((model) => [model.model, modelListItem(model)] as const),
  );
  writeJson(response, 200, {
    object: "list",
    data: [...visible.values()],
  } satisfies ModelListResponse);
}

/** Converts the app-server's public model selector to OpenAI's stable shape. */
function modelListItem(model: CatalogModel): ModelListItem {
  return {
    id: model.model,
    object: "model",
    // Catalog metadata has no OpenAI creation or owner equivalent, so retain
    // deterministic compatibility placeholders instead of inventing values.
    created: 0,
    owned_by: "openai",
  };
}
