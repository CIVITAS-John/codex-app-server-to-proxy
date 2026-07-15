import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { PassThrough } from "node:stream";
import { JsonRpcTransport } from "../../src/app-server/json-rpc.js";
import {
  bindingHash,
  ContinuationCoordinator,
  ResponseStore,
} from "../../src/continuation/state.js";
import { HttpError } from "../../src/http/errors.js";

/** Common immutable binding used by persistence tests. */
const binding = {
  model: "gpt-5.4-mini",
  cwd: "/tmp/workspace",
  toolsHash: bindingHash([{ name: "lookup" }]),
  policyHash: bindingHash({ sandbox: "read-only" }),
};

test("canonical bindings ignore object key order", () => {
  assert.equal(bindingHash({ b: 2, a: 1 }), bindingHash({ a: 1, b: 2 }));
  assert.notEqual(bindingHash([1, 2]), bindingHash([2, 1]));
});

test("atomic mappings survive reload and supersede older thread responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-state-"));
  const store = new ResponseStore(directory);
  store.put({
    responseId: "response_1",
    threadId: "thread_1",
    state: "ready",
    ...binding,
  });
  store.put({
    responseId: "response_2",
    threadId: "thread_1",
    state: "ready",
    ...binding,
  });

  const reloaded = new ResponseStore(directory);
  assert.equal(reloaded.get("response_1")?.state, "superseded");
  assert.equal(reloaded.get("response_2")?.state, "ready");
  const disk = JSON.parse(
    await readFile(join(directory, "continuations.json"), "utf8"),
  ) as {
    version: number;
    records: unknown[];
  };
  assert.equal(disk.version, 1);
  assert.equal(disk.records.length, 2);
});

test("restart converts pending-tool responder records to expired tombstones", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-state-"));
  const store = new ResponseStore(directory);
  store.put({
    responseId: "response_pending",
    threadId: "thread_1",
    state: "pending_tool",
    callIds: ["call_1"],
    ...binding,
  });
  const tombstone = new ResponseStore(directory).get("response_pending");
  assert.equal(tombstone?.state, "expired");
  assert.deepEqual(tombstone?.callIds, ["call_1"]);
});

test("legacy mappings migrate to the current schema and expire pending responders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-state-"));
  const now = Date.now();
  await writeFile(
    join(directory, "continuations.json"),
    JSON.stringify({
      version: 0,
      mappings: [
        {
          responseId: "response_legacy",
          threadId: "thread_1",
          state: "pending_tool",
          createdAt: now,
          expiresAt: now + 60_000,
          callIds: ["call_1"],
          ...binding,
        },
      ],
    }),
  );

  assert.equal(
    new ResponseStore(directory).get("response_legacy")?.state,
    "expired",
  );
  const migrated = JSON.parse(
    await readFile(join(directory, "continuations.json"), "utf8"),
  ) as { version: number; records: unknown[] };
  assert.equal(migrated.version, 1);
  assert.equal(migrated.records.length, 1);
});

test("an unknown future schema remains untouched and is never trusted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-state-"));
  const path = join(directory, "continuations.json");
  const future = JSON.stringify({
    version: 999,
    records: [{ responseId: "unsafe" }],
  });
  await writeFile(path, future);

  assert.equal(new ResponseStore(directory).get("unsafe"), undefined);
  assert.equal(await readFile(path, "utf8"), future);
});

test("a corrupt store is recovered as empty without inventing mappings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-state-"));
  await writeFile(join(directory, "continuations.json"), "not json");
  assert.equal(new ResponseStore(directory).get("missing"), undefined);
});

test("leftover atomic-write temporary files cannot replace valid records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-state-"));
  const store = new ResponseStore(directory);
  store.put({
    responseId: "response_1",
    threadId: "thread_1",
    state: "ready",
    ...binding,
  });
  await writeFile(
    join(directory, `continuations.json.${process.pid}.tmp`),
    "abruptly truncated",
  );

  assert.equal(new ResponseStore(directory).get("response_1")?.state, "ready");
});

test("a failed atomic write preserves disk and rolls back in-memory records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-state-"));
  const store = new ResponseStore(directory);
  store.put({
    responseId: "response_1",
    threadId: "thread_1",
    state: "ready",
    ...binding,
  });
  const temporary = join(directory, `continuations.json.${process.pid}.tmp`);
  await mkdir(temporary);

  assert.throws(() =>
    store.put({
      responseId: "response_2",
      threadId: "thread_1",
      state: "ready",
      ...binding,
    }),
  );
  assert.equal(store.get("response_1")?.state, "ready");
  assert.equal(store.get("response_2"), undefined);
  assert.equal(new ResponseStore(directory).get("response_1")?.state, "ready");
  await rm(temporary, { recursive: true });
});

