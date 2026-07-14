# Stage 03: App-server process and authentication

## Goal

Reliably own one initialized app-server child process and complete ChatGPT login when needed.

## Work

1. Resolve the Codex executable from the supported package first and explicit `--codex-path`/PATH fallback second. Validate its version before serving.
2. Spawn without a shell, communicate through newline-delimited JSON-RPC on stdio, and keep stderr separate with redaction.
    - App-server omits the `"jsonrpc": "2.0"` member on the wire; the transport must tolerate and mirror this rather than assume a strict JSON-RPC library will.
3. Implement request IDs, response correlation, server-to-client requests, notifications, cancellation, bounded queues, and malformed-line handling.
    - Surface app-server `-32001` overload errors as retryable OpenAI-shaped HTTP 429 responses.
4. Send `initialize` with stable client metadata, then send `initialized`.
    - Dynamic tools require the blanket `capabilities.experimentalApi = true` flag; there is no narrower switch.
    - Enabling it allows experimental fields to appear in server-initiated payloads, so generated schemas must be produced with `--experimental` to match.
    - Do not advertise `mcpServerOpenaiFormElicitation` or any user-input elicitation capability.
    - Pick one stable `clientInfo.name` and keep it fixed; app-server forwards it for compliance logging.
5. Query account state at startup. If unauthenticated, call `account/login/start` with ChatGPT browser login.
6. Attempt to open the authorization URL using a narrowly scoped platform launcher.
    - If launching fails, write the authorization URL once to the interactive terminal with instructions; send only a redacted event to structured logs and never persist the URL.
    - Wait for `account/login/completed` and support cancellation/timeout.
    - If local browser login cannot complete, offer `chatgptDeviceCode` login for headless or remote environments.
7. Mark readiness only after initialization and usable authentication.
8. Define restart policy for unexpected app-server exit: bounded exponential backoff, failure threshold, readiness changes, and failure of in-flight requests.
9. On proxy shutdown, interrupt active turns, reject pending tool continuations, close stdio, then terminate the child after a grace period.
10. Fail closed on elicitation.
    - Immediately answer unexpected user-input or elicitation requests with a documented unsupported/declined response so they cannot block a turn.
    - This covers `item/tool/requestUserInput`, `mcpServer/elicitation/request` in both form and URL modes, and equivalent server-initiated requests.
11. Run the opt-in Stage 01 protocol verification against the owned app-server process.
    - Declare expected observations, cleanup, output caps, and maximum calls before execution.
    - Demonstrate text streaming, a two-request dynamic-tool round trip, and post-restart continuation of a completed persisted thread.
    - Verify the pending dynamic-request lifetime and the enforceability of web-search modes; keep any unproven behavior rejected.

## Acceptance criteria

- A fake app-server verifies initialization ordering, interleaved requests/notifications, overload errors, malformed output, crash loops, and graceful shutdown.
- Auth tests cover already logged in, browser launch success, device-code fallback, login failure, cancellation, and timeout.
- Tests prove the fallback authorization URL reaches only the interactive terminal sink while structured logs, diagnostics, and state redact or omit it.
- Elicitation capabilities are absent from initialization and unexpected elicitation requests receive an immediate fail-closed response.
- No shell interpolation is used for spawning Codex or opening the browser.
- The opt-in protocol spike records text, tool round trip, and persisted restart/resume observations using at most four model calls, all with `gpt-5.4-mini` and small output limits.

## Cost guard

The live protocol spike uses at most four calls: text, tool request, tool continuation, and post-restart continuation. All use `gpt-5.4-mini`.

## Implementation status

The offline Stage 03 implementation owns and version-checks a shell-free app-server child, implements bounded newline-delimited request correlation, initialization, authentication, redacted login fallback, fail-closed elicitation, readiness transitions, graceful termination, and three-attempt exponential crash recovery. Version checks and initialization use the configured tool timeout, and any initialization or authentication failure terminates the candidate child before retry or exit. The login completion listener is active before login starts so an immediate completion notification cannot be lost. Mocked tests cover initialization order and timeout cleanup, interleaved messages, overload errors, malformed output, authentication outcomes and immediate completion, cancellation, timeout, terminal-only URL disclosure, and elicitation decline.

The CLI starts app-server before becoming ready and may initiate ChatGPT login. Stage 04 implements `POST /v1/chat/completions`. The isolated `CODEX_PROXY_LIVE=1 npm run test:live:hello` command exercises that route with one `gpt-5.4-mini` call, bounded output, and unconditional cleanup; default tests exclude it.

The one-call `gpt-5.4-mini` hello-world smoke passed through the real HTTP proxy on 2026-07-13. Dynamic-tool round trip, policy enforcement, and persisted restart/resume remain pending.
