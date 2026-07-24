import type { ClientNotification } from "../../protocol/generated/typescript/ClientNotification.js";
import type { ClientRequest } from "../../protocol/generated/typescript/ClientRequest.js";
import type { ServerNotification } from "../../protocol/generated/typescript/ServerNotification.js";
import type { ServerRequest } from "../../protocol/generated/typescript/ServerRequest.js";
import type { InitializeResponse } from "../../protocol/generated/typescript/InitializeResponse.js";
import type { GetAccountResponse } from "../../protocol/generated/typescript/v2/GetAccountResponse.js";
import type { LoginAccountResponse } from "../../protocol/generated/typescript/v2/LoginAccountResponse.js";
import type { ConfigRequirementsReadResponse } from "../../protocol/generated/typescript/v2/ConfigRequirementsReadResponse.js";
import type { Thread } from "../../protocol/generated/typescript/v2/Thread.js";
import type { ThreadInjectItemsResponse } from "../../protocol/generated/typescript/v2/ThreadInjectItemsResponse.js";
import type { ThreadReadResponse } from "../../protocol/generated/typescript/v2/ThreadReadResponse.js";
import type { ThreadResumeResponse } from "../../protocol/generated/typescript/v2/ThreadResumeResponse.js";
import type { ThreadStartResponse } from "../../protocol/generated/typescript/v2/ThreadStartResponse.js";
import type { TurnInterruptResponse } from "../../protocol/generated/typescript/v2/TurnInterruptResponse.js";
import type { TurnStartResponse } from "../../protocol/generated/typescript/v2/TurnStartResponse.js";
import type { Turn } from "../../protocol/generated/typescript/v2/Turn.js";

/** Generated response types used by maintained fake app-server methods. */
interface ProtocolResponseByMethod {
  initialize: InitializeResponse;
  "account/read": GetAccountResponse;
  "account/login/start": LoginAccountResponse;
  "configRequirements/read": ConfigRequirementsReadResponse;
  "thread/read": ThreadReadResponse;
  "thread/start": ThreadStartResponse;
  "thread/resume": ThreadResumeResponse;
  "thread/inject_items": ThreadInjectItemsResponse;
  "turn/start": TurnStartResponse;
  "turn/interrupt": TurnInterruptResponse;
}

/** Builds a complete generated initialize response for embedded fake processes. */
export function protocolInitializeResponse(): InitializeResponse {
  return {
    userAgent: "codex-test-fixture",
    codexHome: "/tmp/codex-test-home",
    platformFamily: "unix",
    platformOs: "test",
  };
}

/** Builds a complete authenticated account response for fake app-servers. */
export function protocolAuthenticatedAccountResponse(): GetAccountResponse {
  return {
    account: { type: "chatgpt", email: null, planType: "unknown" },
    requiresOpenaiAuth: true,
  };
}

/** Builds a complete generated thread/start response for fake transports. */
export function protocolThreadStartResponse(
  thread: Thread,
  cwd = thread.cwd,
): ThreadStartResponse {
  return {
    thread,
    model: "gpt-5.6-luna",
    modelProvider: "openai",
    serviceTier: null,
    cwd,
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    sandbox: { type: "readOnly", networkAccess: false },
    activePermissionProfile: null,
    reasoningEffort: null,
    multiAgentMode: "explicitRequestOnly",
  };
}

/** Builds a complete generated thread/resume response for fake transports. */
export function protocolThreadResumeResponse(
  thread: Thread,
  cwd = thread.cwd,
): ThreadResumeResponse {
  return {
    ...protocolThreadStartResponse(thread, cwd),
    initialTurnsPage: null,
    turnsBackwardsCursor: null,
    itemsBackwardsCursor: null,
  };
}

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

/** Builds a complete generated-protocol thread for fake app-server responses. */
export function protocolThread(
  id: string,
  status: Thread["status"] = { type: "idle" },
): Thread {
  return {
    id,
    extra: null,
    sessionId: `session_${id}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    historyMode: "paginated",
    modelProvider: "openai",
    createdAt: 0,
    updatedAt: 0,
    recencyAt: null,
    status,
    path: null,
    cwd: "/tmp",
    cliVersion: "fixture",
    source: "unknown",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    canAcceptDirectInput: null,
    turns: [],
  };
}

/** Narrows a maintained fake client request against the generated wire union. */
export function protocolClientRequest(request: ClientRequest): ClientRequest {
  return request;
}

/** Narrows a maintained fake client notification against the generated wire union. */
export function protocolClientNotification(
  notification: ClientNotification,
): ClientNotification {
  return notification;
}

/** Narrows a maintained fake notification against the generated wire union. */
export function protocolNotification(
  notification: ServerNotification,
): ServerNotification {
  return notification;
}

/** Narrows a maintained fake server request against the generated wire union. */
export function protocolServerRequest(request: ServerRequest): ServerRequest {
  return request;
}

/** Builds a method-specific fake JSON-RPC success response. */
export function protocolResponse<Method extends keyof ProtocolResponseByMethod>(
  _method: Method,
  id: string | number,
  result: ProtocolResponseByMethod[Method],
): { id: string | number; result: ProtocolResponseByMethod[Method] } {
  return { id, result };
}
