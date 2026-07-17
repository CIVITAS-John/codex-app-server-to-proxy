import type { ServerResponse } from "node:http";
import type { NormalizedDelta } from "./chat-normalize.js";
import { errorEnvelope } from "./errors.js";

/** Creates a conventional single-choice streaming chunk. */
export function chunk(
  id: string,
  created: number,
  model: string,
  delta: NormalizedDelta | { role: "assistant" },
  finishReason: string | null,
): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** Writes one JSON SSE data frame while respecting HTTP backpressure. */
export async function writeSse(
  response: ServerResponse,
  value: unknown,
): Promise<void> {
  await writeFrame(response, JSON.stringify(value));
}

/** Writes the single terminal OpenAI-shaped error allowed on an SSE stream. */
export async function writeSseError(
  response: ServerResponse,
  message: string,
): Promise<void> {
  await writeSse(
    response,
    errorEnvelope(message, "server_error", "app_server_error", null),
  );
}

/** Writes one SSE data frame and waits for drain when required. */
export async function writeFrame(
  response: ServerResponse,
  data: string,
): Promise<void> {
  if (response.destroyed || response.writableEnded)
    throw new Error("The HTTP response closed before the SSE frame was sent.");
  if (!response.write(serializeSseFrame(data))) {
    // close may have fired synchronously during write, before listeners attach.
    if (response.destroyed || response.writableEnded)
      throw new Error("The HTTP response closed while sending an SSE frame.");
    await new Promise<void>((resolve) => {
      const cleanup = (): void => {
        response.off("drain", onDrain);
        response.off("close", onClose);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onClose = (): void => {
        cleanup();
        resolve();
      };
      response.once("drain", onDrain);
      response.once("close", onClose);
    });
    if (response.destroyed && !response.writableFinished)
      throw new Error("The HTTP response closed while sending an SSE frame.");
  }
}

/** Serializes one SSE data frame without performing I/O. */
export function serializeSseFrame(data: string): string {
  return `data: ${data}\n\n`;
}
