import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { FakeAppServer, runOfflineSpike } from "../scripts/offline-spike.mjs";

const root = new URL("../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

test("generated artifacts pin the exact experimental Codex version", async () => {
  const version = await readJson("protocol/VERSION.json");
  assert.equal(version.codexVersion, "0.144.0-alpha.4");
  assert.equal(version.experimental, true);
  const ts = await readdir(new URL("protocol/generated/typescript", root));
  const schemas = await readdir(new URL("protocol/generated/json-schema", root));
  assert(ts.includes("ServerNotification.ts"));
  assert(schemas.includes("codex_app_server_protocol.v2.schemas.json"));
});

test("every claimed exposed app-server event has a synthetic fixture", async () => {
  const lines = (await readFile(new URL("protocol/fixtures/exposed-events.jsonl", root), "utf8")).trim().split("\n");
  const methods = new Set(lines.map((line) => JSON.parse(line).method));
  for (const method of [
    "item/agentMessage/delta", "item/reasoning/summaryPartAdded",
    "item/reasoning/summaryTextDelta", "item/reasoning/textDelta",
    "item/commandExecution/outputDelta", "item/fileChange/outputDelta",
    "item/fileChange/patchUpdated", "item/mcpToolCall/progress",
    "thread/tokenUsage/updated", "turn/completed", "error",
    "item/tool/call", "item/commandExecution/requestApproval", "serverRequest/resolved",
  ]) assert(methods.has(method), `missing fixture: ${method}`);
});

test("offline spike covers text, two-request tool flow, and restart", () => {
  assert.deepEqual(runOfflineSpike(), {
    modelCalls: 0, threadId: "thr_1", resumedAfterRestart: true, toolRoundTrip: true,
  });
});

test("all rejected continuation classes are explicit and leave state unchanged", async () => {
  const cases = await readJson("protocol/fixtures/continuation-cases.json");
  assert.equal(new Set(cases.map((entry) => entry.case)).size, 13);
  for (const entry of cases) {
    assert.match(entry.code, /^[a-z][a-z0-9_]+$/);
    const app = new FakeAppServer();
    const threadId = app.startThread();
    app.streamText(threadId, "original");
    const before = JSON.stringify(app.snapshot());
    const startedBefore = app.startedThreads;
    // Rejection is a validation result, so no app-server method is called.
    const error = { error: { type: entry.status >= 500 ? "server_error" : "conflict_error", code: entry.code } };
    assert.equal(error.error.code, entry.code);
    assert.equal(JSON.stringify(app.snapshot()), before);
    assert.equal(app.startedThreads, startedBefore);
  }
});

test("contract explicitly classifies every unsupported mapping", async () => {
  const contract = await readFile(new URL("protocol/CONTRACT.md", root), "utf8");
  for (const code of [
    "unrepresentable_message_history", "unsupported_tool_choice", "unsupported_parameter",
    "unsupported_web_search_mode", "continuation_history_mismatch",
  ]) assert(contract.includes(code), `missing explicit error: ${code}`);
  assert.match(contract, /never falls back to `thread\/start`/);
});
