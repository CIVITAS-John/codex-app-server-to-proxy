# Changelog

All notable user-facing changes are recorded here. This project follows semantic versioning once a version is published.

## 0.1.0-rc.15 — July 30, 2026

### Changed

- Pins `@openai/codex` to exactly `0.146.0` (previously `0.145.0`), refreshes the experimental app-server TypeScript and JSON Schema contract, and requires `--codex-path` overrides to report the new version.
- Proxy-owned Codex startup temporarily clones `models_cache.json` to a separate `models.no-responses-lite.json` catalog, forces `use_responses_lite: false` for every model, and removes `tool_mode` from originally-Lite models that advertise native parallel-tool support so declared client functions use direct Responses calls. It selects the clone through a marked `model_catalog_json` block. A cache created during first-run setup causes one private app-server restart before readiness; the Codex-owned cache is never edited. The opt-in live contract now requires two independent client tool calls in one batch and refuses to make a model call unless its ephemeral proxy-style Codex home loaded this override.
- **Breaking:** `--sync-auth if-missing` was removed. `--sync-auth` now accepts only `always` (the default newest-wins synchronization) or `never`.
- **Breaking:** The unreleased schema-version-0 continuation store now accepts only the current record shape. Compatibility-only reasoning bindings, duplicate call-ID storage, the legacy pending-record transition, and the unused `corrupt` record state were removed; older prerelease records missing current required data are dropped on load and can produce a one-time continuation error.
- Structured logs are now plaintext at every level and may contain paths, login URLs, tokens, prompts, tool data, or child stderr. Treat log captures as sensitive.
- Unknown managed-policy allowlist entries are skipped, duplicate dynamic-tool call IDs are deduplicated, and exposed internal tool-result values are no longer truncated. The typed `protocol/fixtures/exposed-events.ts` source is now the sole exposed-event corpus.

### Fixed

- Parallel client tools are now collected through direct declared `function_call` raw items and the correlated `rawResponse/completed` boundary before the Codex turn is interrupted. This preserves every call even when app-server serializes its `item/tool/call` callbacks behind the first unanswered request; matching callbacks are deduplicated, and replayed historical call IDs are excluded on continuation. Every fresh thread opts into raw events, and the former timer-based quiet period is gone. Codex 0.145 cannot opt a newly resumed post-restart subscription into raw events; if such a thread issues another dynamic tool, the proxy fails fast with `dynamic_tool_batch_boundary_unavailable` instead of guessing a partial batch.
- A request that replays completed earlier tool rounds and then starts a new turn — a full transcript resent without `previous_response_id`, as clients that restore a saved conversation do — is accepted again instead of failing with `Historical tool results require previous_response_id`. Each earlier assistant tool-call batch is injected into the fresh thread in its declared order, paired only with its immediately following `role: "tool"` outputs, so the model sees the tool round it actually ran. Unanswered calls and outputs no immediately preceding assistant batch requested are dropped and reported once per request as `unpaired_history_tool_items_dropped`; recognized Codex activity is omitted without being classified as unpaired client history.

## 0.1.0-rc.13 — July 29, 2026

### Fixed

- Late dynamic-tool callbacks from an intentionally interrupted turn are now ignored even while the same thread is running its continuation, eliminating false `Dynamic tool correlation mismatch` warnings and request failures. The expected app-server cancellation diagnostic produced by that interrupt is also omitted from proxy logs, and the opt-in live contract now proves the behavior across three consecutive full-history tool-result requests.

## 0.1.0-rc.12 — July 29, 2026

### Fixed

- Third and later full-history tool continuations now correlate only their terminal `role: "tool"` block, so previously completed tool IDs no longer cause `unknown_tool_call_id` or foreign-call errors for the current batch.

## 0.1.0-rc.11 — July 28, 2026

### Fixed

- Client `role: "tool"` outputs are now injected into their continuation without being echoed as observational `tool_calls` or `tool_results`; replayed dynamic-tool lifecycle items are likewise hidden, so a continuation without a newly requested client tool correctly ends with `finish_reason: "stop"`.

## 0.1.0-rc.10 — July 28, 2026

### Fixed

- A successful `finish_reason: "tool_calls"` response no longer logs an app-server `ERROR` line for each tool call. The proxy used to answer the calls its `turn/interrupt` had already cancelled with a JSON-RPC `-32003` "Tool results are delivered via continuation" error; app-server logs any response it cannot match at `ERROR`, which the proxy then surfaced as a warning that read like a routing failure. Cancelled calls are now left unanswered, which is what app-server expects.

## 0.1.0-rc.9 — July 27, 2026

### Added

