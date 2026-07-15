import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "vitest";
import { repoRootUrl } from "../support/repo-root.js";

/** Repository root used to resolve generated protocol artifacts. */
const root = repoRootUrl;
/** Reads and parses a JSON protocol artifact. */
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

test("contract documents the implemented Stage 05 compatibility mappings", async () => {
  const contract = await readFile(
    new URL("protocol/CONTRACT.md", root),
    "utf8",
  );
  const ignoredRow = contract
    .split("\n")
    .find(
      (line) =>
        line.includes("`temperature`") &&
        line.includes("| Ignored with warning |"),
    );
  assert(ignoredRow, "missing ignored-field classification");
  const ignoredFields = [...ignoredRow.matchAll(/`([^`]+)`/g)].map(
    (match) => match[1],
  );
  assert(ignoredFields.length > 20, "ignored fields were not enumerated");
  assert.match(
    contract,
    /Any other unknown top-level field.*Ignored with warning/,
  );
  assert.match(contract, /`unsupported_chat_fields_ignored`/);
  assert.match(contract, /`none` is accepted/);
  assert.match(contract, /`choices\[0\]\.delta\.reasoning`/);
  assert.match(
    contract,
    /nonstandard direct compatibility field `tool_results`/,
  );
  assert.match(
    contract,
    /Supplies `model`, `ephemeral: false`, and `dynamicTools`/,
  );
  assert.match(contract, /HTTP 503 before headers/);
  assert.match(contract, /closes without `\[DONE\]`/);
  for (const unimplemented of [
    "unrepresentable_message_history",
    "continuation_history_mismatch",
    "unsupported_parameter",
  ])
    assert(!contract.includes(unimplemented), `stale error: ${unimplemented}`);
  assert.match(contract, /never falls back to `thread\/start`/);
});