test("pending tool_call_id values implicitly select exactly one response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-state-"));
  const rpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
  const coordinator = new ContinuationCoordinator(
    new ResponseStore(directory),
    rpc,
    60_000,
  );
  coordinator.suspend("response_1", binding, [
    {
      request: { id: 1, method: "item/tool/call", params: {} },
      callId: "call_1",
      name: "lookup",
      arguments: { id: 1 },
      threadId: "thread_1",
      turnId: "turn_1",
    },
  ]);
  assert.equal(coordinator.findPendingResponse(["call_1"]), "response_1");
  assert.throws(
    () => coordinator.findPendingResponse(["foreign"]),
    (error: unknown) =>
      error instanceof HttpError && error.code === "unknown_tool_call_id",
  );
  assert.throws(
    () => coordinator.findPendingResponse(["call_1", "call_1"]),
    (error: unknown) =>
      error instanceof HttpError && error.code === "duplicate_tool_call_id",
  );
  rpc.close();
});

test("implicit tool continuation preserves an expired restart tombstone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-state-"));
  const firstRpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
  const first = new ContinuationCoordinator(
    new ResponseStore(directory),
    firstRpc,
    60_000,
  );
  first.suspend("response_1", binding, [
    {
      request: { id: 1, method: "item/tool/call", params: {} },
      callId: "call_1",
      name: "lookup",
      arguments: {},
      threadId: "thread_1",
      turnId: "turn_1",
    },
  ]);
  firstRpc.close();
  const secondRpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
  const restarted = new ContinuationCoordinator(
    new ResponseStore(directory),
    secondRpc,
    60_000,
  );

  assert.throws(
    () => restarted.findPendingResponse(["call_1"]),
    (error: unknown) =>
      error instanceof HttpError &&
      error.status === 410 &&
      error.code === "expired_tool_continuation",
  );
  secondRpc.close();
});

test("implicit tool continuation rejects ambiguous expired tombstones", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-state-"));
  const store = new ResponseStore(directory);
  for (const [responseId, threadId] of [
    ["response_1", "thread_1"],
    ["response_2", "thread_2"],
  ] as const)
    store.put({
      responseId,
      threadId,
      state: "expired",
      ...binding,
      callIds: ["call_shared"],
    });
  const rpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
  const coordinator = new ContinuationCoordinator(store, rpc, 60_000);

  assert.throws(
    () => coordinator.findPendingResponse(["call_shared"]),
    (error: unknown) =>
      error instanceof HttpError &&
      error.status === 409 &&
      error.code === "ambiguous_tool_call_id",
  );
  rpc.close();
});

test("dynamic tool callbacks accept omitted namespace but reject non-null values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-state-"));
  const output = new PassThrough();
  const written: Buffer[] = [];
  output.on("data", (chunk: Buffer) => written.push(chunk));
  const rpc = new JsonRpcTransport(new PassThrough(), output);
  const coordinator = new ContinuationCoordinator(
    new ResponseStore(directory),
    rpc,
    60_000,
  );
  const calls: string[] = [];
  coordinator.setToolOwner("thread_1", (call) => calls.push(call.callId));
  const base = {
    threadId: "thread_1",
    turnId: "turn_1",
    tool: "lookup",
    arguments: {},
  };

  rpc.emit("request", {
    id: 1,
    method: "item/tool/call",
    params: { ...base, callId: "call_1" },
  });
  rpc.emit("request", {
    id: 2,
    method: "item/tool/call",
    params: { ...base, callId: "call_2", namespace: "unsafe" },
  });

  assert.deepEqual(calls, ["call_1"]);
  assert.deepEqual(JSON.parse(Buffer.concat(written).toString("utf8")), {
    id: 2,
    error: { code: -32602, message: "Invalid dynamic tool request" },
  });
  rpc.close();
});

test("resolving a suspension is consumed and cannot replay tool results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-state-"));
  const output = new PassThrough();
  const rpc = new JsonRpcTransport(new PassThrough(), output);
  const coordinator = new ContinuationCoordinator(
    new ResponseStore(directory),
    rpc,
    60_000,
  );
  coordinator.suspend("response_1", binding, [
    {
      request: { id: 1, method: "item/tool/call", params: {} },
      callId: "call_1",
      name: "lookup",
      arguments: {},
      threadId: "thread_1",
      turnId: "turn_1",
    },
  ]);

  assert.equal(
    coordinator.resolve("response_1", new Map([["call_1", "done"]]))?.length,
    1,
  );
  assert.equal(
    coordinator.resolve("response_1", new Map([["call_1", "replay"]])),
    undefined,
  );
  assert.equal(coordinator.store.get("response_1")?.state, "superseded");
  rpc.close();
});

