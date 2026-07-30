import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { JsonRpcTransport } from "../../src/app-server/json-rpc.js";
import type { JsonValue } from "../../protocol/generated/typescript/serde_json/JsonValue.js";
import type { ThreadTokenUsage } from "../../protocol/generated/typescript/v2/ThreadTokenUsage.js";
import {
  protocolNotification,
  protocolServerRequest,
  protocolTurn,
} from "./protocol-fixtures.js";

/** Sends one parsed JSON-RPC value from a fake app-server. */
export type FakeTransportSend = (value: unknown) => void;

/** Handles one parsed JSON-RPC message written by the proxy. */
export type FakeTransportMessageHandler = (
  message: Record<string, unknown>,
  send: FakeTransportSend,
) => void;

/** Configuration for a fake in-memory app-server transport. */
export interface FakeTransportOptions {
  fragmentCount?: number | undefined;
  onMessage: FakeTransportMessageHandler;
}

/** In-memory app-server transport and its server-side controls. */
export interface FakeTransport {
  rpc: JsonRpcTransport;
  send: FakeTransportSend;
  close(reason?: Error): void;
}

/** Splits one complete encoded frame into the requested non-empty byte pieces. */
function frameFragments(frame: Buffer, fragmentCount: number): Buffer[] {
  const count = Math.min(fragmentCount, frame.length);
  const fragments: Buffer[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor((index * frame.length) / count);
    const end = Math.floor(((index + 1) * frame.length) / count);
    fragments.push(frame.slice(start, end));
  }
  return fragments;
}

/** Creates a fake app-server transport with configurable frame fragmentation. */
export function createFakeTransport(
  options: FakeTransportOptions,
): FakeTransport {
  const fragmentCount = options.fragmentCount ?? 1;
  if (!Number.isSafeInteger(fragmentCount) || fragmentCount < 1)
    throw new Error("Fake transport fragmentCount must be a positive integer.");

  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const rpc = new JsonRpcTransport(fromServer, toServer);
  let closed = false;
  const send: FakeTransportSend = (value) => {
    if (closed) throw new Error("Fake app-server transport is closed.");
    const frame = Buffer.from(`${JSON.stringify(value)}\n`);
    for (const fragment of frameFragments(frame, fragmentCount))
      fromServer.write(fragment);
  };
  const lines = createInterface({ input: toServer, crlfDelay: Infinity });
  /** Tears down both physical directions and optionally closes the logical RPC. */
  const teardown = (
    reason = new Error("Fake app-server transport closed."),
    closeRpc = true,
  ): void => {
    if (closed) return;
    closed = true;
    lines.close();
    fromServer.destroy();
    toServer.destroy();
    if (closeRpc) rpc.close(reason);
  };
  rpc.once("close", () => teardown(undefined, false));
  lines.on("line", (line) => {
    options.onMessage(JSON.parse(line) as Record<string, unknown>, send);
  });

  return {
    rpc,
    send,
    close: teardown,
  };
}

/** Builds the canonical deterministic token-usage fixture. */
export function tokenUsageFixture(
  reasoningOutputTokens = 0,
  // App-server reports `last` for the model request that just finished and
  // `total` for every request the thread has run, so a turn's later requests
  // report the same breakdown against grown cumulative counters.
  priorRequests = 0,
): ThreadTokenUsage {
  // Reasoning tokens are part of what the model emitted, so the fixture grows
  // its output and total counts with them rather than reporting a breakdown no
  // app-server could produce.
  const outputTokens = 2 + reasoningOutputTokens;
  const last = {
    inputTokens: 4,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: 4 + outputTokens,
  };
  const requests = priorRequests + 1;
  return {
    total: Object.fromEntries(
      Object.entries(last).map(([name, count]) => [name, count * requests]),
    ) as typeof last,
    last,
    modelContextWindow: null,
  };
}

/** Emits one typed thread-scoped token-usage notification. */
export function sendTokenUsage(
  send: FakeTransportSend,
  threadId: string,
  turnId: string,
  tokenUsage: ThreadTokenUsage,
): void {
  send(
    protocolNotification({
      method: "thread/tokenUsage/updated",
      params: { threadId, turnId, tokenUsage },
    }),
  );
}

/**
 * Wire position of a turn's final usage relative to its completion. App-server
 * streams usage separately from completion, so all three orders are legal and
 * every one must produce the same response usage.
 */
export type UsageWireOrder =
  "before_completion" | "after_completion" | "later_read";

/** Milliseconds by which `later_read` defers usage past the completion frame. */
const LATER_READ_DELAY_MS = 5;

/**
 * Wire position of a tool-call turn's usage. Live app-server (codex 0.145.0)
 * flushes usage within milliseconds of `turn/interrupt`, but may also have
 * attributed the model request before `item/tool/call`; a broken server may
 * never flush at all. Every position must produce exactly-once attribution
 * across the tool-call response and its continuation.
 */
