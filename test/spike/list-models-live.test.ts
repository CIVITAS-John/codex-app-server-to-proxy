import assert from "node:assert/strict";
import { test } from "vitest";
import type { Model } from "../../protocol/generated/typescript/v2/Model.js";
import type { ModelListResponse } from "../../protocol/generated/typescript/v2/ModelListResponse.js";
import { readModelCatalog } from "../../src/app-server/models.js";
import {
  formatModelCatalog,
  parseModelListArguments,
} from "../../scripts/list-models-live.mjs";
import { protocolModel } from "../support/protocol-fixtures.js";

/** Complete catalog entry used by the live-model script tests. */
const catalogModel = {
  ...protocolModel("gpt-5.6-luna", { id: "gpt-5.6-luna" }),
  displayName: "GPT-5.4 mini",
  description: "Small Codex model",
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Balanced" },
    { reasoningEffort: "high", description: "Deeper" },
  ],
  isDefault: true,
} satisfies Model;

test("live model catalog follows pagination and preserves advertised order", async () => {
  const requests: unknown[] = [];
  const firstPage = {
    data: [catalogModel],
    nextCursor: "next",
  } satisfies ModelListResponse;
  const secondPage = {
    data: [
      {
        ...catalogModel,
        id: "hidden-model",
        model: "hidden-model",
        hidden: true,
        isDefault: false,
      },
    ],
    nextCursor: null,
  } satisfies ModelListResponse;
  const models = await readModelCatalog(
    {
      request: async (...args) => {
        requests.push(args);
        return requests.length === 1 ? firstPage : secondPage;
      },
    },
    { includeHidden: true },
  );

  assert.deepEqual(requests, [
    [
      "model/list",
      { cursor: null, limit: 100, includeHidden: true },
      undefined,
    ],
    [
      "model/list",
      { cursor: "next", limit: 100, includeHidden: true },
      undefined,
    ],
  ]);
  assert.deepEqual(
    models.map((model: { model: string }) => model.model),
    ["gpt-5.6-luna", "hidden-model"],
  );
  assert.equal(
    formatModelCatalog(models),
    [
      "gpt-5.6-luna (default)",
      "  GPT-5.4 mini; reasoning: medium, high",
      "hidden-model (hidden)",
      "  GPT-5.4 mini; reasoning: medium, high",
    ].join("\n"),
  );
  assert.equal(models[0]?.description, "Small Codex model");
  assert.deepEqual(models[0]?.supportedReasoningEfforts, [
    { reasoningEffort: "medium", description: "Balanced" },
    { reasoningEffort: "high", description: "Deeper" },
  ]);
});

test("live model catalog defaults to visible models and forwards its abort signal", async () => {
  const controller = new AbortController();
  const signals: Array<AbortSignal | undefined> = [];
  const emptyPage = {
    data: [],
    nextCursor: null,
  } satisfies ModelListResponse;
  await readModelCatalog(
    {
      request: async (_method, _params, signal) => {
        signals.push(signal);
        return emptyPage;
      },
    },
    { signal: controller.signal },
  );
  assert.equal(signals[0], controller.signal);
  assert.equal(signals.length, 1);

  const requests: unknown[] = [];
  await readModelCatalog({
    request: async (_method, params) => {
      requests.push(params);
      return emptyPage;
    },
  });
  assert.deepEqual(requests, [
    { cursor: null, limit: 100, includeHidden: false },
  ]);
});

test("live model catalog rejects malformed pages, models, and cursor loops", async () => {
  // Deliberately malformed responses bypass generated types to test validation.
  await assert.rejects(
    readModelCatalog({
      request: async () => ({ data: "invalid", nextCursor: null }),
    }),
    /invalid page/,
  );
  await assert.rejects(
    readModelCatalog({
      request: async () => ({
        data: [{ ...catalogModel, hidden: "false" }],
        nextCursor: null,
      }),
    }),
    /invalid model/,
  );
  await assert.rejects(
    readModelCatalog({
      request: async () =>
        ({
          data: [{ ...catalogModel, model: "" }],
          nextCursor: null,
        }) satisfies ModelListResponse,
    }),
    /invalid model/,
  );
  const repeatedCursorPage = {
    data: [],
    nextCursor: "same",
  } satisfies ModelListResponse;
  await assert.rejects(
    readModelCatalog({
      request: async () => repeatedCursorPage,
    }),
    /repeated pagination cursor/,
  );
});

test("live model argument parsing is strict", () => {
  assert.deepEqual(parseModelListArguments(["--include-hidden", "--json"]), {
    includeHidden: true,
    json: true,
  });
  assert.throws(() => parseModelListArguments(["--other"]), /Unknown option/);
});
