import type { InitializeResponse } from "../../protocol/generated/typescript/InitializeResponse.js";
import type { ConfigRequirementsReadResponse } from "../../protocol/generated/typescript/v2/ConfigRequirementsReadResponse.js";
import {
  protocolInitializeResponse,
  protocolModel,
  protocolResponse,
} from "./protocol-fixtures.js";

/** Parsed-message identifier supplied to custom fake Codex source generators. */
const FAKE_CODEX_MESSAGE_IDENTIFIER = "message" as const;

/**
 * Produces trusted source inserted into the line handler, where the supplied
 * identifier names the parsed client message and remains in scope.
 */
export type FakeCodexLineSource = (
  messageIdentifier: typeof FAKE_CODEX_MESSAGE_IDENTIFIER,
) => string;

/** Inputs used to build a maintained fake Codex executable script. */
export interface FakeCodexScriptOptions {
  version: string;
  onLine?: FakeCodexLineSource | undefined;
  setup?: string | undefined;
  initializeResponse?: InitializeResponse | undefined;
  requirementsResponse?: ConfigRequirementsReadResponse | undefined;
}

/** Builds a fake Codex executable with typed default startup responses. */
export function fakeCodexScript(options: FakeCodexScriptOptions): string {
  const initializeResponse =
    options.initializeResponse ?? protocolInitializeResponse();
  const requirementsResponse =
    options.requirementsResponse ??
    protocolResponse("configRequirements/read", 0, { requirements: null })
      .result;
  const versionOutput = JSON.stringify(`codex-cli ${options.version}`);
  const initializeJson = JSON.stringify(initializeResponse);
  const requirementsJson = JSON.stringify(requirementsResponse);
  const modelListJson = JSON.stringify(
    protocolResponse("model/list", 0, {
      data: [protocolModel("gpt-6-luna")],
      nextCursor: null,
    }).result,
  );
  const setupSource = options.setup ?? "";
  const onLineSource = options.onLine?.(FAKE_CODEX_MESSAGE_IDENTIFIER) ?? "";

  // setup and onLine deliberately accept trusted test source; all data values
  // are JSON-encoded before interpolation so fixture data cannot become code.
  return `#!${process.execPath}
"use strict";
if (process.argv.includes("--version")) {
  console.log(${versionOutput});
  process.exit(0);
}
const readline = require("node:readline");
${setupSource}
const initializeResponse = ${initializeJson};
const requirementsResponse = ${requirementsJson};
const modelListResponse = ${modelListJson};
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const ${FAKE_CODEX_MESSAGE_IDENTIFIER} = JSON.parse(line);
${onLineSource}
  if (${FAKE_CODEX_MESSAGE_IDENTIFIER}.method === "initialize") {
    console.log(JSON.stringify({ id: ${FAKE_CODEX_MESSAGE_IDENTIFIER}.id, result: initializeResponse }));
    return;
  }
  if (${FAKE_CODEX_MESSAGE_IDENTIFIER}.method === "configRequirements/read") {
    console.log(JSON.stringify({ id: ${FAKE_CODEX_MESSAGE_IDENTIFIER}.id, result: requirementsResponse }));
    return;
  }
  if (${FAKE_CODEX_MESSAGE_IDENTIFIER}.method === "model/list") {
    const fs = require("node:fs");
    const path = require("node:path");
    const cachePath = path.join(process.env.CODEX_HOME, "models_cache.json");
    fs.writeFileSync(cachePath, JSON.stringify({
      client_version: ${JSON.stringify(options.version)},
      fetched_at: "fixture",
      models: [{ slug: "gpt-6-luna", use_responses_lite: true }]
    }));
    console.log(JSON.stringify({ id: ${FAKE_CODEX_MESSAGE_IDENTIFIER}.id, result: modelListResponse }));
  }
});
`;
}
