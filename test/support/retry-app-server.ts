import type { CodexErrorInfo } from "../../protocol/generated/typescript/v2/CodexErrorInfo.js";
import {
  protocolNotification,
  protocolRateLimitSnapshot,
  protocolRateLimitsResponse,
  protocolResponse,
  protocolThread,
  protocolThreadResumeResponse,
  protocolThreadStartResponse,
  protocolTurn,
} from "./protocol-fixtures.js";
import {
  createFakeTransport,
  interruptTurn,
  type FakeTransport,
  type FakeTransportSend,
} from "./transport.js";

/** Builds a typed error for retry scripts, including terminal quota variants. */
export function retryError(
  willRetry: boolean,
  turnId = "turn_retry_1",
  codexErrorInfo: CodexErrorInfo | null = "serverOverloaded",
  threadId = "thr_retry",
) {
  return protocolNotification({
    method: "error",
    params: {
      threadId,
      turnId,
      willRetry,
      error: {
        message: "Synthetic upstream failure.",
        codexErrorInfo,
        additionalDetails: null,
        misalignment: null,
      },
    },
  });
}

/** Emits typed text without implying any retry-owned replay or output reset. */
export function retryText(
  send: FakeTransportSend,
  turnId: string,
  delta: string,
): void {
  send(
    protocolNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thr_retry", turnId, itemId: "message", delta },
    }),
  );
}

/** Recording retry script that also supports persisted tool resumption. */
export type RetryAppServer = FakeTransport & {
  methods: string[];
  responderErrors: number[];
};

/** Creates a recording retry script that also supports persisted tool resumption. */
export function retryAppServer(
  onTurn: (send: FakeTransportSend, turnId: string, turnNumber: number) => void,
  completeInterrupt = true,
): RetryAppServer {
  const methods: string[] = [];
  const responderErrors: number[] = [];
  let turns = 0;
  const fake = createFakeTransport({
    fragmentCount: 3,
    onMessage(message, send) {
      const id = message.id as number;
      const method = message.method as string;
      if (method) methods.push(method);
      if (message.error) responderErrors.push(id);
      if (method === "thread/start")
        send(
          protocolResponse(
            method,
            id,
            protocolThreadStartResponse(protocolThread("thr_retry")),
          ),
        );
      else if (method === "thread/read")
        send(
          protocolResponse(method, id, {
            readState: null,
            thread: protocolThread("thr_retry"),
          }),
        );
      else if (method === "thread/resume")
        send(
          protocolResponse(
            method,
            id,
            protocolThreadResumeResponse(protocolThread("thr_retry")),
          ),
        );
      else if (method === "thread/inject_items")
        send(protocolResponse(method, id, {}));
      else if (method === "turn/start") {
        const turnId = `turn_retry_${++turns}`;
        send(
          protocolResponse(method, id, {
            turn: protocolTurn(turnId, "inProgress"),
          }),
        );
        onTurn(send, turnId, turns);
      } else if (method === "turn/interrupt") {
        send(protocolResponse(method, id, {}));
        if (completeInterrupt)
          interruptTurn(
            send,
            "thr_retry",
            (message.params as { turnId: string }).turnId,
          );
      } else if (method === "account/rateLimits/read")
        send(
          protocolResponse(
            method,
            id,
            protocolRateLimitsResponse(protocolRateLimitSnapshot(), null),
          ),
        );
    },
  });
  return { ...fake, methods, responderErrors };
}
