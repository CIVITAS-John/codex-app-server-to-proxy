import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import type { ServeOptions } from "../../src/core/config.js";
import { postChatCompletion } from "../support/http.js";
import { repoRootPath } from "../support/repo-root.js";
import { withTempDir } from "../support/temp.js";
import {
  protocolNotification,
  protocolResponse,
  protocolThread,
  protocolThreadResumeResponse,
  protocolThreadStartResponse,
  protocolTurn,
} from "../support/protocol-fixtures.js";

/** Typed protocol frames serialized to the Windows-capable Node worker. */
const frames = {
  responses: {
    "thread/start": protocolResponse(
      "thread/start",
      0,
      protocolThreadStartResponse(protocolThread("thr_worker")),
    ),
    "thread/resume": protocolResponse(
      "thread/resume",
      0,
      protocolThreadResumeResponse(protocolThread("thr_worker")),
    ),
    "thread/read": protocolResponse("thread/read", 0, {
      readState: null,
      thread: protocolThread("thr_worker"),
    }),
    "thread/inject_items": protocolResponse("thread/inject_items", 0, {}),
    "turn/start": protocolResponse("turn/start", 0, {
      turn: protocolTurn("turn_worker", "inProgress"),
    }),
  },
  notifications: [
    protocolNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thr_worker",
        turnId: "turn_worker",
        itemId: "message",
        delta: "synthetic answer",
      },
    }),
    protocolNotification({
      method: "turn/completed",
      params: {
        threadId: "thr_worker",
        turn: protocolTurn("turn_worker", "completed"),
      },
    }),
    protocolNotification({
      method: "thread/status/changed",
      params: { threadId: "thr_worker", status: { type: "idle" } },
    }),
  ],
};

/** Bounds worker lifecycle waits and tears down the timer after settlement. */
async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Proxy worker lifecycle timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/** Starts an independent Node process with all defaults rooted in a temporary home. */
async function startWorker(
  root: string,
  home: string,
  marker: string,
  port = 0,
) {
  const child = fork(join(repoRootPath, "test/support/proxy-worker.mjs"), [], {
    cwd: repoRootPath,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += String(chunk);
  });
  const message = once(child, "message");
  const exit = once(child, "exit");
  child.send({ root, port, marker, frames });
  try {
    const result = await within(
      Promise.race([
        message.then(
          ([value]) =>
            value as {
              origin: string;
              port: number;
              options: ServeOptions;
              error?: string;
            },
        ),
        exit.then(() => {
          throw new Error(`Proxy worker exited: ${stderr}`);
        }),
      ]),
      5_000,
    );
    assert.equal(result.error, undefined);
    return {
      ...result,
      async close() {
        if (child.exitCode === null && child.connected)
          child.send({ stop: true });
        try {
          await within(exit, 5_000);
        } finally {
          if (child.exitCode === null) child.kill();
        }
      },
    };
  } catch (error) {
    child.kill();
    throw error;
  }
}

/** Sends a simple request and returns its durable continuation selector. */
async function complete(origin: string, previousResponseId?: string) {
  const response = await postChatCompletion(origin, {
    model: "gpt-6-luna",
    messages: [{ role: "user", content: "synthetic request" }],
    ...(previousResponseId === undefined
      ? {}
      : { previous_response_id: previousResponseId }),
  });
  const body = (await response.json()) as {
    id: string;
    x_codex: { threadReused: boolean };
  };
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

test("parallel Node proxy workers isolate default state and homes across restart", async () => {
  await withTempDir(async (directory) => {
    const root = join(directory, "root");
    const home = join(directory, "home");
    await Promise.all([mkdir(root), mkdir(home)]);
    const starts = await Promise.allSettled([
      startWorker(root, home, "first"),
      startWorker(root, home, "second"),
    ]);
    if (starts.some((start) => start.status === "rejected")) {
      await Promise.all(
        starts.map(async (start) => {
          if (start.status === "fulfilled") await start.value.close();
        }),
      );
      throw new Error("Unable to start both proxy workers.");
    }
    const workers = starts.map((start) => {
      assert.equal(start.status, "fulfilled");
      return start.value;
    });
    let first = workers[0]!;
    const second = workers[1]!;
    try {
      assert.notEqual(first.port, second.port);
      assert.notEqual(first.options.stateDir, second.options.stateDir);
      assert.notEqual(first.options.codexHome, second.options.codexHome);
      assert.equal(first.options.root, second.options.root);
      const [one, two] = await Promise.all([
        complete(first.origin),
        complete(second.origin),
      ]);
      const secondStatePath = join(
        second.options.stateDir,
        "continuations.json",
      );
      const secondState = await readFile(secondStatePath, "utf8");
      assert.equal(secondState.includes(two.id), true);
      assert.equal(secondState.includes(one.id), false);
      const original = first;
      await first.close();
      first = await startWorker(root, home, "restarted", original.port);
      assert.equal(first.options.stateDir, original.options.stateDir);
      assert.equal(first.options.codexHome, original.options.codexHome);
      assert.equal(
        (await complete(first.origin, one.id)).x_codex.threadReused,
        true,
      );
      assert.equal(await readFile(secondStatePath, "utf8"), secondState);
      assert.equal(
        await readFile(join(second.options.codexHome, "worker-marker"), "utf8"),
        "second",
      );
      assert.equal(
        (await complete(second.origin, two.id)).x_codex.threadReused,
        true,
      );
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
}, 30_000);
