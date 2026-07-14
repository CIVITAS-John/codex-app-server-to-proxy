import { registerChatContract } from "./support/chat-contract.js";
import { startFakeChatBackend } from "./support/chat-backends.js";

registerChatContract("fake app-server", startFakeChatBackend);