- `--sync-auth <always|if-missing|never>` controls whether startup tracks credentials from `$CODEX_HOME` or `~/.codex`; the default `always` adopts the source when the target is missing or the source is strictly newer, `if-missing` retains the earlier seed-once behavior, and `never` leaves the proxy's Codex home untouched.
- Successful recovery login uses a best-effort strictly-newer guard and atomic replacement to write back to an existing older main-home `auth.json` when default synchronization had supplied the unusable credential.

### Changed

- **Breaking:** Seeded ChatGPT credentials now track the main Codex home by default instead of being copied only once. A proxy login newer than the source remains authoritative, protecting a refresh token the proxy rotated more recently.

### Fixed

- An `account/read` RPC error such as "refresh token was already used" now triggers one best-effort logout and the existing browser or device-code login pathway instead of ending startup with exit code 1. `/ready` remains 503 until recovery completes.

## 0.1.0-rc.8 — July 26, 2026

### Added

- A request's final message no longer must have role user. A trailing user message stays the turn input; any other trailing message is injected as history and the model continues from it — the continuation-style shape OpenAI-compatible clients such as the Vercel AI SDK send, previously rejected with `invalid_request`.

### Fixed

- An `item/tool/call` that app-server dispatches after its turn was interrupted at a captured batch is now answered with the same "Tool results are delivered via continuation" error as the captured calls, instead of "Dynamic tool correlation mismatch", so app-server stderr after a tool-call response no longer reports what reads as a proxy routing failure.

## 0.1.0-rc.7 — July 26, 2026

### Added

- Pending tool calls survive proxy restarts. The continuation record now persists each call's name and exact arguments, so tool results — matched explicitly by `previous_response_id` or implicitly by `tool_call_id` — continue the thread after a restart instead of failing with 410 `expired_tool_continuation`.

### Fixed

- Responses that end in `finish_reason: "tool_calls"` now return promptly with exact usage, including `completion_tokens_details.reasoning_tokens`. The proxy ends the Codex turn the moment it captures the dynamic tool calls, which makes Codex flush the turn's usage immediately, instead of holding the turn open while usage stayed unreported until a tool result came back. This also reports exact usage for a tool call that is the final desired result and is never continued.
- Token usage is no longer lost across a dynamic-tool round trip. Each response persists the exact boundary its successor counts from, so the tool-call response reports the work up to the call and the continuation counts from there: every token is reported exactly once, never estimated and never double counted — even against a server that fails to flush usage at the interrupt.
- A failed dynamic-tool interrupt no longer returns tool calls that cannot be continued. The pending batch is invalidated and the response fails instead.
- Tool-result injection now persists a non-replayable tombstone before mutating thread history. State-write failures cannot leave an already-applied batch available for duplicate injection, and optional usage/final-state bookkeeping failures no longer retract completed work.
- Duplicate app-server dynamic call IDs now fail before the batch is persisted or exposed.

### Changed

- **Breaking:** Dynamic tool calls end their Codex turn immediately (`turn/interrupt` at the captured batch). Tool results are delivered by injecting `function_call`/`function_call_output` pairs into the persisted thread and starting a new turn, which behaves identically with or without an intervening restart. The turn is no longer resumed in place; observable Codex-side turn boundaries differ, but the Chat Completions request/response flow is unchanged.
- **Breaking:** `--tool-timeout` was removed. No turn is held open awaiting tool results, so no tool deadline exists; pending tool records expire with the normal continuation retention. The flag's secondary role as the app-server startup and first-run login deadline is now a fixed 5 minutes. Legacy pending-tool records written by earlier prereleases expire once on first load.

## 0.1.0-rc.6 — July 25, 2026

### Added

- Replayed assistant messages may carry `reasoning_content` in place of the nonstandard `reasoning` response field. OpenAI-compatible clients such as the Vercel AI SDK write reasoning back under that name, which previously failed the request with `invalid_request` on the replayed message. Both fields are response-only, accepted only as a string on an assistant message, and discarded before history injection.

### Fixed

- Usage is no longer dropped when app-server reports `thread/tokenUsage/updated` after `turn/completed`; the proxy consumes correlated notifications through the thread's `idle` lifecycle boundary. Responses previously omitted `usage` entirely — including `completion_tokens_details.reasoning_tokens` — even though reasoning was streamed.
- Responses that end in `finish_reason: "tool_calls"` now report the usage app-server had already attributed to the suspended turn, emitted after the terminal chunk instead of before it. (Superseded in 0.1.0-rc.7 by ending the turn at the tool-call boundary.)
- Usage now covers every model request behind one response instead of only the most recent one. A turn that ran internal tools, retried, or compacted previously reported the final request alone, which under-reported prompt and completion tokens and could report zero reasoning tokens next to streamed reasoning.
- Recovering usage after a turn completes can no longer fail that turn. An app-server that exits, or an activity queue that overflows, while the proxy waits for trailing usage now ends the wait and still reports the completed response and records its `previous_response_id` mapping, instead of returning an app-server error for work that had already succeeded.

### Changed

