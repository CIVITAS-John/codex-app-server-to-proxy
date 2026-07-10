# Stage 03: App-server process and authentication

## Goal

Reliably own one initialized app-server child process and complete ChatGPT login when needed.

## Work

1. Resolve the Codex executable from the supported package first and explicit `--codex-path`/PATH fallback second. Validate its version before serving.
2. Spawn without a shell, communicate through newline-delimited JSON-RPC on stdio, and keep stderr separate with redaction.
3. Implement request IDs, response correlation, server-to-client requests, notifications, cancellation, bounded queues, and malformed-line handling.
4. Send `initialize` with stable client metadata and experimental capability opt-in, then send `initialized`.
5. Query account state at startup. If unauthenticated, call `account/login/start` with ChatGPT browser login.
6. Attempt to open the authorization URL using a narrowly scoped platform launcher; always print a safe URL/instruction fallback. Wait for `account/login/completed` and support cancellation/timeout.
7. Mark readiness only after initialization and usable authentication.
8. Define restart policy for unexpected app-server exit: bounded exponential backoff, failure threshold, readiness changes, and failure of in-flight requests.
9. On proxy shutdown, interrupt active turns, reject pending tool continuations, close stdio, then terminate the child after a grace period.

## Acceptance criteria

- A fake app-server verifies initialization ordering, interleaved requests/notifications, overload errors, malformed output, crash loops, and graceful shutdown.
- Auth tests cover already logged in, browser launch success, launcher failure with printed fallback, login failure, cancellation, and timeout.
- Logs redact login URLs/query parameters and credentials.
- No shell interpolation is used for spawning Codex or opening the browser.

