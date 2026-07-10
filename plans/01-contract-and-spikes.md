# Stage 01: Contract and spikes

## Goal

Freeze the smallest honest compatibility contract and prove the uncertain app-server behaviors before building the server.

## Work

1. Generate TypeScript and JSON Schema artifacts from the exact supported Codex version, passing `--experimental` so gated APIs the proxy depends on (`dynamicTools`, `item/tool/call`) are included. Store the version and generation command; do not hand-maintain app-server wire types.
2. Build a protocol mapping table covering `thread/start`, `thread/resume`, `turn/start`, item events, token usage, auth, approvals, dynamic tools, and failures.
3. Define the accepted Chat Completions request subset and OpenAI-shaped error envelope. Classify every other known field as ignored-with-warning or rejected.
4. Define the SSE mapping for role, text, tool-call argument fragments, finish reasons, usage, errors, and `[DONE]`.
5. Define `x_codex` schemas for request policy controls and streamed reasoning/internal activity.
6. Specify response-ID generation and a versioned durable mapping record: response ID, thread ID, turn ID, status, timestamps, cwd/policy fingerprint, and pending-tool metadata.
7. Spike `account/read` plus `account/login/start` browser flow and fallback behavior.
8. Spike dynamic tools to determine exactly when app-server blocks, what must remain in memory, and how multiple simultaneous calls correlate with later `role: "tool"` messages. Include whether `dynamicTools` can be supplied or changed on `thread/resume`; the protocol reference documents it only on `thread/start`.
9. Spike all app-server web-search settings to verify how `disabled`, `cached`, and `live` map for the supported Codex version. The protocol reference documents no per-turn web-search setting — only `allowedWebSearchModes` in `configRequirements/read` — so treat this mapping as unproven until the spike lands.
10. Spike package ownership of the Codex executable. Prefer an official supported npm dependency; document the fallback discovery/install path if no stable distributable contract exists.
11. Spike how to represent multi-role message history on a fresh thread. `turn/start` input accepts only user text/image items with no role concept, so system/developer/assistant/tool history from a stateless client needs `thread/inject_items` (raw Responses API items) or a documented flattening; define the v1 mechanism and what it loses.

## Decisions to record

- Exact app-server version range and executable source.
- Whether non-streaming responses are fully supported or implemented by buffering the same event pipeline.
- Exact `x_codex` delta shapes and finish-reason behavior for internal versus client-defined tools.
- Behavior when a continued request supplies messages inconsistent with persisted thread history.
- Whether tool continuations can be correlated by `tool_call_id` alone so an unmodified Chat Completions client can complete the tool loop, or whether `previous_response_id` is a hard requirement that must be documented as a compatibility break.
- How `tool_choice` values other than `auto` behave, given no documented app-server equivalent for forcing or forbidding a tool call.
- Whether app-server exposes cumulative or per-turn usage and how to derive per-response values without estimation. Usage streams via `thread/tokenUsage/updated` (thread-scoped), not on `turn/completed`.

## Acceptance criteria

- A checked-in contract document distinguishes standard and extended behavior field by field.
- Synthetic fixtures exist for every app-server event type the proxy claims to expose.
- A disposable spike demonstrates text streaming and a two-request dynamic-tool round trip using `gpt-5.4-nano` only.
- A disposable restart spike proves a completed persisted thread can resume.
- Every unresolved behavior has an explicit conservative fallback or blocks the next stage.

## Cost guard

Run at most four live model calls for this stage: text, tool request, tool continuation, and post-restart continuation. All use `gpt-5.4-nano` with small output limits.

