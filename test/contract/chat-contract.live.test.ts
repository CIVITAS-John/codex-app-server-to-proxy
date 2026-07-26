import {
  MAX_LIVE_MODEL_CALLS,
  registerChatContract,
} from "../support/chat-contract.js";
import { startLiveChatBackend } from "../support/chat-backends.js";

registerChatContract("real Codex app-server", startLiveChatBackend, {
  scenarios: [
    "role-history-sse",
    "dynamic-tool-restart",
    "disabled-sandbox-chat",
    ...(process.platform === "win32"
      ? []
      : (["safe-policy-built-in-continuation"] as const)),
  ],
  maxModelCalls: MAX_LIVE_MODEL_CALLS,
  // The suspended tool-call response must carry usage with reasoning detail
  // within the default --usage-grace, and the run reports how long it took.
  requireSuspendedUsage: true,
});
