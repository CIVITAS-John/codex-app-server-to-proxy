import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { ResponseStore } from "../../src/continuation/state.js";
import { HANDLED_NOTIFICATION_METHODS } from "../../src/http/chat-normalize.js";
import { repoRootUrl } from "../support/repo-root.js";
import { exposedEvents } from "../../protocol/fixtures/exposed-events.js";
import {
  protocolClientNotification,
  protocolClientRequest,
} from "../support/protocol-fixtures.js";
import { withTempDir } from "../support/temp.js";

/** Repository root used to resolve generated protocol artifacts. */
const root = repoRootUrl;
/** Reads and parses a JSON protocol artifact. */
const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(path, root), "utf8"));

/** Loads one raw version-0 continuation fixture through the production reader. */
async function loadContinuationFixture(
  record: Record<string, unknown>,
): Promise<ReturnType<ResponseStore["get"]>> {
  return withTempDir(async (directory) => {
    await writeFile(
      join(directory, "continuations.json"),
      JSON.stringify({ version: 0, records: [record] }),
      { mode: 0o600 },
    );
    return new ResponseStore(directory).get(String(record.responseId));
  }, "codex-schema-contract-");
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

test("every exposed app-server event has one typed synthetic fixture", () => {
  const fixtureMethods = exposedEvents.map((fixture) => fixture.method);
  assert.equal(
    new Set(fixtureMethods).size,
    fixtureMethods.length,
    "duplicate event fixture",
  );
  const fixtureNotifications = exposedEvents
    .filter((fixture) => !("id" in fixture))
    .map((fixture) => fixture.method);
  assert.deepEqual(
    [...HANDLED_NOTIFICATION_METHODS].sort(),
    fixtureNotifications.sort(),
    "runtime-handled notifications drifted from the typed exposure corpus",
  );
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
          reasoningEffort: { type: string; minLength: number };
          state: { enum: string[] };
          toolsHash: { pattern: string };
          pendingCalls: { minItems: number };
          usageTotal: {
            additionalProperties: boolean;
            required: string[];
          };
        };
      };
    };
  };
  const recordSchema = schema.$defs.record;
  assert.equal(schema.properties.version.const, 0);
  assert.equal(recordSchema.additionalProperties, false);
  assert.equal(recordSchema.properties.responseId.minLength, 1);
  assert.equal(recordSchema.properties.reasoningEffort.type, "string");
  assert.equal(recordSchema.properties.reasoningEffort.minLength, 1);
  assert.deepEqual(recordSchema.properties.state.enum, [
    "ready",
    "pending_tool",
    "expired",
    "superseded",
  ]);
  assert.equal(recordSchema.properties.toolsHash.pattern, "^[a-f0-9]{64}$");
  assert.equal(recordSchema.properties.pendingCalls.minItems, 1);
  assert.equal(recordSchema.properties.usageTotal.additionalProperties, false);
  assert.deepEqual(recordSchema.properties.usageTotal.required.sort(), [
    "cachedInputTokens",
    "inputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ]);

  const accepted = {
    responseId: "response_schema_valid",
    threadId: "thread_schema_valid",
    state: "ready",
    model: "gpt-5.6-luna",
    cwd: "/tmp/workspace",
    toolsHash: "a".repeat(64),
    policyHash: "b".repeat(64),
    createdAt: 1,
    expiresAt: Date.now() + 60_000,
    usageTotal: {
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 5,
      reasoningOutputTokens: 1,
      totalTokens: 15,
    },
  };
  assert.deepEqual(
    [...recordSchema.required].sort(),
    Object.keys(accepted)
      .filter((key) => key !== "usageTotal")
      .sort(),
  );
  assert.equal(
    (await loadContinuationFixture(accepted))?.threadId,
    accepted.threadId,
  );
  assert.equal(
    (
      await loadContinuationFixture({
        ...accepted,
        reasoningEffort: "high",
      })
    )?.reasoningEffort,
    "high",
  );

  // A pending record's injectable call metadata round-trips with its state.
  const pendingAccepted = {
    ...accepted,
    responseId: "response_schema_pending",
    state: "pending_tool",
    pendingCalls: [
      { callId: "call_1", name: "lookup", arguments: '{"key":"value"}' },
      { callId: "call_2", name: "second", arguments: "{}" },
    ],
  };
  assert.deepEqual(
    (await loadContinuationFixture(pendingAccepted))?.pendingCalls,
    pendingAccepted.pendingCalls,
  );

  // The schema above describes what the proxy writes. The reader is
  // deliberately more permissive, because this process is the file's only
  // writer: it rejects only records it cannot use, and preserves unknown
  // fields so a store written by a newer version stays loadable.
  const rejected = [
    { ...accepted, responseId: "" },
    { ...accepted, threadId: 5 },
    { ...accepted, createdAt: null },
    { ...accepted, state: "half_written" },
    { ...accepted, state: "pending_tool" },
    { ...accepted, usageTotal: { inputTokens: 1, outputTokens: 1 } },
    // Injected call metadata must be complete to rebuild the Responses pair.
    {
      ...pendingAccepted,
      pendingCalls: [{ callId: "call_1", name: "lookup" }],
    },
  ];
  for (const record of rejected)
    assert.equal(
      await loadContinuationFixture(record),
      undefined,
      `trusted unusable continuation ${JSON.stringify(record)}`,
    );

  assert.equal(
    (await loadContinuationFixture({ ...accepted, unknownFutureField: true }))
      ?.threadId,
    accepted.threadId,
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
  assert.match(contract, /`reasoning_effort`.*`turn\/start\.effort`/);
  assert.match(
    contract,
    /nonstandard direct compatibility field `tool_results`/,
  );
  assert.match(
    contract,
    /Supplies `model`, `ephemeral: false`, `experimentalRawEvents: true`, and `dynamicTools`/,
  );
  assert.match(contract, /HTTP 503 before headers/);
  assert.match(contract, /closes without `\[DONE\]`/);
  for (const unimplemented of [
    "unrepresentable_message_history",
    "continuation_history_mismatch",
    "unsupported_parameter",
  ])
    assert(!contract.includes(unimplemented), `stale error: ${unimplemented}`);
  assert.match(
    contract,
    /executes the supplied complete transcript on one `thread\/start`/,
  );
  assert.match(contract, /never trigger a second execution/);
});
