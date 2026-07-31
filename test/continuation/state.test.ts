import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test, vi } from "vitest";
import { PassThrough } from "node:stream";
import { JsonRpcTransport } from "../../src/app-server/json-rpc.js";
import {
  ContinuationCoordinator,
  ResponseStore,
} from "../../src/continuation/state.js";
import { bindingHash } from "../../src/core/canonical.js";
import { HttpError } from "../../src/http/errors.js";
import { withTempDir } from "../support/temp.js";

/** Common immutable binding used by persistence tests. */
const binding = {
  model: "gpt-5.6-luna",
  reasoningEffort: "high",
  cwd: "/tmp/workspace",
  toolsHash: bindingHash([{ name: "lookup" }]),
  policyHash: bindingHash({ sandbox: "read-only" }),
};

test("canonical bindings ignore object key order", () => {
  assert.equal(bindingHash({ b: 2, a: 1 }), bindingHash({ a: 1, b: 2 }));
  assert.notEqual(bindingHash([1, 2]), bindingHash([2, 1]));
});

test("atomic mappings survive reload and supersede older thread responses", async () => {
  await withTempDir(async (directory) => {
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
      usageTotal: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningOutputTokens: 1,
        totalTokens: 15,
      },
      ...binding,
    });

    const reloaded = new ResponseStore(directory);
    assert.equal(reloaded.get("response_1")?.state, "superseded");
    assert.equal(reloaded.get("response_2")?.state, "ready");
    assert.equal(reloaded.get("response_2")?.reasoningEffortBound, true);
    assert.equal(reloaded.get("response_2")?.usageTotal?.totalTokens, 15);
    const disk = JSON.parse(
      await readFile(join(directory, "continuations.json"), "utf8"),
    ) as {
      version: number;
      records: unknown[];
    };
    assert.equal(disk.version, 0);
    assert.equal(disk.records.length, 2);
  }, "codex-proxy-state-");
});

test("restart tombstones only pending records that lack call metadata", async () => {
  await withTempDir(async (directory) => {
    const store = new ResponseStore(directory);
    store.put({
      responseId: "response_legacy",
      threadId: "thread_1",
      state: "pending_tool",
      callIds: ["call_1"],
      ...binding,
    });
    store.put({
      responseId: "response_durable",
      threadId: "thread_2",
      state: "pending_tool",
      callIds: ["call_2"],
      pendingCalls: [{ callId: "call_2", name: "lookup", arguments: "{}" }],
      ...binding,
    });
    const reloaded = new ResponseStore(directory);
    const tombstone = reloaded.get("response_legacy");
    assert.equal(tombstone?.state, "expired");
    assert.deepEqual(tombstone?.callIds, ["call_1"]);
    // A record carrying its call metadata is fully durable and stays pending.
    assert.equal(reloaded.get("response_durable")?.state, "pending_tool");
  }, "codex-proxy-state-");
});

test("a nonzero schema remains untouched and is never trusted", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "continuations.json");
    const future = JSON.stringify({
      version: 1,
      records: [{ responseId: "unsafe" }],
    });
    await writeFile(path, future);

    assert.equal(new ResponseStore(directory).get("unsafe"), undefined);
    assert.equal(await readFile(path, "utf8"), future);
  }, "codex-proxy-state-");
});

test("a corrupt store is recovered as empty without inventing mappings", async () => {
  await withTempDir(async (directory) => {
    await writeFile(join(directory, "continuations.json"), "not json");
    assert.equal(new ResponseStore(directory).get("missing"), undefined);
  }, "codex-proxy-state-");
});

