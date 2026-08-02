import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "vitest";
import type { ModelListResponse } from "../../protocol/generated/typescript/v2/ModelListResponse.js";
import { createLogger } from "../../src/core/logger.js";
import { startProxyWithTransport } from "../support/http.js";
import {
  protocolModel,
  protocolResponse,
} from "../support/protocol-fixtures.js";
import {
  createFakeTransport,
  type FakeTransport,
} from "../support/transport.js";

/** One generated app-server model-list page scripted for the fake transport. */
type ModelPage = ModelListResponse;

/** Starts a ready HTTP proxy and always closes the supplied fake transport. */
async function withModelProxy(
  fake: FakeTransport,
  run: (origin: string) => Promise<void>,
  {
    requestTimeoutMs,
    entries,
  }: {
    requestTimeoutMs?: number;
    entries?: Array<Record<string, unknown>>;
  } = {},
): Promise<void> {
  const started = await startProxyWithTransport(fake.rpc, {
    root: process.cwd(),
    stateDir: join(tmpdir(), `codex-models-http-test-${process.pid}`),
    requestTimeoutMs,
    log: entries
      ? createLogger("error", (entry) => entries.push(entry))
      : undefined,
  });
  try {
    await run(started.origin);
  } finally {
    await started.proxy.close();
  }
}

/** Creates a fake that serves catalog pages and captures every outbound RPC. */
function catalogTransport(pages: Map<string | null, ModelPage>): {
  fake: FakeTransport;
  messages: Array<Record<string, unknown>>;
} {
  const messages: Array<Record<string, unknown>> = [];
  const fake = createFakeTransport({
    onMessage(message, send) {
      messages.push(message);
      if (message.method !== "model/list") return;
      const cursor = (message.params as { cursor: string | null }).cursor;
      const page = pages.get(cursor);
      if (!page) throw new Error(`Unexpected model/list cursor ${cursor}.`);
      send(protocolResponse("model/list", message.id as number, page));
    },
  });
  return { fake, messages };
}

/** Creates a fake which intentionally returns unvalidated model-list results. */
function malformedCatalogTransport(pages: Map<string | null, unknown>): {
  fake: FakeTransport;
  messages: Array<Record<string, unknown>>;
} {
  const messages: Array<Record<string, unknown>> = [];
  const fake = createFakeTransport({
    onMessage(message, send) {
      messages.push(message);
      if (message.method !== "model/list") return;
      const cursor = (message.params as { cursor: string | null }).cursor;
      const page = pages.get(cursor);
      if (page === undefined)
        throw new Error(`Unexpected model/list cursor ${cursor}.`);
      // Deliberately bypass generated fixtures to prove upstream validation.
      send({ id: message.id as number, result: page });
    },
  });
  return { fake, messages };
}

/** Reads the standard models collection from one running proxy. */
function listModels(origin: string): Promise<Response> {
  return fetch(`${origin}/v1/models`);
}

test("GET /v1/models maps public selectors to the exact standard envelope", async () => {
  const catalog = catalogTransport(
    new Map([
      [
        null,
        {
          data: [protocolModel("gpt-5.6-luna", { id: "catalog_internal" })],
          nextCursor: null,
        },
      ],
    ]),
  );
  await withModelProxy(catalog.fake, async (origin) => {
    const response = await listModels(origin);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
    assert.deepEqual(await response.json(), {
      object: "list",
      data: [
        {
          id: "gpt-5.6-luna",
          object: "model",
          created: 0,
          owned_by: "openai",
        },
      ],
    });
    assert.deepEqual(
      catalog.messages.map((message) => message.method),
      ["model/list"],
    );
  });
});

test("GET /v1/models follows pages in order with exact model/list parameters", async () => {
  const catalog = catalogTransport(
    new Map([
      [null, { data: [protocolModel("first")], nextCursor: "cursor_second" }],
      ["cursor_second", { data: [protocolModel("second")], nextCursor: null }],
    ]),
  );
  await withModelProxy(catalog.fake, async (origin) => {
    const response = await listModels(origin);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      object: "list",
      data: [
        { id: "first", object: "model", created: 0, owned_by: "openai" },
        { id: "second", object: "model", created: 0, owned_by: "openai" },
      ],
    });
    assert.deepEqual(
      catalog.messages.map((message) => message.params),
      [
        { cursor: null, limit: 100, includeHidden: false },
        { cursor: "cursor_second", limit: 100, includeHidden: false },
      ],
    );
  });
});

