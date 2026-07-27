# Stage 03: App-server process and authentication

## Goal

Reliably own one initialized app-server child process and complete ChatGPT login when needed.

## Work

1. Resolve the package-owned Codex executable by default, with explicit `--codex-path` override and PATH compatibility fallback. Validate its version before serving.
2. Spawn without a shell, communicate through newline-delimited JSON-RPC on stdio, and keep stderr separate with redaction.
    - App-server omits the `"jsonrpc": "2.0"` member on the wire; the transport must tolerate and mirror this rather than assume a strict JSON-RPC library will.
3. Implement request IDs, response correlation, server-to-client requests, notifications, cancellation, bounded queues, and malformed-line handling.
    - Surface app-server `-32001` overload errors as retryable OpenAI-shaped HTTP 503 responses before HTTP headers are committed.
4. Send `initialize` with stable client metadata, then send `initialized`.
    - Dynamic tools require the blanket `capabilities.experimentalApi = true` flag; there is no narrower switch.
    - Enabling it allows experimental fields to appear in server-initiated payloads, so generated schemas must be produced with `--experimental` to match.
    - Do not advertise `mcpServerOpenaiFormElicitation` or any user-input elicitation capability.
    - Pick one stable `clientInfo.name` and keep it fixed; app-server forwards it for compliance logging.
5. Query account state at startup. If unauthenticated, call `account/login/start` with ChatGPT browser login.
    - Start the package-owned app-server with `CODEX_HOME` set to the proxy-owned home.
    - On every startup, compare an existing Codex `auth.json` with the proxy copy and adopt it only when the target is missing or the source is strictly newer. `--sync-auth if-missing` preserves seed-once compatibility, while `--sync-auth never` leaves a proxy-only login untouched. Treat a missing or unreadable seed as a path-free, non-fatal diagnostic before continuing through normal login.
    - If `account/read` returns an RPC error, attempt one best-effort `account/logout`, run the normal browser or device-code login, and require a usable follow-up `account/read`. Continue to fail startup on transport, timeout, cancellation, or failed recovery.
    - After that recovery only, use a best-effort strictly-newer guard and atomic replacement to write back the recovered proxy credential when default synchronization had pulled the unusable credential and the existing source `auth.json` is older. Never create a missing source, and never write back for `if-missing` or `never`.
6. Attempt to open the authorization URL using a narrowly scoped platform launcher.
    - If launching fails, write the authorization URL once to the interactive terminal with instructions; send only a redacted event to structured logs and never persist the URL.
    - Wait for `account/login/completed` and support cancellation/timeout.
    - If local browser login cannot complete, offer `chatgptDeviceCode` login for headless or remote environments.
7. Mark readiness only after initialization and usable authentication.
8. Define restart policy for unexpected app-server exit: bounded exponential backoff, failure threshold, readiness changes, and failure of in-flight requests.
9. On proxy shutdown, interrupt active turns, close stdio, then terminate the child after a grace period; durable pending tool mappings need no shutdown handling.
10. Fail closed on elicitation.
    - Immediately answer unexpected user-input or elicitation requests with a documented unsupported/declined response so they cannot block a turn.
    - This covers `item/tool/requestUserInput`, `mcpServer/elicitation/request` in both form and URL modes, and equivalent server-initiated requests.
11. Run the opt-in Stage 01 protocol verification against the owned app-server process.
    - Declare expected observations, cleanup, output caps, and maximum calls before execution.
    - Demonstrate text streaming, a two-request dynamic-tool round trip, and post-restart continuation of a completed persisted thread.
    - Verify the pending dynamic-request lifetime and the enforceability of web-search modes; keep any unproven behavior rejected.

## Acceptance criteria

- A fake app-server verifies initialization ordering, interleaved requests/notifications, overload errors, malformed output, crash loops, and graceful shutdown.
- Auth tests cover already logged in, browser launch success, device-code fallback, login failure, refresh-error recovery, failed-logout recovery, failed post-login validation, cancellation, and timeout.
- Codex-home tests cover environment propagation, owner-only POSIX permissions, seed-once compatibility, strict-newer synchronization in both directions, missing-source retention, and path-free seed failure.
- Tests prove the fallback authorization URL reaches only the interactive terminal sink while structured logs, diagnostics, and state redact or omit it.
- Elicitation capabilities are absent from initialization and unexpected elicitation requests receive an immediate fail-closed response.
- No shell interpolation is used for spawning Codex or opening the browser.
- The opt-in protocol spike records text, tool round trip, and persisted restart/resume observations using at most four model calls, all with `gpt-5.6-luna` and small output limits.

## Cost guard

