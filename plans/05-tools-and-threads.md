# Stage 05: Dynamic tools and thread reuse

## Goal

Support client-defined tools across requests while preserving safe Codex thread reuse.

## Work

1. Translate Chat Completions function tools to app-server `dynamicTools` with experimental capability enabled.
    - Tools are thread-scoped in app-server. Canonicalize the definition and reject a changed tool set on continuation.
    - Register only top-level functions so `item/tool/call` correlation never depends on `namespace`.
    - Validate function names against the app-server constraints (`^[a-zA-Z0-9_-]+$`, 1 to 128 characters) with OpenAI-shaped errors.
2. When app-server issues `item/tool/call`, correlate name, call ID, arguments, thread, turn, and pending JSON-RPC response.
    - Route callbacks centrally by thread to exactly one active owner; per-request event listeners and listener-count inference are not ownership mechanisms.
3. Stream standard `delta.tool_calls`, register the pending continuation with the configured deadline, and end the HTTP response with `finish_reason: "tool_calls"` while keeping the app-server call pending.
    - Default the deadline to five minutes.
    - This registered dynamic-tool suspension is the only server-initiated request allowed to outlive its originating HTTP request.
4. Persist a non-secret tombstone for pending calls but keep the actual responder in memory.
    - On deadline expiry, answer the app-server request with a timeout error and invalidate the continuation.
    - Document that restart also invalidates pending calls.
5. On the next request, locate the pending calls per the Stage 01 correlation decision (by `previous_response_id`, or by `tool_call_id` alone if that proves safe for unmodified clients).
    - Require the assistant tool-call message plus exactly one matching `role: "tool"` result per required call.
    - Reject missing, duplicate, foreign, or already-consumed IDs.
    - Accept a tool-ending continuation only for a pending-tool mapping. Reject the same shape against a ready mapping with HTTP 409 `tool_results_without_pending_call`; never reinterpret tool output as user text.
6. Respond to each pending app-server request, begin the continuation response with each accepted `tool_calls` and `tool_results` pair, resume later activity from the same Codex turn, and associate the resulting completion with the same Codex thread.
    - Translate each accepted `role: "tool"` string result to `inputText` content items in the documented `contentItems`/`success` response shape.
    - Document that v1 always reports `success: true` because Chat Completions has no tool-failure signal.
7. Support multiple parallel tool calls and out-of-order result messages while responding to app-server in observed arrival order.
    - Feed notifications and dynamic server requests through one bounded FIFO ingress stream so requests cannot overtake preceding reasoning, text, or internal-tool activity.
    - When the first dynamic request reaches the head, capture one event-loop batching window, process that window in arrival order, and suspend with every dynamic request captured in it. Reject and clean up later requests instead of dropping them.
    - On queue overflow or transport failure, abort the active turn and reject every queued server responder.
8. Store opaque response-to-thread mappings atomically in the state directory.
    - For every completed-response continuation, first require a valid, unexpired mapping.
    - Then inspect the mapped thread through app-server (`thread/read` returns stored status without resuming) and verify that its status and effective policy are resumable.
    - Treat `thread/resume` as the final authoritative check and handle a state change between inspection and resume as a rejected continuation.
9. Bind continuation records to the canonical tool set, model, reasoning effort, cwd, and effective policy. Reject any mismatch.
10. Add retention, pruning, corruption recovery, and strict schema validation for the local mapping store.
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
- One opt-in live scenario completes a tool round trip with `gpt-5.4-mini` using at most two model calls.

## Implemented decisions

- The versioned state file is `continuations.json` under `--state-dir`. Writes use same-directory temporary files followed by atomic rename; corrupt files recover as an empty, untrusted store.
- Mapping retention defaults to 30 days. An older completed response becomes `superseded` as soon as a newer response is recorded for the same thread.
- Tool definitions are recursively key-sorted and SHA-256 hashed. Continuations bind that hash together with model, optional reasoning effort, root working directory, and the effective-policy hash. New records carry `reasoningEffortBound: true`, so explicit effort and omission both match exactly. Pre-upgrade schema-version-0 records lacking both reasoning fields accept one ambiguous continuation, whose replacement record is then exact; this prevents an upgrade-only 409 for clients that previously sent the ignored field.
- Pending-tool tombstones contain call IDs but no arguments or results. Reload converts them to expired tombstones because the JSON-RPC responders are process-local; the compatibility consequence is a non-retryable `expired_tool_continuation` response after restart.
- Selecting a live pending-tool response, explicitly by `previous_response_id` or implicitly by its tool-call IDs, restarts its configured deadline before continuation binding and transcript validation. Correctable rejected retries therefore preserve a full client result window; unrelated requests and restart tombstones do not extend it.
- Dynamic tool results always use app-server `inputText` content with `success: true`; Chat Completions has no standard tool-failure bit.
- One response store lives for the proxy server lifetime. Replacing or removing app-server disposes the old continuation generation, cancels deadlines, rejects suspended responders and late callbacks, expires their mappings, and then closes the old transport so active executions wake without writing stale mappings. Buffered frames are ignored after logical transport close.
- The pinned protocol accepts `dynamicTools` only on `thread/start`, not `thread/resume` or `turn/start`. Consequently a pending tool-result request and every later completed-thread continuation must repeat the original canonical tool set. A 3-tool thread cannot resume in place with 2 tools; v1 rejects that request rather than silently creating a different thread.
- Implicit tool continuation is enabled by default: `tool_call_id` values must jointly identify exactly one live in-memory suspension. `--implicit-tool-continuation false` disables this compatibility mode and requires `previous_response_id`; unknown or ambiguous IDs never fall back to a new thread.
- Ready continuations cannot consume tool messages because they have no pending dynamic call. They fail read-only with HTTP 409 `tool_results_without_pending_call`, preserving role and tool-call semantics.
- Dynamic calls use `tool_calls`. The first response drains all preceding activity before `finish_reason: "tool_calls"`; the result response starts with self-correlating `tool_calls` plus `tool_results` pairs and then exposes later text, reasoning, or internal tools.
- A verbatim assistant replay may contain observational internal calls alongside pending dynamic calls. Continuation validation matches only pending call IDs, still requiring each pending call and result exactly once; duplicate assistant call IDs remain invalid.
- Parallel dynamic calls are batched and answered in observed arrival order, replacing the earlier lexicographic call-ID ordering. This is a compatibility change for clients that inferred an order from call IDs; clients must correlate by `call_id` instead.
- Internal Codex tools are emitted as function-shaped calls/results but remain observational. They neither enter the suspension store nor become client-executable dynamic calls.

## Implementation status

Stage 05 is complete. Function-oriented offline suites cover dynamic-tool streaming and aggregation, parallel and out-of-order results, large payloads, mismatches, replay, timeouts, transport replacement, thread serialization, continuation bindings, every fail-closed thread status, restart recovery, resume races, and atomic state migration/rollback. Resume now requires the app-server to return the exact persisted thread ID, and a partial failure while delivering parallel tool results expires and releases the suspension instead of leaving a timerless busy owner.

The opt-in live contract passed on 2026-07-14. Its two-request `gpt-5.4-mini` function-tool round trip stayed within the two-call guard, and the resulting completed response then resumed after a full proxy/app-server restart. Request policy selection remains a Stage 06 concern; Stage 05 binds the currently empty effective-policy hash and rejects all nonempty policy requests.