test("GET /v1/models preserves an empty catalog and omits hidden entries", async () => {
  const empty = catalogTransport(
    new Map([[null, { data: [], nextCursor: null }]]),
  );
  await withModelProxy(empty.fake, async (origin) => {
    assert.deepEqual(await (await listModels(origin)).json(), {
      object: "list",
      data: [],
    });
  });

  const visible = catalogTransport(
    new Map([
      [
        null,
        {
          data: [
            protocolModel("shown"),
            protocolModel("hidden", { hidden: true }),
          ],
          nextCursor: "cursor_repeat",
        },
      ],
      // A slug repeated on a later page must not become a duplicate id.
      ["cursor_repeat", { data: [protocolModel("shown")], nextCursor: null }],
    ]),
  );
  await withModelProxy(visible.fake, async (origin) => {
    assert.deepEqual(await (await listModels(origin)).json(), {
      object: "list",
      data: [{ id: "shown", object: "model", created: 0, owned_by: "openai" }],
    });
  });
});

test("GET /v1/models serves entries carrying no presentation metadata", async () => {
  // Only the selector and visibility are required, so an entry whose remaining
  // metadata is unfamiliar must not fail the whole catalog.
  const sparse = malformedCatalogTransport(
    new Map([
      [null, { data: [{ model: "sparse", hidden: false }], nextCursor: null }],
    ]),
  );
  await withModelProxy(sparse.fake, async (origin) => {
    assert.deepEqual(await (await listModels(origin)).json(), {
      object: "list",
      data: [{ id: "sparse", object: "model", created: 0, owned_by: "openai" }],
    });
  });
});

test("invalid pages, narrow models, and repeated cursors become safe app-server errors", async () => {
  const cases: Array<{ pages: Map<string | null, unknown>; cause: string }> = [
    {
      pages: new Map([[null, { data: "not-an-array", nextCursor: null }]]),
      cause: "invalid page",
    },
    {
      pages: new Map([
        [null, { data: [{ model: "narrow" }], nextCursor: null }],
      ]),
      cause: "invalid model",
    },
    {
      pages: new Map([
        [null, { data: [], nextCursor: "again" }],
        ["again", { data: [], nextCursor: "again" }],
      ]),
      cause: "repeated cursor",
    },
  ];
  for (const { pages, cause } of cases) {
    const catalog = malformedCatalogTransport(pages);
    const entries: Array<Record<string, unknown>> = [];
    await withModelProxy(
      catalog.fake,
      async (origin) => {
        const response = await listModels(origin);
        assert.equal(response.status, 502, cause);
        const body = (await response.json()) as {
          error: { message: string; code: string };
        };
        assert.equal(body.error.code, "app_server_error");
        assert.equal(
          body.error.message,
          "The app-server could not list models.",
        );
        assert.equal(body.error.message.includes(cause), false);
      },
      { entries },
    );
    const failure = entries.find(
      (entry) => entry.event === "models_list_failed",
    );
    assert.equal(failure?.level, "error");
    assert.match(String(failure?.request_id), /^[0-9a-f-]{36}$/);
    assert.equal(typeof failure?.error, "string");
  }
});

test("RPC failures and a closed transport are safe model-list failures", async () => {
  const entries: Array<Record<string, unknown>> = [];
  const rpcError = createFakeTransport({
    onMessage(message, send) {
      if (message.method === "model/list")
        send({
          id: message.id as number,
          error: { code: -32001, message: "private upstream detail" },
        });
    },
  });
  await withModelProxy(
    rpcError,
    async (origin) => {
      const response = await listModels(origin);
      assert.equal(response.status, 502);
      const text = await response.text();
      assert.equal(text.includes("private upstream detail"), false);
    },
    { entries },
  );
  assert.equal(
    entries.some((entry) => entry.event === "models_list_failed"),
    true,
  );

  const closed = createFakeTransport({ onMessage() {} });
  closed.close(new Error("private close detail"));
  await withModelProxy(closed, async (origin) => {
    const response = await listModels(origin);
    assert.equal(response.status, 502);
    assert.equal(
      (await response.text()).includes("private close detail"),
      false,
    );
  });
});

test("a timed-out model catalog request returns 408 and cleans up for reuse", async () => {
  let requests = 0;
  const fake = createFakeTransport({
    onMessage(message, send) {
      if (message.method !== "model/list") return;
      requests += 1;
      if (requests === 2)
        send(
          protocolResponse("model/list", message.id as number, {
            data: [protocolModel("after-timeout")],
            nextCursor: null,
          } satisfies ModelListResponse),
        );
    },
  });
  await withModelProxy(
    fake,
    async (origin) => {
      const timedOut = await listModels(origin);
      assert.equal(timedOut.status, 408);
      assert.equal(
        ((await timedOut.json()) as { error: { code: string } }).error.code,
        "request_timeout",
      );
      const retried = await listModels(origin);
      assert.equal(retried.status, 200);
      assert.equal(requests, 2);
    },
    // The deadline also bounds header reads, so it must stay comfortably above
    // the retry's own connect-and-send time on a loaded machine.
    { requestTimeoutMs: 250 },
  );
});
