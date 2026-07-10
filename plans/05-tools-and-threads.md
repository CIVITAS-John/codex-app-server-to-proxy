# Stage 05: Dynamic tools and thread reuse

## Goal

Support standard client-defined tools across requests while maximizing safe Codex thread reuse.

## Work

1. Translate Chat Completions function tools to app-server `dynamicTools` with experimental capability enabled.
2. When app-server issues `item/tool/call`, correlate name, call ID, arguments, thread, turn, and pending JSON-RPC response.
3. Stream standard `delta.tool_calls` argument fragments and end the HTTP response with `finish_reason: "tool_calls"` while keeping the app-server call pending.
4. Persist a non-secret tombstone for pending calls but keep the actual responder in memory. Document that restart invalidates pending calls.
5. On the next request, require `previous_response_id`, the assistant tool-call message, and exactly one matching `role: "tool"` result per required call. Reject missing, duplicate, foreign, or already-consumed IDs.
6. Respond to each pending app-server request, resume event streaming, and associate the resulting completion with the same Codex thread.
7. Support multiple parallel tool calls and out-of-order result messages while responding to app-server in deterministic call order.
8. Store opaque response-to-thread mappings atomically in the state directory. Resume with `thread/resume` after completed-response restarts.
9. Bind continuation records to effective cwd and policy metadata. Define which settings may change on a resumed thread and reject unsafe ambiguity.
10. Add retention, pruning, corruption recovery, and schema migration for the local mapping store.
11. Detect replayed continuation requests and make behavior idempotent where possible; otherwise return a clear conflict.

## Acceptance criteria

- Offline tests cover one tool, parallel tools, fragmented arguments, large results, mismatches, duplicates, replay, timeout, disconnect, and cancellation.
- A completed thread resumes after proxy/app-server restart using only `previous_response_id`.
- A pending tool continuation returns a clear non-retryable error after restart.
- Mapping writes survive abrupt termination without corrupting other records.
- One opt-in live scenario completes a tool round trip with `gpt-5.4-nano` using at most two model calls.

