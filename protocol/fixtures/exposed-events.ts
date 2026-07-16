import type { ServerNotification } from "../generated/typescript/ServerNotification.js";
import type { ServerRequest } from "../generated/typescript/ServerRequest.js";

/** Typed source for every app-server event claimed by the exposed-event corpus. */
export const exposedEvents = [
  {
    method: "item/agentMessage/delta",
    params: {
      threadId: "thr_fixture",
      turnId: "turn_fixture",
      itemId: "item_text",
      delta: "hello",
    },
  },
  {
    method: "item/reasoning/summaryPartAdded",
    params: {
      threadId: "thr_fixture",
      turnId: "turn_fixture",
      itemId: "item_reason",
      summaryIndex: 0,
    },
  },
  {
    method: "item/reasoning/summaryTextDelta",
    params: {
      threadId: "thr_fixture",
      turnId: "turn_fixture",
      itemId: "item_reason",
      summaryIndex: 0,
      delta: "checked inputs",
    },
  },
  {
    method: "item/reasoning/textDelta",
    params: {
      threadId: "thr_fixture",
      turnId: "turn_fixture",
      itemId: "item_reason",
      contentIndex: 0,
      delta: "exposed reasoning",
    },
  },
  {
    method: "item/commandExecution/outputDelta",
    params: {
      threadId: "thr_fixture",
      turnId: "turn_fixture",
      itemId: "item_command",
      delta: "output",
    },
  },
  {
    method: "item/fileChange/outputDelta",
    params: {
      threadId: "thr_fixture",
      turnId: "turn_fixture",
      itemId: "item_patch",
      delta: "updated file",
    },
  },
  {
    method: "item/fileChange/patchUpdated",
    params: {
      threadId: "thr_fixture",
      turnId: "turn_fixture",
      itemId: "item_patch",
      changes: [
        {
          path: "fixture.txt",
          kind: { type: "update", move_path: null },
          diff: "@@ fixture @@",
        },
      ],
    },
  },
  {
    method: "item/mcpToolCall/progress",
    params: {
      threadId: "thr_fixture",
      turnId: "turn_fixture",
      itemId: "item_mcp",
      message: "running",
    },
  },
  {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thr_fixture",
      turnId: "turn_fixture",
      tokenUsage: {
        total: {
          totalTokens: 15,
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 5,
          reasoningOutputTokens: 1,
        },
        last: {
          totalTokens: 15,
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 5,
          reasoningOutputTokens: 1,
        },
        modelContextWindow: 128000,
      },
    },
  },
  {
    method: "turn/completed",
    params: {
      threadId: "thr_fixture",
      turn: {
        id: "turn_fixture",
        items: [],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
    },
  },
  {
    method: "error",
    params: {
      error: {
        message: "fixture failure",
        codexErrorInfo: null,
        additionalDetails: null,
      },
      willRetry: false,
      threadId: "thr_fixture",
      turnId: "turn_fixture",
    },
  },
  {
    method: "item/tool/call",
    id: 41,
    params: {
      threadId: "thr_fixture",
      turnId: "turn_fixture",
      callId: "call_fixture",
      namespace: null,
      tool: "lookup",
      arguments: { id: "T-1" },
    },
  },
  {
    method: "item/commandExecution/requestApproval",
    id: 42,
    params: {
      threadId: "thr_fixture",
      turnId: "turn_fixture",
      itemId: "item_command",
      startedAtMs: 0,
      environmentId: null,
      reason: "fixture",
    },
  },
  {
    method: "serverRequest/resolved",
    params: { threadId: "thr_fixture", requestId: 41 },
  },
] as const satisfies readonly (ServerNotification | ServerRequest)[];