- Rejecting a message with unsupported fields now names them (`This message contains unsupported fields: annotations, refusal.`) instead of reporting only the message index.

## 0.1.0-rc.5 — July 24, 2026

### Fixed

- Reasoning that app-server reports only in the completed reasoning item is now emitted instead of dropped. Streamed summary and raw-reasoning deltas are tracked per item, so the completed item contributes only text that was not already streamed.

### Changed

- Documentation and live-test examples use `gpt-5.6-luna`.

## 0.1.0-rc.4 — July 23, 2026

### Added

- `--codex-home <directory>` selects the Codex home used by the spawned app-server.

### Changed

- **Breaking:** The spawned Codex now runs in an isolated, proxy-owned home (`~/.codex-openai-proxy/codex-home` by default) instead of sharing `~/.codex`. This stops differently-versioned Codex installs from clashing over shared caches (for example `models_cache.json` failing to load with `missing field` errors). An existing `~/.codex/auth.json` login is copied into the isolated home on first startup (never overwritten afterwards), so re-authentication is only needed where no login exists. Pass `--codex-home ~/.codex` to restore the previous shared behavior.
- Pins `@openai/codex` to exactly `0.145.0` (previously `0.144.5`); `--codex-path` overrides must report that same version.

## 0.1.0-rc.3 — July 22, 2026

### Added

- A nonstandard `x_codex.sandbox: "disabled"` mode removes the built-in shell and local filesystem access while retaining client-defined tools. It is realized as native `read-only` plus `environments: []` for defense in depth; hosted web search remains controlled independently.
- Pending tool-call deadlines restart whenever an incoming request selects the pending response by `previous_response_id` or matching tool-call IDs.

### Changed

- **Breaking:** The default sandbox is now `disabled`. Clients that relied on implicit `read-only` shell or file access must send `x_codex.sandbox: "read-only"` explicitly.
- **Breaking:** Pre-upgrade continuations created by requests that omitted `x_codex.sandbox` now fail with 409 `continuation_policy_mismatch`; send `x_codex.sandbox: "read-only"` explicitly to continue them.

## 0.1.0-rc.2 — July 19, 2026

### Added

- `reasoning_effort` request support (`none` through `max`), forwarded to Codex and bound to continuations; changing it between a tool call and its results is rejected with `continuation_reasoning_effort_mismatch`.
- Pending tool-call deadlines restart whenever an incoming request selects the pending response by `previous_response_id` or matching tool-call IDs.

### Fixed

- Request timeouts now tear down streaming responses stalled on client backpressure, so slow-reading clients no longer pin concurrency slots.
- Continuation binding hashes use locale-independent key ordering, so persisted continuations survive locale and ICU changes.
- Continuation expiry writes are best-effort during timer and shutdown cleanup, so a full or read-only state disk cannot crash the proxy.
- Malformed app-server JSON-RPC error responses reject the pending request instead of resolving it as success.
- The shared transport no longer emits listener-leak warnings under configured request concurrency.
- Authentication RPCs (`account/read`, `account/login/start`) are bounded by the login deadline, and a transport that closes mid-login fails immediately instead of waiting out the timeout.
- Duration options reject values beyond Node's maximum timer delay, which previously made every deadline fire immediately.
- Home-directory redaction skips a home that is itself a filesystem root, keeping diagnostics readable when `HOME=/`.

## 0.1.0-rc.1 — July 17, 2026

### Release process

- Completed the automated release flow: subsequent candidates publish from CI through npm trusted publishing with OIDC provenance, from the exact tested tarball, with no interactive owner step.

## 0.1.0-rc.0 — July 17, 2026

First prerelease candidate for the localhost-only `codex-openai-proxy` npm CLI.

### Added

- Non-streaming and streaming text Chat Completions through Codex app-server.
- Client-defined function tools, persisted linear thread continuation, exact usage metadata when app-server reports it, and per-request Codex policy selection.
- Nonstandard Codex extensions for top-level `previous_response_id`, request policy under `x_codex`, and direct response `reasoning` and `tool_results` fields.
- Loopback-only HTTP enforcement, bounded recovery and capacity, redacted structured logs, and deterministic offline tests.
- A packed-install smoke test and trusted-publishing prerelease workflow.

### Release process

- If the npm package name has not been reserved, this candidate is published once by an interactive package owner with 2FA from the exact tested tarball, then trusted publishing is configured for subsequent candidates. The bootstrap artifact does not claim OIDC provenance.

### Compatibility

- Requires Node.js 20 or newer.
- Pins `@openai/codex` to exactly `0.144.5`; `--codex-path` overrides must report that same version.
- Implements a focused, text-only Chat Completions subset. It does not implement the Responses API or general OpenAI endpoints.
- Persists version-0 continuation mappings per canonical root under `~/.codex-openai-proxy` by default. Uninstalling the npm package does not remove them.
