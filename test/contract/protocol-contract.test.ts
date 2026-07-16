import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { ResponseStore } from "../../src/continuation/state.js";
import { repoRootUrl } from "../support/repo-root.js";
import { exposedEvents } from "../../protocol/fixtures/exposed-events.js";
import {
  protocolClientNotification,
  protocolClientRequest,
} from "../support/protocol-fixtures.js";

/** Repository root used to resolve generated protocol artifacts. */
const root = repoRootUrl;
/** Reads and parses a JSON protocol artifact. */
const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(path, root), "utf8"));

/** Loads one raw version-0 continuation fixture through the production reader. */
async function loadContinuationFixture(
  record: Record<string, unknown>,
): Promise<ReturnType<ResponseStore["get"]>> {
  const directory = await mkdtemp(join(tmpdir(), "codex-schema-contract-"));
  try {
    await writeFile(
      join(directory, "continuations.json"),
      JSON.stringify({ version: 0, records: [record] }),
      { mode: 0o600 },
    );
    return new ResponseStore(directory).get(String(record.responseId));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("shared client fixture builders enforce generated wire types", () => {
  const request = protocolClientRequest({
    method: "turn/interrupt",
    id: 1,
    params: { threadId: "thr_fixture", turnId: "turn_fixture" },
  });
  const notification = protocolClientNotification({ method: "initialized" });
  assert.equal(request.method, "turn/interrupt");
  assert.equal(notification.method, "initialized");
});

test("generated artifacts pin the exact experimental Codex version", async () => {
  const packageJson = (await readJson("package.json")) as {
    dependencies: { "@openai/codex": string };
  };
  const packageLock = (await readJson("package-lock.json")) as {
    packages: Record<string, { version?: string }>;
  };
  const version = (await readJson("protocol/VERSION.json")) as {
    codexPackage: string;
    codexVersion: string;
    versionSource: string;
    experimental: boolean;
  };
  const pinnedVersion = packageJson.dependencies["@openai/codex"];
  assert.match(pinnedVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(
    packageLock.packages["node_modules/@openai/codex"]?.version,
    pinnedVersion,
  );
  assert.equal(version.codexPackage, "@openai/codex");
  assert.equal(version.codexVersion, pinnedVersion);
  assert.equal(
    version.versionSource,
    "package.json dependencies.@openai/codex",
  );
  assert.equal(version.experimental, true);
  const ts = await readdir(new URL("protocol/generated/typescript", root));
  const schemas = await readdir(
    new URL("protocol/generated/json-schema", root),
  );
  assert(ts.includes("ServerNotification.ts"));
  assert(schemas.includes("codex_app_server_protocol.v2.schemas.json"));
  const contract = await readFile(
    new URL("protocol/CONTRACT.md", root),
    "utf8",
  );
  assert.match(
    contract,
    new RegExp(`codex-cli ${pinnedVersion.replaceAll(".", "\\.")}`),
  );
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
  assert.deepEqual(
    lines.map((line) => JSON.parse(line) as unknown),
    exposedEvents,
    "JSONL corpus drifted from its generated-protocol-typed source",
  );
  assert.equal(new Set(claimed).size, claimed.length, "duplicate event claim");
  assert.equal(
    new Set(fixtureMethods).size,
    fixtureMethods.length,
    "duplicate event fixture",
  );
  assert.deepEqual([...fixtureMethods].sort(), [...claimed].sort());
});

test("continuation schema examples agree with the production store reader", async () => {
  const schema = (await readJson(
    "protocol/schemas/response-mapping.schema.json",
  )) as {
    properties: { version: { const: number } };
    $defs: {
      record: {
        additionalProperties: boolean;
        required: string[];
        properties: {
          responseId: { minLength: number };
          toolsHash: { pattern: string };
          callIds: { uniqueItems: boolean };
        };
      };
    };
  };
  const recordSchema = schema.$defs.record;
  assert.equal(schema.properties.version.const, 0);
  assert.equal(recordSchema.additionalProperties, false);
  assert.equal(recordSchema.properties.responseId.minLength, 1);
  assert.equal(recordSchema.properties.toolsHash.pattern, "^[a-f0-9]{64}$");
  assert.equal(recordSchema.properties.callIds.uniqueItems, true);

  const accepted = {
    responseId: "response_schema_valid",
    threadId: "thread_schema_valid",
    state: "ready",
    model: "gpt-5.4-mini",
    cwd: "/tmp/workspace",
    toolsHash: "a".repeat(64),
    policyHash: "b".repeat(64),
    createdAt: 1,
    expiresAt: Date.now() + 60_000,
    callIds: ["call_1", "call_2"],
  };
  assert.deepEqual(
    [...recordSchema.required].sort(),
    Object.keys(accepted)
      .filter((key) => key !== "callIds")
      .sort(),
  );
  assert.equal(
    (await loadContinuationFixture(accepted))?.threadId,
    accepted.threadId,
  );

  const rejected = [
    { ...accepted, responseId: "" },
    { ...accepted, toolsHash: "A".repeat(64) },
    { ...accepted, createdAt: null },
    { ...accepted, callIds: ["duplicate", "duplicate"] },
    { ...accepted, unexpected: true },
  ];
  for (const record of rejected)
    assert.equal(
      await loadContinuationFixture(record),
      undefined,
      `trusted schema-invalid continuation ${JSON.stringify(record)}`,
    );
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