test("state loading rejects records that cannot drive continuation", async () => {
  const valid = {
    responseId: "response_valid",
    threadId: "thread_valid",
    state: "ready",
    ...binding,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  // This process is the file's only writer, so loading checks the fields
  // continuation reads rather than re-validating the writer. `usageTotal` and
  // `pendingCalls` are validated because they feed token arithmetic and
  // injected thread history.
  const invalidRecords = [
    { ...valid, responseId: "" },
    { ...valid, threadId: 5 },
    { ...valid, state: "half_written" },
    { ...valid, expiresAt: "soon" },
    {
      ...valid,
      usageTotal: {
        inputTokens: -1,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
    },
    {
      ...valid,
      usageTotal: {
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
      },
    },
    {
      ...valid,
      callIds: ["call_1"],
      pendingCalls: [{ callId: "call_1", name: "lookup" }],
    },
    { ...valid, pendingCalls: [{ callId: "", name: "l", arguments: "{}" }] },
  ];
  for (const [index, invalid] of invalidRecords.entries()) {
    await withTempDir(async (directory) => {
      await writeFile(
        join(directory, "continuations.json"),
        JSON.stringify({ version: 0, records: [invalid] }),
      );
      assert.equal(
        new ResponseStore(directory).get(String(invalid.responseId)),
        undefined,
      );
    }, `codex-proxy-invalid-record-${index}-`);
  }
});

test("state loading preserves a record carrying unknown future fields", async () => {
  await withTempDir(async (directory) => {
    await writeFile(
      join(directory, "continuations.json"),
      JSON.stringify({
        version: 0,
        records: [
          {
            responseId: "response_future",
            threadId: "thread_future",
            state: "ready",
            ...binding,
            createdAt: Date.now(),
            expiresAt: Date.now() + 60_000,
            unknownFutureField: true,
          },
        ],
      }),
    );
    assert.equal(
      new ResponseStore(directory).get("response_future")?.state,
      "ready",
    );
  }, "codex-proxy-future-record-");
});

test("leftover atomic-write temporary files cannot replace valid records", async () => {
  await withTempDir(async (directory) => {
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

    assert.equal(
      new ResponseStore(directory).get("response_1")?.state,
      "ready",
    );
  }, "codex-proxy-state-");
});

test("a temporary stranded by an interrupted write is overwritten, not trusted", async () => {
  await withTempDir(async (directory) => {
    await writeFile(
      join(directory, "continuations.json.tmp"),
      "abruptly truncated",
    );

    const store = new ResponseStore(directory);
    store.put({
      responseId: "response_1",
      threadId: "thread_1",
      state: "ready",
      ...binding,
    });

    assert.equal(
      new ResponseStore(directory).get("response_1")?.state,
      "ready",
    );
  }, "codex-proxy-state-");
});

test("a failed atomic write leaves the last durable state on disk", async () => {
  await withTempDir(async (directory) => {
    const temporary = join(directory, "continuations.json.tmp");
    const store = new ResponseStore(directory);
    store.put({
      responseId: "response_1",
      threadId: "thread_1",
      state: "ready",
      ...binding,
    });
    // A directory at the temporary path makes the next atomic write fail.
    await mkdir(temporary);

    assert.throws(() =>
      store.put({
        responseId: "response_2",
        threadId: "thread_1",
        state: "ready",
        ...binding,
      }),
    );
    await rm(temporary, { recursive: true });
    // Memory may lead disk after a failed write; the durable record is what a
    // restart resumes from, and it never observed the failed mutation.
    const reloaded = new ResponseStore(directory);
    assert.equal(reloaded.get("response_1")?.state, "ready");
    assert.equal(reloaded.get("response_2"), undefined);
  }, "codex-proxy-state-");
});

test("pre-existing state paths are tightened on POSIX platforms", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "continuations.json");
    await writeFile(path, "not json", { mode: 0o666 });
    if (process.platform !== "win32") {
      await chmod(directory, 0o777);
      await chmod(path, 0o666);
    }

    new ResponseStore(directory);

    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  }, "codex-proxy-state-mode-");
});

test.skipIf(process.platform === "win32")(
  "state paths reject symlinks",
  async () => {
    await withTempDir(async (parent) => {
      const target = join(parent, "target");
      const linkedDirectory = join(parent, "linked");
      await mkdir(target);
      await symlink(target, linkedDirectory, "dir");
      assert.throws(
        () => new ResponseStore(linkedDirectory),
        /regular directory/,
      );

      const fileDirectory = join(parent, "file-state");
      await mkdir(fileDirectory);
      const targetFile = join(parent, "target.json");
      await writeFile(targetFile, "{}");
      await symlink(
        targetFile,
        join(fileDirectory, "continuations.json"),
        "file",
      );
      assert.throws(() => new ResponseStore(fileDirectory), /regular file/);
    }, "codex-proxy-state-path-");
  },
);

