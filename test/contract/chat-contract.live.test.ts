import { afterAll } from "vitest";
import {
  MAX_LIVE_PROVIDER_CALLS,
  registerChatContract,
} from "../support/chat-contract.js";
import {
  startLiveChatBackend,
  startLiveSpawnChatBackend,
} from "../support/chat-backends.js";
import { ProviderCallBudget } from "../support/provider-call-budget.js";

/** Model selected for this explicitly authorized live contract. */
const LIVE_MODEL = "gpt-6-luna";

/** Shared hard ceiling spanning both authenticated live app-server backends. */
const providerBudget = new ProviderCallBudget(MAX_LIVE_PROVIDER_CALLS);

registerChatContract(
  "real Codex app-server (agents disabled)",
  () => startLiveChatBackend(providerBudget, LIVE_MODEL),
  {
    scenarios: [
      "role-history-sse",
      "dynamic-tool-restart",
      "tool-result-user-suffix",
      "disabled-sandbox-chat",
      "filesystem-read-write",
      "live-web-search",
    ],
    maxProviderCalls: MAX_LIVE_PROVIDER_CALLS,
    model: LIVE_MODEL,
    // The interrupted tool-call response must return quickly with exact usage;
    // the run reports how long it and its continuation took. Numbers only.
    reportToolTimings: true,
  },
);

registerChatContract(
  "real Codex app-server (agents enabled)",
  () => startLiveSpawnChatBackend(providerBudget, LIVE_MODEL),
  {
    scenarios: ["spawn-child-agent"],
    maxProviderCalls: MAX_LIVE_PROVIDER_CALLS,
    model: LIVE_MODEL,
  },
);

afterAll(async () => {
  await providerBudget.settle();
  const calls = providerBudget.stats();
  console.info(
    `[live] provider calls parent=${calls.parent} child=${calls.child} total=${calls.total} maximum=${MAX_LIVE_PROVIDER_CALLS}`,
  );
});
