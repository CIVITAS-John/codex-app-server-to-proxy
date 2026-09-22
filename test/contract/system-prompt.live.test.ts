import { afterAll } from "vitest";
import { startLiveChatBackend } from "../support/chat-backends.js";
import { registerChatContract } from "../support/chat-contract.js";
import { ProviderCallBudget } from "../support/provider-call-budget.js";

/** Model selected for this explicitly authorized live contract. */
const LIVE_MODEL = "gpt-6-luna";

/** Two tool-free requests: one aggregate response and one SSE response. */
const providerBudget = new ProviderCallBudget(2);

registerChatContract(
  "real Codex system prompt",
  () => startLiveChatBackend(providerBudget, LIVE_MODEL),
  { scenarios: ["system-prompt"], maxProviderCalls: 2, model: LIVE_MODEL },
);

afterAll(async () => {
  await providerBudget.settle();
  console.info(
    `[live] system prompt provider calls total=${providerBudget.stats().total} maximum=2`,
  );
});