test("state directories must be directories", async () => {
  await withTempDir(async (parent) => {
    const notDirectory = join(parent, "not-directory");
    await writeFile(notDirectory, "x");
    assert.throws(() => new ResponseStore(notDirectory));
  }, "codex-proxy-state-path-");
});

/** Durable metadata for the single scripted pending call used below. */
const storedCall = {
  callId: "call_1",
  name: "lookup",
  arguments: '{"id":1}',
};

test("pending tool_call_id values implicitly select exactly one response", async () => {
  await withTempDir(async (directory) => {
    const rpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
    const coordinator = new ContinuationCoordinator(
      new ResponseStore(directory),
      rpc,
    );
    coordinator.recordPendingTool("response_1", "thread_1", binding, [
      storedCall,
    ]);
    coordinator.recordPendingUsage("response_1", {
      inputTokens: 4,
      cachedInputTokens: 0,
      outputTokens: 2,
      reasoningOutputTokens: 0,
      totalTokens: 6,
    });
    assert.equal(
      coordinator.store.get("response_1")?.usageTotal?.totalTokens,
      6,
    );
    // Best-effort persistence: an unknown or no-longer-pending mapping is a
    // silent no-op rather than a failure that would retract the pending record.
    coordinator.recordPendingUsage("response_absent", {
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
      totalTokens: 2,
    });
    assert.equal(coordinator.store.get("response_absent"), undefined);
    // An all-zero boundary is meaningful, not absent: a fresh thread that
    // parks before any attribution must still persist where it started.
    coordinator.recordPendingUsage("response_1", {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    });
    assert.deepEqual(coordinator.store.get("response_1")?.usageTotal, {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    });
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
  }, "codex-proxy-state-");
});

test("a pending record whose retention has lapsed is a tombstone, not a match", async () => {
  await withTempDir(async (directory) => {
    const rpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
    // Zero retention makes every record born expired, which pins the explicit
    // expiresAt check in findPendingResponse: findByCallIds itself never
    // applies expiry.
    const coordinator = new ContinuationCoordinator(
      new ResponseStore(directory, 0),
      rpc,
    );
    coordinator.recordPendingTool("response_1", "thread_1", binding, [
      storedCall,
    ]);

    assert.throws(
      () => coordinator.findPendingResponse(["call_1"]),
      (error: unknown) =>
        error instanceof HttpError &&
        error.status === 410 &&
        error.code === "expired_tool_continuation",
    );
    rpc.close();
  }, "codex-proxy-state-");
});

test("pending consumption is protected before injection and then superseded", async () => {
  await withTempDir(async (directory) => {
    const rpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
    const store = new ResponseStore(directory);
    const coordinator = new ContinuationCoordinator(store, rpc);
    coordinator.recordPendingTool("response_1", "thread_1", binding, [
      storedCall,
    ]);

    coordinator.protectPendingFromReplay("response_1");

    assert.equal(store.get("response_1")?.state, "expired");
    // The durable pre-injection tombstone makes every retry fail closed.
    assert.throws(
      () => coordinator.findPendingResponse(["call_1"]),
      (error: unknown) =>
        error instanceof HttpError &&
        error.status === 410 &&
        error.code === "expired_tool_continuation",
    );
    coordinator.recordPendingConsumed("response_1");
    assert.equal(store.get("response_1")?.state, "superseded");
    rpc.close();
  }, "codex-proxy-state-");
});

test("replay protection must persist before injection can proceed", async () => {
  await withTempDir(async (directory) => {
    const rpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
    const store = new ResponseStore(directory);
    const coordinator = new ContinuationCoordinator(store, rpc);
    coordinator.recordPendingTool("response_1", "thread_1", binding, [
      storedCall,
    ]);
    const update = vi.spyOn(store, "update").mockImplementation(() => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });

    assert.throws(
      () => coordinator.protectPendingFromReplay("response_1"),
      /disk full/,
    );

    assert.equal(update.mock.calls.length, 1);
    assert.equal(store.get("response_1")?.state, "pending_tool");
    rpc.close();
  }, "codex-proxy-state-");
});

