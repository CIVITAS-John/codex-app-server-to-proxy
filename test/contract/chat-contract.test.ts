import { registerChatContract } from "../support/chat-contract.js";
import {
  startFakeChatBackend,
  startFakeFilesystemCorrectionChatBackend,
} from "../support/chat-backends.js";

registerChatContract("fake app-server", startFakeChatBackend);

registerChatContract(
  "fake app-server with omitted first filesystem write",
  startFakeFilesystemCorrectionChatBackend,
  { scenarios: ["filesystem-read-write"] },
);
