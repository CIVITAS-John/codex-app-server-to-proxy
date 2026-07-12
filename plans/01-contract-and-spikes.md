# Stage 01: Contract and spikes

## Goal

Freeze the smallest honest compatibility contract and prove the uncertain app-server behaviors before building the server.

## Work

1. Generate TypeScript and JSON Schema artifacts from the exact supported Codex version.
    - Pass `--experimental` so gated APIs the proxy depends on (`dynamicTools`, `item/tool/call`) are included.
    - Store the version and generation command; do not hand-maintain app-server wire types.
2. Build a protocol mapping table covering `thread/start`, `thread/resume`, `turn/start`, item events, token usage, auth, approvals, dynamic tools, and failures.
3. Define the accepted Chat Completions request subset and OpenAI-shaped error envelope. Classify every other known field as ignored-with-warning or rejected.
4. Define the SSE mapping for role, text, tool-call argument fragments, finish reasons, usage, errors, and `[DONE]`.
5. Define `x_codex` schemas for request policy controls and streamed reasoning/internal activity.
6. Specify response-ID generation and a versioned durable mapping record:
    - response ID, thread ID, turn ID, and status;
    - timestamps, cwd/policy fingerprint, and pending-tool metadata.
7. Spike `account/read` plus `account/login/start` browser flow and fallback behavior.
8. Spike dynamic tools:
    - determine exactly when app-server blocks, what must remain in memory, and how multiple simultaneous calls correlate with later `role: "tool"` messages;
    - determine whether `dynamicTools` can be supplied or changed on `thread/resume`; the protocol reference documents it only on `thread/start`.
9. Spike all app-server web-search settings:
    - verify how `disabled`, `cached`, and `live` map for the supported Codex version;
    - the protocol reference documents no per-turn web-search setting, only `allowedWebSearchModes` in `configRequirements/read`, so treat this mapping as unproven until the spike lands.
10. Spike package ownership of the Codex executable:
    - prefer an official supported npm dependency;
    - document the fallback discovery/install path if no stable distributable contract exists.
11. Spike how to represent multi-role message history on a fresh thread:
    - `turn/start` input accepts only user text/image items with no role concept, so system/developer/assistant/tool history from a stateless client needs `thread/inject_items` (raw Responses API items) or a documented flattening;
    - define the v1 mechanism and what it loses.
12. Define the dynamic-tool suspension lifecycle:
    - registration before the originating HTTP response ends;
    - continuation deadline, timeout response to app-server, and client-visible expiration error;
    - disconnect behavior and cleanup on shutdown;
    - proof of how long a pending `item/tool/call` survives: app-server unloads an idle loaded thread after a no-subscriber/no-activity window and clears pending server-initiated requests on turn start, completion, or interruption (`serverRequest/resolved`), and the continuation deadline must fit inside that proven lifetime.
13. Define the `previous_response_id` resumability preflight and error taxonomy:
    - distinguish unknown mappings, expired mappings, superseded responses, pending-tool continuations, busy threads, archived/deleted threads, corrupt state, policy incompatibility, and `thread/resume` races;
    - none may fall back to `thread/start`.
14. Define branching behavior:
    - a `previous_response_id` that maps to a turn older than its thread's newest completed turn is a branch, not a linear continuation, and `thread/resume` would silently include the later turns;
    - v1 rejects these superseded references with a distinct error;
    - spike whether `thread/fork` with `lastTurnId` (copy history through that turn, drop later turns) faithfully supports branching before promising it in any later version.

## Decisions to record

- Exact app-server version range and executable source.
- Whether non-streaming responses are fully supported or implemented by buffering the same event pipeline.
- Exact `x_codex` delta shapes and finish-reason behavior for internal versus client-defined tools.
- Behavior when a continued request supplies messages inconsistent with persisted thread history.
- Tool-continuation correlation:
    - whether continuations can be correlated by `tool_call_id` alone so an unmodified Chat Completions client can complete the tool loop;
    - or whether `previous_response_id` is a hard requirement that must be documented as a compatibility break.
- How `tool_choice` values other than `auto` behave, given no documented app-server equivalent for forcing or forbidding a tool call.
- Usage semantics:
    - whether app-server exposes cumulative or per-turn usage and how to derive per-response values without estimation;
    - the protocol reference is internally inconsistent: its overview says `turn/completed` carries token usage while its event reference streams usage separately via thread-scoped `thread/tokenUsage/updated`;
    - `thread/resume` replays persisted usage notifications before any new turn, so the attribution rule must ignore restored pre-turn usage.
- Model consistency on continuation:
    - `thread/resume` defaults to the thread's persisted model unless overridden, while Chat Completions requires `model` on every request;
    - whether a differing continuation `model` is honored as a per-turn override or rejected as ambiguous.
- Exact HTTP 409 error code/body for a concurrent request targeting a busy Codex thread. Same-thread requests are rejected immediately; v1 does not queue them.
- Exact OpenAI-shaped status/code mapping for unknown, expired, superseded, and non-resumable `previous_response_id` values, including which failures are retryable.

## Acceptance criteria

- A checked-in contract document distinguishes standard and extended behavior field by field.
- Synthetic fixtures exist for every app-server event type the proxy claims to expose.
- A disposable spike demonstrates text streaming and a two-request dynamic-tool round trip using `gpt-5.4-nano` only.
- A disposable restart spike proves a completed persisted thread can resume.
- Fixtures prove every rejected continuation leaves the response mapping and Codex thread unchanged and never starts a replacement thread.
- Every unresolved behavior has an explicit conservative fallback or blocks the next stage.

## Cost guard

Run at most four live model calls for this stage: text, tool request, tool continuation, and post-restart continuation. All use `gpt-5.4-nano` with small output limits.