test("pending usage and consumed bookkeeping are best-effort after durable work", async () => {
  await withTempDir(async (directory) => {
    const rpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
    const store = new ResponseStore(directory);
    const coordinator = new ContinuationCoordinator(store, rpc);
    coordinator.recordPendingTool("response_1", "thread_1", binding, [
      storedCall,
    ]);
    const update = vi.spyOn(store, "update").mockImplementation(() => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });

    assert.doesNotThrow(() =>
      coordinator.recordPendingUsage("response_1", {
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
        totalTokens: 2,
      }),
    );
    assert.equal(store.get("response_1")?.usageTotal, undefined);

    update.mockRestore();
    coordinator.protectPendingFromReplay("response_1");
    const consumedUpdate = vi.spyOn(store, "update").mockImplementation(() => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    assert.doesNotThrow(() => coordinator.recordPendingConsumed("response_1"));
    assert.equal(store.get("response_1")?.state, "expired");
    consumedUpdate.mockRestore();
    rpc.close();
  }, "codex-proxy-state-");
});

test("recording a pending batch rejects duplicate call IDs", async () => {
  await withTempDir(async (directory) => {
    const rpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
    const store = new ResponseStore(directory);
    const coordinator = new ContinuationCoordinator(store, rpc);

    assert.throws(
      () =>
        coordinator.recordPendingTool("response_1", "thread_1", binding, [
          storedCall,
          { ...storedCall, name: "other" },
        ]),
      /must be nonempty and unique/,
    );
    assert.equal(store.get("response_1"), undefined);
    rpc.close();
  }, "codex-proxy-state-");
});

test("a completed continuation's ready record supersedes its thread's pending record", async () => {
  await withTempDir(async (directory) => {
    const rpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
    const store = new ResponseStore(directory);
    const coordinator = new ContinuationCoordinator(store, rpc);
    coordinator.recordPendingTool("response_1", "thread_1", binding, [
      storedCall,
    ]);

    // Defense in depth behind the pre-injection guard: a continuation that
    // completes must never leave a replayable pending record.
    assert.equal(
      coordinator.recordReady("response_2", "thread_1", binding),
      true,
    );

    assert.equal(store.get("response_1")?.state, "superseded");
    assert.equal(store.get("response_2")?.state, "ready");
    rpc.close();
  }, "codex-proxy-state-");
});

test("pending records with call metadata survive restart for implicit selection", async () => {
  await withTempDir(async (directory) => {
    const firstRpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
    const first = new ContinuationCoordinator(
      new ResponseStore(directory),
      firstRpc,
    );
    first.recordPendingTool("response_1", "thread_1", binding, [storedCall]);
    firstRpc.close();
    const secondRpc = new JsonRpcTransport(
      new PassThrough(),
      new PassThrough(),
    );
    const restarted = new ContinuationCoordinator(
      new ResponseStore(directory),
      secondRpc,
    );

    // Nothing about the pending batch is process-local, so a restart changes
    // nothing about selection.
    assert.equal(restarted.findPendingResponse(["call_1"]), "response_1");
    assert.deepEqual(restarted.store.get("response_1")?.pendingCalls, [
      storedCall,
    ]);
    secondRpc.close();
  }, "codex-proxy-state-");
});

test("legacy pending records without call metadata expire on load", async () => {
  await withTempDir(async (directory) => {
    const store = new ResponseStore(directory);
    // Written the way pre-metadata releases wrote suspensions: call IDs only.
    store.put({
      responseId: "response_legacy",
      threadId: "thread_1",
      state: "pending_tool",
      callIds: ["call_1"],
      ...binding,
    });
    const rpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
    const restarted = new ContinuationCoordinator(
      new ResponseStore(directory),
      rpc,
    );

    assert.equal(restarted.store.get("response_legacy")?.state, "expired");
    assert.throws(
      () => restarted.findPendingResponse(["call_1"]),
      (error: unknown) =>
        error instanceof HttpError &&
        error.status === 410 &&
        error.code === "expired_tool_continuation",
    );
    rpc.close();
  }, "codex-proxy-state-");
});

