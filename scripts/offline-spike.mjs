import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export class FakeAppServer {
  constructor(snapshot) {
    this.threads = new Map(snapshot ?? []);
    this.startedThreads = 0;
  }
  startThread() {
    const id = `thr_${++this.startedThreads}`;
    this.threads.set(id, { turns: [], pending: new Map() });
    return id;
  }
  streamText(threadId, text) {
    const thread = this.threads.get(threadId);
    assert(thread);
    const turnId = `turn_${thread.turns.length + 1}`;
    thread.turns.push({ id: turnId, text, status: "completed" });
    return [...text].map((delta) => ({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "message", delta } }));
  }
  requestTool(threadId, callId) {
    const thread = this.threads.get(threadId);
    assert(thread);
    thread.pending.set(callId, { tool: "lookup", arguments: { id: "T-1" } });
    return { method: "item/tool/call", id: 1, params: { threadId, turnId: "turn_2", callId, namespace: null, tool: "lookup", arguments: { id: "T-1" } } };
  }
  continueTool(threadId, callId, result) {
    const thread = this.threads.get(threadId);
    assert(thread?.pending.has(callId));
    thread.pending.delete(callId);
    thread.turns.push({ id: "turn_2", text: result, status: "completed" });
    return this.streamText(threadId, `result:${result}`);
  }
  snapshot() {
    return [...this.threads].map(([id, thread]) => [id, { ...thread, pending: new Map() }]);
  }
}

export function runOfflineSpike() {
  const first = new FakeAppServer();
  const threadId = first.startThread();
  assert.equal(first.streamText(threadId, "ok").map((event) => event.params.delta).join(""), "ok");
  const call = first.requestTool(threadId, "call_1");
  assert.equal(call.params.callId, "call_1");
  assert.equal(first.continueTool(threadId, "call_1", "found").at(-1).params.delta, "d");
  const restarted = new FakeAppServer(first.snapshot());
  assert.equal(restarted.streamText(threadId, "again").map((event) => event.params.delta).join(""), "again");
  return { modelCalls: 0, threadId, resumedAfterRestart: true, toolRoundTrip: true };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(runOfflineSpike())}\n`);
}
