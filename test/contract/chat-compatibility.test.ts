import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, test } from "vitest";
import { startFakeChatBackend } from "../support/chat-backends.js";
import type { ChatContractBackend } from "../support/chat-contract.js";
import { repoRootUrl } from "../support/repo-root.js";

/** Promise-based subprocess helper used for the literal curl compatibility path. */
const execute = promisify(execFile);

/** Synthetic compatibility cases derived from the official request contract. */
const corpus = JSON.parse(
  await readFile(
    new URL(
      "protocol/fixtures/chat-completions-compatibility.json",
      repoRootUrl,
    ),
    "utf8",
  ),
) as {
  cases: Array<{
    name: string;
    client: "curl" | "node-http";
    request: Record<string, unknown>;
    expectedObject: string;
  }>;
};

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

describe.sequential("published Chat Completions compatibility corpus", () => {
  let backend: ChatContractBackend;

  beforeAll(async () => {
    backend = await startFakeChatBackend();
  });

  afterAll(async () => {
    await backend.close();
  });

  for (const entry of corpus.cases) {
    test(entry.name, async () => {
      if (entry.client === "curl") {
        const { stdout } = await execute("curl", [
          "--fail-with-body",
          "--silent",
          "--show-error",
          `${backend.origin}/v1/chat/completions`,
          "-H",
          "Content-Type: application/json",
          "--data-binary",
          JSON.stringify(entry.request),
        ]);
        const response = JSON.parse(stdout) as { object?: string };
        assert.equal(response.object, entry.expectedObject);
        return;
      }

      const response = await postWithNodeHttp(backend.origin, entry.request);
      assert.equal(response.status, 200);
      const frames = response.body
        .split("\n\n")
        .filter(Boolean)
        .map((frame) => frame.slice("data: ".length));
      assert.equal(frames.at(-1), "[DONE]");
      const chunks = frames
        .slice(0, -1)
        .map((frame) => JSON.parse(frame) as { object?: string });
      assert.equal(chunks[0]?.object, entry.expectedObject);
    });
  }
});