test("implicit tool continuation rejects ambiguous expired tombstones", async () => {
  await withTempDir(async (directory) => {
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
    const coordinator = new ContinuationCoordinator(store, rpc);

    assert.throws(
      () => coordinator.findPendingResponse(["call_shared"]),
      (error: unknown) =>
        error instanceof HttpError &&
        error.status === 409 &&
        error.code === "ambiguous_tool_call_id",
    );
    rpc.close();
  }, "codex-proxy-state-");
});

test("dynamic tool callbacks accept omitted namespace but reject non-null values", async () => {
  await withTempDir(async (directory) => {
    const output = new PassThrough();
    const written: Buffer[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk));
    const rpc = new JsonRpcTransport(new PassThrough(), output);
    const coordinator = new ContinuationCoordinator(
      new ResponseStore(directory),
      rpc,
    );
    const calls: string[] = [];
    const lease = coordinator.acquireThread("thread_1", (call) =>
      calls.push(call.callId),
    );
    assert.ok(lease);
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
    lease.release();
    rpc.close();
  }, "codex-proxy-state-");
});

test("dynamic tool callbacks route to exactly one thread owner", async () => {
  await withTempDir(async (directory) => {
    const rpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
    const coordinator = new ContinuationCoordinator(
      new ResponseStore(directory),
      rpc,
    );
    const first: string[] = [];
    const second: string[] = [];
    const firstLease = coordinator.acquireThread("thread_1", (call) =>
      first.push(call.callId),
    );
    const secondLease = coordinator.acquireThread("thread_2", (call) =>
      second.push(call.callId),
    );
    assert.ok(firstLease);
    assert.ok(secondLease);

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
    firstLease.release();
    secondLease.release();
    coordinator.dispose();
    rpc.close();
  }, "codex-proxy-state-");
});

test("late callbacks from an interrupted turn stay unanswered during its continuation", async () => {
  await withTempDir(async (directory) => {
    const output = new PassThrough();
    const written: Buffer[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk));
    const rpc = new JsonRpcTransport(new PassThrough(), output);
    const coordinator = new ContinuationCoordinator(
      new ResponseStore(directory),
      rpc,
    );
    const calls: string[] = [];
    const lease = coordinator.acquireThread("thread_1", (call) =>
      calls.push(call.callId),
    );
    assert.ok(lease);
    coordinator.markTurnInterrupted("thread_1", "turn_old");

    for (const [id, turnId, callId] of [
      [1, "turn_old", "call_stale"],
      [2, "turn_current", "call_current"],
    ] as const)
      rpc.emit("request", {
        id,
        method: "item/tool/call",
        params: {
          threadId: "thread_1",
          turnId,
          callId,
          namespace: null,
          tool: "lookup",
          arguments: {},
        },
      });

    assert.deepEqual(calls, ["call_current"]);
    assert.equal(Buffer.concat(written).toString("utf8"), "");
    lease.release();
    coordinator.dispose();
    rpc.close();
  }, "codex-proxy-state-");
});

test("every interrupted turn stays suppressed for the transport generation", async () => {
  await withTempDir(async (directory) => {
    const output = new PassThrough();
    const written: Buffer[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk));
    const rpc = new JsonRpcTransport(new PassThrough(), output);
    const coordinator = new ContinuationCoordinator(
      new ResponseStore(directory),
      rpc,
    );
    const calls: string[] = [];
    const lease = coordinator.acquireThread("thread_1", (call) =>
      calls.push(call.callId),
    );
    assert.ok(lease);
    for (let turn = 0; turn < 5_000; turn += 1)
      coordinator.markTurnInterrupted("thread_1", `turn_${turn}`);

    for (const [id, turnId, callId] of [
      [1, "turn_0", "call_oldest"],
      [2, "turn_4999", "call_newest"],
    ] as const)
      rpc.emit("request", {
        id,
        method: "item/tool/call",
        params: {
          threadId: "thread_1",
          turnId,
          callId,
          namespace: null,
          tool: "lookup",
          arguments: {},
        },
      });

    // The set is unbounded within one transport generation, so no late
    // callback from an interrupted turn is ever answered or routed.
    assert.deepEqual(calls, []);
    assert.equal(Buffer.concat(written).toString("utf8"), "");
    lease.release();
    coordinator.dispose();
    rpc.close();
  }, "codex-proxy-state-");
});

