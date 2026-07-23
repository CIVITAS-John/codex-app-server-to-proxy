# Stage 01: Contract and spikes

## Goal

Freeze the smallest honest compatibility contract and prove the uncertain app-server behaviors before building the server.

## Work

Complete contract and schema work offline.

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
7. Specify the expected `account/read` plus `account/login/start` browser flow and fallback behavior for Stage 03 verification.
8. Specify the Stage 03 dynamic-tool spike:
    - verify that an `item/tool/call` request can remain pending for a short client round trip;
    - verify multiple-call correlation and timeout/cleanup behavior;
    - require the canonical tool set to match on continuation because `dynamicTools` is thread-scoped.
9. Define the Stage 03 spike for all app-server web-search settings:
    - verify how `disabled`, `cached`, and `live` map for the supported Codex version;
    - the protocol reference documents no per-turn web-search setting, only `allowedWebSearchModes` in `configRequirements/read`, so treat this mapping as unproven until the spike lands.
    - accept only modes that can be enforced per request; reject the rest and never mutate shared configuration to simulate them.
10. Record the executable-source decision and leave packed-install proof to Stage 08:
    - prefer an official supported npm dependency;
    - document the fallback discovery/install path if no stable distributable contract exists.
11. Determine from the generated protocol how to represent multi-role message history on a fresh thread:
    - `turn/start` input accepts only user text/image items with no role concept, so system/developer/assistant/tool history from a stateless client needs `thread/inject_items` (raw Responses API items) or a documented flattening;
    - define the faithful v1 mapping and reject any message shape that would change role, order, or tool-call semantics.
12. Define the dynamic-tool suspension lifecycle:
    - registration before the originating HTTP response ends;
    - continuation deadline, timeout response to app-server, and client-visible expiration error;
    - disconnect behavior and cleanup on shutdown;
    - proof of how long a pending `item/tool/call` survives: app-server unloads an idle loaded thread after a no-subscriber/no-activity window and clears pending server-initiated requests on turn start, completion, or interruption (`serverRequest/resolved`), and the continuation deadline must fit inside that proven lifetime.
13. Define the `previous_response_id` resumability preflight and error taxonomy:
    - distinguish unknown mappings, expired mappings, superseded responses, pending-tool continuations, busy threads, archived/deleted threads, corrupt state, policy incompatibility, and `thread/resume` races;
    - none may fall back to `thread/start`.
14. Define branching behavior and a later live verification:
    - a `previous_response_id` that maps to a turn older than its thread's newest completed turn is a branch, not a linear continuation, and `thread/resume` would silently include the later turns;
    - v1 rejects these superseded references with a distinct error;
    - spike whether `thread/fork` with `lastTurnId` (copy history through that turn, drop later turns) faithfully supports branching before promising it in any later version.
15. Verify non-interactive approvals:
    - use `auto_review` where effective policy permits;
    - immediately decline any unexpected approval request so a turn cannot hang;
    - treat streamed approval state as `x_codex` diagnostics, not a client approval API.

## Decisions to record

- Exact app-server version range and executable source.
- Whether non-streaming responses are fully supported or implemented by buffering the same event pipeline.
- Exact `x_codex` delta shapes and finish-reason behavior for internal versus client-defined tools.
- Exact error for continued messages inconsistent with persisted history.
- Whether tool continuation requires `previous_response_id` in addition to `tool_call_id`.
- How `tool_choice` values other than `auto` behave, given no documented app-server equivalent for forcing or forbidding a tool call.
- Usage semantics:
    - whether app-server exposes cumulative or per-turn usage and how to derive per-response values without estimation;
    - the protocol reference is internally inconsistent: its overview says `turn/completed` carries token usage while its event reference streams usage separately via thread-scoped `thread/tokenUsage/updated`;
    - `thread/resume` replays persisted usage notifications before any new turn, so the attribution rule must ignore restored pre-turn usage.
- Exact mismatch errors for continuation model, reasoning effort, tool set, cwd, and policy.
- Exact HTTP 409 error code/body for a concurrent request targeting a busy Codex thread. Same-thread requests are rejected immediately; v1 does not queue them.
- Exact OpenAI-shaped status/code mapping for unknown, expired, superseded, and non-resumable `previous_response_id` values, including which failures are retryable.

## Acceptance criteria

- A checked-in contract document distinguishes standard and extended behavior field by field.
- Synthetic fixtures exist for every app-server event type the proxy claims to expose.
- A disposable offline spike exercises text event aggregation, a two-request dynamic-tool round trip, and restart/resume mechanics without a model call.
- Fixtures prove every rejected continuation leaves the response mapping and Codex thread unchanged and never starts a replacement thread.
- Every unsupported or unfaithful mapping has a tested, explicit error.

## Implementation status

Implemented on 2026-07-12:

- Generated experimental TypeScript and JSON Schema artifacts from the exact package-owned Codex version; commands and executable-source decision are recorded in `protocol/VERSION.json`. The contract was refreshed to `codex-cli 0.145.0` on 2026-07-23.
- Froze the request, protocol, SSE, error, usage, tool-suspension, response-ID, and continuation contracts in `protocol/CONTRACT.md`.
- Added schemas for `x_codex` and version 0 durable response mappings.
- Added synthetic exposed-event and rejected-continuation fixtures.
- Added deterministic, type-checked Vitest coverage split between protocol contract, continuation behavior, and offline spike responsibilities. The continuation tests prove that rejections do not mutate state or start a replacement thread.
- Added a zero-model-call disposable offline spike for text streaming, a two-request tool round trip, and restart/resume mechanics.

Stage 01 is complete as an offline contract gate. Browser login/fallback, actual dynamic-request lifetime, per-request web-search enforcement, persisted app-server restart, and branching fidelity remain unproven. The compatibility contract rejects or withholds these behaviors until the Stage 03 opt-in live spike records the expected observation, cleanup, output cap, and call count within its four-call guard.
