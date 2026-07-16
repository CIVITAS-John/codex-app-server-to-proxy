import {
  MAX_LIVE_MODEL_CALLS,
  registerChatContract,
} from "../support/chat-contract.js";
import { startLiveChatBackend } from "../support/chat-backends.js";

registerChatContract("real Codex app-server", startLiveChatBackend, {
  scenarios: [
    "role-history-sse",
    "dynamic-tool-restart",
    "safe-policy-built-in-continuation",
  ],
  maxModelCalls: MAX_LIVE_MODEL_CALLS,
});