test("an ownerless dynamic tool call answers only without a pending batch", async () => {
  await withTempDir(async (directory) => {
    const output = new PassThrough();
    const written: Buffer[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk));
    const rpc = new JsonRpcTransport(new PassThrough(), output);
    const coordinator = new ContinuationCoordinator(
      new ResponseStore(directory),
      rpc,
    );
    coordinator.recordPendingTool("response_1", "thread_1", binding, [
      { callId: "call_1", name: "lookup", arguments: "{}" },
    ]);
    const base = { turnId: "turn_1", tool: "lookup", arguments: {} };

    // The batch's turn was interrupted and its lease released, so a late
    // app-server dispatch finds no owner but a durable pending record.
    rpc.emit("request", {
      id: 1,
      method: "item/tool/call",
      params: { ...base, threadId: "thread_1", callId: "call_2" },
    });
    // A thread with no pending batch remains a genuine correlation failure.
    rpc.emit("request", {
      id: 2,
      method: "item/tool/call",
      params: { ...base, threadId: "thread_other", callId: "call_3" },
    });

    const frames = Buffer.concat(written)
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((frame) => JSON.parse(frame) as Record<string, unknown>);
    // The pending thread's late call is left unanswered; only the genuine
    // correlation failure gets a response app-server is still waiting for.
    assert.deepEqual(frames, [
      {
        id: 2,
        error: { code: -32602, message: "Dynamic tool correlation mismatch" },
      },
    ]);
    coordinator.dispose();
    rpc.close();
  }, "codex-proxy-state-");
});

test("thread ownership is acquired and released by one atomic lease", async () => {
  await withTempDir(async (directory) => {
    const rpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
    const coordinator = new ContinuationCoordinator(
      new ResponseStore(directory),
      rpc,
    );
    const first = coordinator.acquireThread("thread_1", () => undefined);
    assert.ok(first);
    assert.equal(
      coordinator.acquireThread("thread_1", () => undefined),
      undefined,
    );

    first.release();
    first.release();
    const replacement = coordinator.acquireThread("thread_1", () => undefined);
    assert.ok(replacement);
    replacement.release();
    rpc.close();
  }, "codex-proxy-state-");
});

test("disposal leaves durable pending records untouched", async () => {
  await withTempDir(async (directory) => {
    const rpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
    const store = new ResponseStore(directory);
    const coordinator = new ContinuationCoordinator(store, rpc);
    coordinator.recordPendingTool("response_1", "thread_1", binding, [
      storedCall,
    ]);

    coordinator.dispose();

    // The pending batch has no process-local responder to cancel; the record
    // stays continuable by the next transport generation.
    assert.equal(store.get("response_1")?.state, "pending_tool");
    assert.throws(() => coordinator.acquireThread("thread_1", () => undefined));
    rpc.close();
  }, "codex-proxy-state-");
});

test("a disposed coordinator cannot persist a stale completed response", async () => {
  await withTempDir(async (directory) => {
    const rpc = new JsonRpcTransport(new PassThrough(), new PassThrough());
    const store = new ResponseStore(directory);
    const coordinator = new ContinuationCoordinator(store, rpc);

    coordinator.dispose();

    assert.equal(
      coordinator.recordReady("response_stale", "thread_1", binding),
      false,
    );
    assert.throws(() =>
      coordinator.recordPendingTool("response_stale", "thread_1", binding, [
        storedCall,
      ]),
    );
    assert.equal(store.get("response_stale"), undefined);
    rpc.close();
  }, "codex-proxy-state-");
});

test("a disposed coordinator rejects tool callbacks until transport close", async () => {
  await withTempDir(async (directory) => {
    const output = new PassThrough();
    const written: Buffer[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk));
    const rpc = new JsonRpcTransport(new PassThrough(), output);
    const coordinator = new ContinuationCoordinator(
      new ResponseStore(directory),
      rpc,
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
  }, "codex-proxy-state-");
});
