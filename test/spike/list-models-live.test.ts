import assert from "node:assert/strict";
import { test } from "vitest";
import {
  formatModelCatalog,
  parseModelListArguments,
  readModelCatalog,
} from "../../scripts/list-models-live.mjs";

/** Complete catalog entry used by the live-model script tests. */
const catalogModel = {
  id: "gpt-5.4-mini",
  model: "gpt-5.4-mini",
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName: "GPT-5.4 mini",
  description: "Small Codex model",
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Balanced" },
    { reasoningEffort: "high", description: "Deeper" },
  ],
  defaultReasoningEffort: "medium",
  inputModalities: ["text"],
  supportsPersonality: false,
  additionalSpeedTiers: [],
  serviceTiers: [],
  defaultServiceTier: null,
  isDefault: true,
};

test("live model catalog follows pagination and preserves advertised order", async () => {
  const requests: unknown[] = [];
  const models = await readModelCatalog(async (params: unknown) => {
    requests.push(params);
    return requests.length === 1
      ? { data: [catalogModel], nextCursor: "next" }
      : {
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
        };
  }, true);

  assert.deepEqual(requests, [
    { cursor: null, limit: 100, includeHidden: true },
    { cursor: "next", limit: 100, includeHidden: true },
  ]);
  assert.deepEqual(
    models.map((model: { model: string }) => model.model),
    ["gpt-5.4-mini", "hidden-model"],
  );
  assert.equal(
    formatModelCatalog(models),
    [
      "gpt-5.4-mini (default)",
      "  GPT-5.4 mini; reasoning: medium, high",
      "hidden-model (hidden)",
      "  GPT-5.4 mini; reasoning: medium, high",
    ].join("\n"),
  );
});

test("live model catalog rejects malformed responses and cursor loops", async () => {
  await assert.rejects(
    readModelCatalog(async () => ({ data: "invalid", nextCursor: null })),
    /invalid page/,
  );
  await assert.rejects(
    readModelCatalog(async () => ({ data: [], nextCursor: "same" })),
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
