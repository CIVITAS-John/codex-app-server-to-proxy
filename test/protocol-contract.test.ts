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
  const claimed = (await readJson(
    "protocol/fixtures/exposed-events.json",
  )) as string[];
  const lines = (
    await readFile(
      new URL("protocol/fixtures/exposed-events.jsonl", root),
      "utf8",
    )
  )
    .trim()
    .split("\n");
  const fixtureMethods = lines.map(
    (line) => (JSON.parse(line) as { method: string }).method,
  );
  assert.equal(new Set(claimed).size, claimed.length, "duplicate event claim");
  assert.equal(
    new Set(fixtureMethods).size,
    fixtureMethods.length,
    "duplicate event fixture",
  );
  assert.deepEqual([...fixtureMethods].sort(), [...claimed].sort());
});

test("contract explicitly classifies every unsupported mapping", async () => {
  const contract = await readFile(
    new URL("protocol/CONTRACT.md", root),
    "utf8",
  );
  const rejectedRow = contract
    .split("\n")
    .find((line) => line.includes("| Rejected |"));
  assert(rejectedRow, "missing rejected-field classification");
  const rejectedFields = [...rejectedRow.matchAll(/`([^`]+)`/g)].map(
    (match) => match[1],
  );
  assert(rejectedFields.length > 20, "rejected fields were not enumerated");
  assert.match(rejectedRow, /`unsupported_parameter`/);
  assert.match(contract, /Any unknown top-level field.*Ignored with warning/);
  assert.match(contract, /`unsupported_field_ignored`/);
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
