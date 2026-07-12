# Stage 05: Dynamic tools and thread reuse

## Goal

Support standard client-defined tools across requests while maximizing safe Codex thread reuse.

## Work

1. Translate Chat Completions function tools to app-server `dynamicTools` with experimental capability enabled.
    - Tools are per-request in Chat Completions but thread-scoped at `thread/start`; apply the Stage 01 finding for whether a continued thread can change its tool set, and reject or document requests it cannot honor.
    - Register only top-level functions so `item/tool/call` correlation never depends on `namespace`.
    - Validate function names against the app-server constraints (`^[a-zA-Z0-9_-]+$`, 1 to 128 characters) with OpenAI-shaped errors.
2. When app-server issues `item/tool/call`, correlate name, call ID, arguments, thread, turn, and pending JSON-RPC response.
3. Stream standard `delta.tool_calls` argument fragments, register the pending continuation with a deadline, and end the HTTP response with `finish_reason: "tool_calls"` while keeping the app-server call pending.
    - This registered dynamic-tool suspension is the only server-initiated request allowed to outlive its originating HTTP request.
4. Persist a non-secret tombstone for pending calls but keep the actual responder in memory.
    - On deadline expiry, answer the app-server request with a timeout error and invalidate the continuation.
    - Document that restart also invalidates pending calls.
5. On the next request, locate the pending calls per the Stage 01 correlation decision (by `previous_response_id`, or by `tool_call_id` alone if that proves safe for unmodified clients).
    - Require the assistant tool-call message plus exactly one matching `role: "tool"` result per required call.
    - Reject missing, duplicate, foreign, or already-consumed IDs.
6. Respond to each pending app-server request, resume event streaming, and associate the resulting completion with the same Codex thread.
    - Translate each accepted `role: "tool"` string result to `inputText` content items in the documented `contentItems`/`success` response shape.
    - Document that v1 always reports `success: true` because Chat Completions has no tool-failure signal.
7. Support multiple parallel tool calls and out-of-order result messages while responding to app-server in deterministic call order.
8. Store opaque response-to-thread mappings atomically in the state directory.
    - For every completed-response continuation, first require a valid, unexpired mapping.
    - Then inspect the mapped thread through app-server (`thread/read` returns stored status without resuming) and verify that its status and effective policy are resumable.
    - Treat `thread/resume` as the final authoritative check and handle a state change between inspection and resume as a rejected continuation.
9. Bind continuation records to effective model, cwd, and policy metadata. Define which settings may change on a resumed thread and reject unsafe ambiguity, applying the Stage 01 model-consistency decision.
10. Add retention, pruning, corruption recovery, and schema migration for the local mapping store.
11. Detect replayed continuation requests and make behavior idempotent where possible; otherwise return a clear conflict.
12. Serialize access per thread: a thread runs at most one active turn.
    - Immediately reject a request arriving while another turn or pending tool suspension owns the same thread with an OpenAI-shaped HTTP 409 conflict; never queue or interleave it.
    - The one exception is the validated request carrying the tool results for that exact suspension.
13. Never call `thread/start` when a request supplied `previous_response_id`.
    - Reject unknown, expired, archived, deleted, corrupt, busy, policy-incompatible, or otherwise non-resumable references with the Stage 01 error mapping, preserving whether the client may retry.
14. Reject a `previous_response_id` that is no longer its thread's newest completed response with the distinct Stage 01 superseded-reference error.
    - Resuming would silently append after later turns.
    - `thread/fork` with `lastTurnId` is the only faithful branching mechanism and stays out of v1 unless the Stage 01 spike proves it.

## Acceptance criteria

- Offline tests cover one tool, parallel tools, fragmented arguments, large results, mismatches, duplicates, replay, suspension timeout, disconnect, cancellation, same-thread HTTP 409 conflicts, and every non-resumable continuation state.
- A completed thread resumes after proxy/app-server restart using only `previous_response_id`.
- Unknown or non-resumable `previous_response_id` values never create a new thread, including a superseded response on a multi-response thread and a thread that changes state between preflight and `thread/resume`.
- A pending tool continuation returns a clear non-retryable error after restart.
- Mapping writes survive abrupt termination without corrupting other records.
- One opt-in live scenario completes a tool round trip with `gpt-5.4-nano` using at most two model calls.
