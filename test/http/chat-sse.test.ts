import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { test } from "vitest";
import { writeFrame } from "../../src/http/chat-sse.js";

/** Minimal backpressured response double with explicit lifecycle control. */
class BackpressuredResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;

  /** Reports a full write buffer without scheduling a drain event. */
  write(): boolean {
    return false;
  }
}

test("writeFrame rejects and removes listeners when the response closes", async () => {
  const response = new BackpressuredResponse();
  const pending = writeFrame(response as unknown as ServerResponse, "chunk");

  response.destroyed = true;
  response.emit("close");

  await assert.rejects(pending, /closed while sending an SSE frame/);
  assert.equal(response.listenerCount("drain"), 0);
  assert.equal(response.listenerCount("close"), 0);
});
