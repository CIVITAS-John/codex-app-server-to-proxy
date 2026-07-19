# Changelog

All notable user-facing changes are recorded here. This project follows semantic versioning once a version is published.

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
