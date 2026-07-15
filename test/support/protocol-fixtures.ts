import type { ServerNotification } from "../../protocol/generated/typescript/ServerNotification.js";
import type { Turn } from "../../protocol/generated/typescript/v2/Turn.js";

/** Builds a complete generated-protocol turn for fake app-server notifications. */
export function protocolTurn(id: string, status: Turn["status"]): Turn {
  return {
    id,
    items: [],
    itemsView: "full",
    status,
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

/** Narrows a maintained fake notification against the generated wire union. */
export function protocolNotification(
  notification: ServerNotification,
): ServerNotification {
  return notification;
}