The implemented live HTTP contract attempts at most four model turns: streaming role history, a dynamic-tool turn, its tool-result continuation, and a completed-thread continuation after restart. All use `gpt-5.6-luna`, small output limits, bounded diagnostics, and unconditional cleanup.

## Implementation status

The offline Stage 03 implementation owns and version-checks a shell-free app-server child, implements bounded newline-delimited request correlation, initialization, authentication, redacted login fallback, fail-closed elicitation, readiness transitions, graceful termination, and four-attempt crash recovery after delays of 1, 3, 5, and 10 seconds. Readiness remains false while recovery runs and stays false after exhaustion, so a transient multi-second failure has a bounded 19-second recovery horizon without changing the CLI-only compatibility surface. Version checks and initialization use the configured tool timeout, and any initialization or authentication failure terminates the candidate child before retry or exit. The login completion listener is active before login starts so an immediate completion notification cannot be lost. Mocked tests cover initialization order and timeout cleanup, interleaved messages, overload errors, malformed output, authentication outcomes and immediate completion, cancellation, timeout, terminal-only URL disclosure, elicitation decline, and the deterministic recovery schedule.

The shared JSON-RPC transport permits its bounded request population to subscribe to notifications and close events without emitting the default low-concurrency `EventEmitter` warning. A response containing an `error` member is always treated as failure; malformed error objects are rejected rather than being reinterpreted as a successful response with an absent result.

The CLI starts app-server before becoming ready and may initiate ChatGPT login. Stage 04 implements `POST /v1/chat/completions`. The isolated `npm run test:live` command runs one shared HTTP contract against the real app-server, serially attempts at most four `gpt-5.6-luna` calls, bounds diagnostics, and unconditionally cleans up; default tests run that contract against only a deterministic fake backend.

The proxy declares `@openai/codex` as a runtime dependency and resolves the package's declared `codex` binary. This makes a normal local install self-contained; existing deployments that rely on a global PATH installation continue to work only as a compatibility fallback, while `--codex-path` remains the explicit override.

The spawned app-server uses `~/.codex-openai-proxy/codex-home` by default, shared across proxy roots and isolated from the ordinary Codex CLI home. On every startup, the CLI compares its `auth.json` with `$CODEX_HOME/auth.json` or `~/.codex/auth.json` and adopts only a missing target or strictly newer source. This breaking default replaces `0.1.0-rc.4`'s copy-once behavior so an actively refreshed main Codex login propagates, while the strict comparison protects credentials the proxy refreshed more recently. `--sync-auth if-missing` restores copy-once behavior; `--sync-auth never` supports a proxy-only login. Seed failures contain only a sanitized filesystem error code and fall through to normal authentication. After an initial `account/read` RPC error proves a pulled credential unusable, a successful fresh recovery may use a best-effort strictly-newer guard and atomic replacement to write back to an existing older source `auth.json`; it never creates a source or runs for `if-missing` or `never`. This compatibility consequence lets a recovered shared login heal a stale main home without changing proxy-only or seed-once behavior. Passing `--codex-home ~/.codex` deliberately restores the earlier shared-home behavior.

An RPC error from the initial `account/read` proves the child is responsive but its stored credentials are unusable. The proxy records a content-free warning, attempts one bounded best-effort RPC logout, runs the existing browser or device-code login pathway, and requires a successful authenticated re-read before readiness. Only then may default synchronization perform its reverse write-back using a best-effort newest-wins guard and atomic replacement of an existing older source. Timeout, cancellation, transport closure, and a failed recovery still fail closed. Sharing one rotating ChatGPT refresh token between the ordinary Codex CLI and proxy remains inherently racy; strict-newer synchronization reduces stale-copy failures but cannot make concurrent refreshes safe.

The unversioned proxy home is accepted for the pinned `0.145.0` contract. Before a later Codex pin is released, Stage 03 and the release plan must either record cache-compatibility evidence or choose a versioned-home or explicit migration path.

When `--log-level debug` is enabled, bounded and path-redacted app-server stderr is included directly in the `app_server_stderr` warning instead of producing a placeholder warning followed by a separate debug-detail event. At other log levels, the warning retains its redacted placeholder.

Stage 03 is complete. The focused live contract passed through the real HTTP proxy on 2026-07-14 with two scenarios under the four-turn guard. It observed role-history streaming, a two-request dynamic-tool round trip, and completed-thread continuation after restarting both the proxy and app-server while retaining only the state directory and `previous_response_id`. Policy fields remain rejected until Stage 06 implements and verifies their full enforcement matrix; this preserves the Stage 03 fail-closed compatibility decision.
