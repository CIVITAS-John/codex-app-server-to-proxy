import { HttpError } from "./errors.js";

/** Classifies whether a prior response can resume its Codex thread. */
export type ContinuationState =
  | "ready"
  | "expired"
  | "superseded"
  | "pending_tool"
  | "busy"
  | "archived"
  | "deleted"
  | "corrupt"
  | "policy"
  | "model"
  | "tools"
  | "cwd";

/** Maps an x_codex response identifier to continuation state. */
export interface ContinuationMapping {
  responseId: string;
  threadId: string;
  state: ContinuationState;
}

/** Looks up persisted response-to-thread mappings. */
export interface ContinuationStore {
  get(responseId: string): ContinuationMapping | undefined;
}

/** Attempts to resume an existing Codex thread. */
export interface ThreadResumer {
  resume(threadId: string): "resumable" | "not_resumable";
}

/** Stable OpenAI-shaped failures for non-resumable continuation states. */
const failures: Record<Exclude<ContinuationState, "ready">, HttpError> = {
  expired: failure(410, "expired_previous_response_id"),
  superseded: failure(409, "superseded_previous_response_id"),
  pending_tool: failure(409, "tool_results_required"),
  busy: failure(409, "thread_busy"),
  archived: failure(409, "thread_archived"),
  deleted: failure(410, "thread_deleted"),
  corrupt: failure(500, "corrupt_response_state"),
  policy: failure(409, "continuation_policy_mismatch"),
  model: failure(409, "continuation_model_mismatch"),
  tools: failure(409, "continuation_tools_mismatch"),
  cwd: failure(409, "continuation_cwd_mismatch"),
};

/** Validates a continuation without mutating its stored mapping. */
export function preflightContinuation(
  responseId: string,
  store: ContinuationStore,
  appServer: ThreadResumer,
): ContinuationMapping {
  const mapping = store.get(responseId);
  if (mapping === undefined) {
    throw failure(404, "unknown_previous_response_id");
  }
  if (mapping.state !== "ready") throw failures[mapping.state];
  if (appServer.resume(mapping.threadId) !== "resumable") {
    throw failure(409, "thread_not_resumable");
  }
  return mapping;
}

/** Builds a continuation-specific HTTP error. */
function failure(status: number, code: string): HttpError {
  return new HttpError(
    status,
    "The previous response cannot be continued.",
    status >= 500
      ? "server_error"
      : status === 409
        ? "conflict_error"
        : "invalid_request_error",
    code,
    "previous_response_id",
  );
}
