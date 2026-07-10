# Stage 07: Quality, security, compatibility, and CI

## Goal

Make the proxy predictable under hostile local input, protocol churn, and operational failure.

## Work

1. Create layered test suites: pure translation units, fake app-server integration, HTTP/SSE conformance, packed CLI smoke tests, and opt-in live tests.
2. Run the offline suite across supported Node versions and macOS/Linux/Windows.
3. Add fuzz/property tests for JSON-RPC framing, SSE serialization, tool argument fragmentation, response mapping, and ignored fields.
4. Test slow clients, bounded queues, abort races, app-server overload, child crashes, port conflicts, state corruption, and shutdown during login/tool calls.
5. Threat-model loopback DNS rebinding assumptions, CSRF-like browser requests, oversized bodies, path disclosure, log injection, executable substitution, malicious tool names/arguments, and local multi-user state permissions.
6. Set restrictive state-directory/file permissions where supported and avoid storing message bodies or tool results unless necessary.
7. Add structured event names and request correlation while redacting prompts, credentials, login data, paths, and tool payloads by default.
8. Snapshot generated app-server schemas and fail CI on unexplained protocol drift.
9. Add a compatibility fixture corpus from the official Chat Completions contract without copying sensitive or copyrighted examples.
10. Document known incompatibilities, extension schemas, timeouts, concurrency limits, restart behavior, and troubleshooting.

## Acceptance criteria

- Required CI is entirely offline and deterministic.
- No test or startup path can bind a non-loopback interface.
- Security tests prove body, queue, concurrency, and timeout bounds.
- Logs and persisted state pass a secrets/path review.
- Opt-in live tests declare call counts and hard-code `gpt-5.4-nano`; CI cannot run them accidentally.
- Supported generic HTTP/SSE clients pass the published compatibility examples.