export type ToolUsageWireOrder = "before_tool_call" | "on_interrupt" | "never";

/** One dynamic tool request scripted by a tool-call turn. */
export interface ScriptedToolCall {
  id: number;
  callId: string;
  tool: string;
  arguments: JsonValue;
}

/** Usage ordering selected by one scripted dynamic-tool batch. */
export interface SuspendWithToolsOptions {
  completeRawResponse?: boolean;
  reasoningOutputTokens?: number;
  priorRequests?: number;
  usageOrder?: ToolUsageWireOrder;
}

/**
 * Emits typed dynamic tool requests, with usage first when the scripted order
 * attributes the model request before the tool call. The `on_interrupt` order
 * is realized by the fake's `turn/interrupt` handler via `interruptTurn`, not
 * here, matching the live flush-at-interrupt wire behavior.
 */
export function suspendWithTools(
  send: FakeTransportSend,
  threadId: string,
  turnId: string,
  calls: readonly ScriptedToolCall[],
  {
    completeRawResponse = true,
    reasoningOutputTokens = 0,
    priorRequests = 0,
    usageOrder = "never",
  }: SuspendWithToolsOptions = {},
): void {
  if (usageOrder === "before_tool_call")
    sendTokenUsage(
      send,
      threadId,
      turnId,
      tokenUsageFixture(reasoningOutputTokens, priorRequests),
    );
  for (const call of calls)
    send(
      protocolServerRequest({
        id: call.id,
        method: "item/tool/call",
        params: {
          threadId,
          turnId,
          callId: call.callId,
          tool: call.tool,
          namespace: null,
          arguments: call.arguments,
        },
      }),
    );
  if (completeRawResponse) completeRawResponseBatch(send, threadId, turnId);
}

/** Emits the authoritative end of one upstream Responses completion. */
export function completeRawResponseBatch(
  send: FakeTransportSend,
  threadId: string,
  turnId: string,
): void {
  send(
    protocolNotification({
      method: "rawResponse/completed",
      params: {
        threadId,
        turnId,
        responseId: `raw_${turnId}`,
        usage: null,
      },
    }),
  );
}

/** Usage emission selected by one scripted turn interruption. */
export interface InterruptTurnOptions {
  reasoningOutputTokens?: number;
  priorRequests?: number;
  includeUsage?: boolean;
}

/**
 * Emits the wire sequence live app-server produces when a turn is interrupted:
 * the terminal usage flush, `turn/completed` with status `interrupted`, and
 * the thread's idle boundary.
 */
export function interruptTurn(
  send: FakeTransportSend,
  threadId: string,
  turnId: string,
  {
    reasoningOutputTokens = 0,
    priorRequests = 0,
    includeUsage = true,
  }: InterruptTurnOptions = {},
): void {
  if (includeUsage)
    sendTokenUsage(
      send,
      threadId,
      turnId,
      tokenUsageFixture(reasoningOutputTokens, priorRequests),
    );
  send(
    protocolNotification({
      method: "turn/completed",
      params: { threadId, turn: protocolTurn(turnId, "interrupted") },
    }),
  );
  send(
    protocolNotification({
      method: "thread/status/changed",
      params: { threadId, status: { type: "idle" } },
    }),
  );
}

/** Final usage and wire ordering selected by one scripted turn completion. */
export interface CompleteTurnOptions {
  reasoningOutputTokens?: number;
  priorRequests?: number;
  usageOrder?: UsageWireOrder;
}

/** Emits typed usage and successful completion notifications for one turn. */
export function completeTurn(
  send: FakeTransportSend,
  threadId: string,
  turnId: string,
  {
    reasoningOutputTokens = 0,
    priorRequests = 0,
    usageOrder = "before_completion",
  }: CompleteTurnOptions = {},
): void {
  const usage = (): void =>
    sendTokenUsage(
      send,
      threadId,
      turnId,
      tokenUsageFixture(reasoningOutputTokens, priorRequests),
    );
  const completed = (): void =>
    send(
      protocolNotification({
        method: "turn/completed",
        params: { threadId, turn: protocolTurn(turnId, "completed") },
      }),
    );
  const idle = (): void =>
    send(
      protocolNotification({
        method: "thread/status/changed",
        params: { threadId, status: { type: "idle" } },
      }),
    );
  if (usageOrder === "before_completion") {
    usage();
    completed();
    idle();
    return;
  }
  completed();
  if (usageOrder === "after_completion") {
    usage();
    idle();
    return;
  }
  // `later_read` delivers usage and the idle boundary on a transport read the
  // proxy has not performed yet when the turn's terminal frame is consumed.
  const timer = setTimeout(() => {
    usage();
    idle();
  }, LATER_READ_DELAY_MS);
  timer.unref();
}
