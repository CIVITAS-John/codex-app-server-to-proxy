# Security model

`codex-openai-proxy` is a single-user, localhost-only process. It has no proxy bearer token and is not a multi-user service boundary. The caller, proxy, and Codex child are expected to run as the same operating-system user.

## Threat model and controls

| Threat | Control and residual risk |
| --- | --- |
| Non-loopback exposure | CLI host parsing accepts only `127.0.0.1`, `::1`, and `localhost`, then binds a normalized loopback address. Any other bind is a release-blocking defect. |
| DNS rebinding or hostile `Host` | Every route accepts only the exact loopback authorities `localhost`, `127.0.0.1`, and `[::1]`, with an optional valid port. Missing, malformed, alias, and non-loopback authorities fail before routing. |
| Browser-originated requests | Any `Origin` header is rejected. Chat Completions additionally requires `Content-Type: application/json`, so browser-simple form posts fail closed. This intentionally does not provide CORS. |
| Oversized or slow input | Declared and streamed bodies share the configured byte limit. Request, tool, startup, and shutdown operations have deadlines; request and app-server ingress concurrency is bounded. |
| Local overload | The HTTP request pool rejects excess requests with 429 `overloaded`. One active turn is permitted per Codex thread. SSE writes honor backpressure, and app-server ingress is bounded by event count and approximate bytes. |
| Log injection | Logs are one JSON object per line, so control characters in plaintext values remain JSON-escaped. Request logs record a parsed path rather than attacker-controlled query data. Logs are not redacted and must be treated as sensitive. |
| Executable substitution | The default executable comes from the exact `@openai/codex` runtime dependency. An explicit override is spawned without a shell and must report the pinned version before app-server starts. |
| Malicious tool names or arguments | Client function names use a restricted character set and length. Internal names are normalized. Arguments/results remain structured, are bounded where exposed diagnostically, and are never interpolated into a shell by the proxy. Codex built-in activity is observational and is not returned to the client for execution. |
| Path disclosure | Plaintext logs may contain filesystem paths, login URLs, tokens, prompts, tool payloads, and raw child stderr at any configured level. Unknown-event diagnostics remain bounded by the per-transport method-count cap. Treat all logs as sensitive; HTTP errors still use stable public summaries. |
| Local multi-user state access | On POSIX platforms, continuation directories and files are tightened to `0700` and `0600`, including pre-existing paths. Unsafe state path types fail closed. Windows tests do not infer ACL guarantees from POSIX mode bits. |
| State tampering | Records contain identifiers, bindings, lifecycle state, expiry, usage boundaries, and full pending dynamic-tool call metadata, including arguments. Writes use a private temporary file and atomic rename; malformed records and foreign schema versions are not trusted. |

## Origin policy

The proxy rejects every request containing an `Origin` header, even if the value names a loopback URL and even on health routes. Native clients should omit `Origin`. This policy is deliberately stricter than ordinary CORS because there is no proxy authentication secret and the listener can invoke a locally authenticated Codex session.

## Data and diagnostics audit

Required CI is offline and uploads only maintained-source coverage. It does not upload app-server transcripts, login output, continuation state, or live-test diagnostics. Synthetic fixtures use placeholder identifiers, loopback addresses, temporary paths, and `gpt-5.6-luna`; they contain no captured production requests.

Structured logs are plaintext and intentionally unredacted. Depending on the event, they may include prompts, message bodies, login URLs, credentials or tokens, cwd, tool names/arguments/results, filesystem paths, and raw child stderr. This applies at every log level; keep captures local and short-lived, and never publish or share them without reviewing their full contents. Continuation state does not retain login URLs or authentication tokens.

`--log-level debug` adds bounded unknown-event context and other detail, but lower levels are still sensitive. The opt-in live suite can make model calls and must not publish its output as a CI artifact.

## Review checklist

Before release:

1. Run `npm ci && npm run check` from a clean tree.
2. Confirm protocol regeneration is clean and coverage excludes generated artifacts.
3. Keep runtime log captures out of fixtures and workflow artifacts; use only synthetic placeholders in checked-in diagnostics and review any capture before sharing.
4. Run the opt-in live suite only with explicit authorization; state the expected eleven `gpt-5.6-luna` calls and twelve-call hard maximum first.