test("a response failure expires and consumes the entire suspended batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-state-"));
  const rpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
  const store = new ResponseStore(directory);
  const coordinator = new ContinuationCoordinator(store, rpc, 60_000);
  const calls = ["call_1", "call_2"].map((callId, index) => ({
    request: { id: index + 1, method: "item/tool/call", params: {} },
    callId,
    name: "lookup",
    arguments: {},
    threadId: "thread_1",
    turnId: "turn_1",
  }));
  coordinator.suspend("response_1", binding, calls);
  const originalRespond = rpc.respond.bind(rpc);
  let responses = 0;
  rpc.respond = (id, result): void => {
    responses += 1;
    if (responses === 2) throw new Error("transport write failed");
    originalRespond(id, result);
  };

  assert.throws(
    () =>
      coordinator.resolve(
        "response_1",
        new Map([
          ["call_1", "one"],
          ["call_2", "two"],
        ]),
      ),
    /transport write failed/,
  );
  assert.equal(coordinator.pending("response_1"), undefined);
  assert.equal(store.get("response_1")?.state, "expired");
  assert.equal(coordinator.resolve("response_1", new Map()), undefined);
  assert.equal(responses, 2);
  assert.equal(coordinator.claim("thread_1"), true);
  rpc.close();
});

test("dynamic tool callbacks route to exactly one thread owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-state-"));
  const rpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
  const coordinator = new ContinuationCoordinator(
    new ResponseStore(directory),
    rpc,
    60_000,
  );
  const first: string[] = [];
  const second: string[] = [];
  coordinator.setToolOwner("thread_1", (call) => first.push(call.callId));
  coordinator.setToolOwner("thread_2", (call) => second.push(call.callId));

  rpc.emit("request", {
    id: 1,
    method: "item/tool/call",
    params: {
      threadId: "thread_2",
      turnId: "turn_2",
      callId: "call_2",
      namespace: null,
      tool: "lookup",
      arguments: { id: 2 },
    },
  });

  assert.deepEqual(first, []);
  assert.deepEqual(second, ["call_2"]);
  coordinator.dispose();
  rpc.close();
});

test("disposing a coordinator cancels pending responders and expires their mapping", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-state-"));
  const output = new PassThrough();
  const written: Buffer[] = [];
  output.on("data", (chunk: Buffer) => written.push(chunk));
  const rpc = new JsonRpcTransport(new PassThrough(), output);
  const store = new ResponseStore(directory);
  const coordinator = new ContinuationCoordinator(store, rpc, 1);
  coordinator.suspend("response_1", binding, [
    {
      request: { id: 1, method: "item/tool/call", params: {} },
      callId: "call_1",
      name: "lookup",
      arguments: {},
      threadId: "thread_1",
      turnId: "turn_1",
    },
  ]);

  coordinator.dispose();
  rpc.close();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(store.get("response_1")?.state, "expired");
  assert.equal(coordinator.pending("response_1"), undefined);
  assert.deepEqual(JSON.parse(Buffer.concat(written).toString("utf8")), {
    id: 1,
    error: {
      code: -32000,
      message: "App-server transport is being replaced",
    },
  });
});

test("a disposed coordinator cannot persist a stale completed response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-state-"));
  const rpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
  const store = new ResponseStore(directory);
  const coordinator = new ContinuationCoordinator(store, rpc, 60_000);

  coordinator.dispose();

  assert.equal(
    coordinator.recordReady("response_stale", "thread_1", binding),
    false,
  );
  assert.equal(store.get("response_stale"), undefined);
  rpc.close();
});

test("a disposed coordinator rejects tool callbacks until transport close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-state-"));
  const output = new PassThrough();
  const written: Buffer[] = [];
  output.on("data", (chunk: Buffer) => written.push(chunk));
  const rpc = new JsonRpcTransport(new PassThrough(), output);
  const coordinator = new ContinuationCoordinator(
    new ResponseStore(directory),
    rpc,
    60_000,
  );
  coordinator.dispose();

  rpc.emit("request", {
    id: 9,
    method: "item/tool/call",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      callId: "call_1",
      namespace: null,
      tool: "lookup",
      arguments: {},
    },
  });

  assert.deepEqual(JSON.parse(Buffer.concat(written).toString("utf8")), {
    id: 9,
    error: {
      code: -32000,
      message: "App-server transport is being replaced",
    },
  });
  rpc.close();
});
