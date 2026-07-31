import assert from "node:assert/strict";
import http from "node:http";
import { afterAll, beforeAll, test } from "vitest";
import { startFakeChatBackend } from "../support/chat-backends.js";
import type { ChatContractBackend } from "../support/chat-contract.js";

let backend: ChatContractBackend;

beforeAll(async () => {
  backend = await startFakeChatBackend();
});

afterAll(async () => {
  await backend.close();
});

/** Sends one JSON request through Node's generic HTTP client. */
function postWithNodeHttp(
  origin: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  const target = new URL("/v1/chat/completions", origin);
  const encoded = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(encoded),
        },
      },
      (response) => {
        let result = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          result += chunk;
        });
        response.once("end", () =>
          resolve({ status: response.statusCode ?? 0, body: result }),
        );
      },
    );
    request.once("error", reject);
    request.end(encoded);
  });
}

// The proxy cannot distinguish one HTTP client from another, so only the
// behavior a non-`fetch` client exercises differently is worth pinning here:
// consuming a chunked SSE body through Node's own streaming client.
test("a non-fetch HTTP client streams SSE through to the terminal marker", async () => {
  const response = await postWithNodeHttp(backend.origin, {
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "compatibility streaming" }],
    stream: true,
  });

  assert.equal(response.status, 200);
  const frames = response.body
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => frame.slice("data: ".length));
  assert.equal(frames.at(-1), "[DONE]");
  const chunks = frames
    .slice(0, -1)
    .map((frame) => JSON.parse(frame) as { object?: string });
  assert.equal(chunks[0]?.object, "chat.completion.chunk");
});
