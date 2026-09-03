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

/** Shared hard ceiling spanning both authenticated live app-server backends. */
const providerBudget = new ProviderCallBudget(MAX_LIVE_PROVIDER_CALLS);

registerChatContract(
  "real Codex app-server (agents disabled)",
  () => startLiveChatBackend(providerBudget),
  {
    scenarios: [
      "role-history-sse",
      "dynamic-tool-restart",
      "disabled-sandbox-chat",
      "filesystem-read-write",
      "live-web-search",
    ],
    maxProviderCalls: MAX_LIVE_PROVIDER_CALLS,
    // The interrupted tool-call response must return quickly with exact usage;
    // the run reports how long it and its continuation took. Numbers only.
    reportToolTimings: true,
  },
);

registerChatContract(
  "real Codex app-server (agents enabled)",
  () => startLiveSpawnChatBackend(providerBudget),
  {
    scenarios: ["spawn-child-agent"],
    maxProviderCalls: MAX_LIVE_PROVIDER_CALLS,
  },
);

afterAll(async () => {
  await providerBudget.settle();
  const calls = providerBudget.stats();
  console.info(
    `[live] provider calls parent=${calls.parent} child=${calls.child} total=${calls.total} maximum=${MAX_LIVE_PROVIDER_CALLS}`,
  );
});
