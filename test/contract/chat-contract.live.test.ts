import { registerChatContract } from "../support/chat-contract.js";
import { startLiveChatBackend } from "../support/chat-backends.js";

registerChatContract("real Codex app-server", startLiveChatBackend, {
  stage03Live: true,
});
