import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "vitest";

const root = new URL("../", import.meta.url);
const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(path, root), "utf8"));

test("generated artifacts pin the exact experimental Codex version", async () => {
  const version = (await readJson("protocol/VERSION.json")) as {
    codexVersion: string;
    experimental: boolean;
  };
  assert.equal(version.codexVersion, "0.144.0-alpha.4");
  assert.equal(version.experimental, true);
  const ts = await readdir(new URL("protocol/generated/typescript", root));
  const schemas = await readdir(
    new URL("protocol/generated/json-schema", root),
  );
  assert(ts.includes("ServerNotification.ts"));
  assert(schemas.includes("codex_app_server_protocol.v2.schemas.json"));
});

test("every claimed exposed app-server event has a synthetic fixture", async () => {
  const lines = (
    await readFile(
      new URL("protocol/fixtures/exposed-events.jsonl", root),
      "utf8",
    )
  )
    .trim()
    .split("\n");
  const methods = new Set(
    lines.map((line) => (JSON.parse(line) as { method: string }).method),
  );
  for (const method of [
    "item/agentMessage/delta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/textDelta",
    "item/commandExecution/outputDelta",
    "item/fileChange/outputDelta",
    "item/fileChange/patchUpdated",
    "item/mcpToolCall/progress",
    "thread/tokenUsage/updated",
    "turn/completed",
    "error",
    "item/tool/call",
    "item/commandExecution/requestApproval",
    "serverRequest/resolved",
  ]) {
    assert(methods.has(method), `missing fixture: ${method}`);
  }
});

test("contract explicitly classifies every unsupported mapping", async () => {
  const contract = await readFile(
    new URL("protocol/CONTRACT.md", root),
    "utf8",
  );
  for (const code of [
    "unrepresentable_message_history",
    "unsupported_tool_choice",
    "unsupported_parameter",
    "unsupported_web_search_mode",
    "continuation_history_mismatch",
  ]) {
    assert(contract.includes(code), `missing explicit error: ${code}`);
  }
  assert.match(contract, /never falls back to `thread\/start`/);
});
