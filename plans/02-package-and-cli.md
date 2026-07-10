# Stage 02: Package and CLI foundation

## Goal

Create an installable TypeScript CLI with strict loopback enforcement and no dependency on a live model.

## Work

1. Initialize the npm package, strict TypeScript configuration, formatter, linter, unit test runner, build output, and executable `bin` entry.
2. Implement `codex-openai-proxy serve` with `--host`, `--port`, `--codex-path`, log level, state-directory, and shutdown options.
3. Default to `127.0.0.1`; normalize and allow only `127.0.0.1`, `::1`, and `localhost`. Resolve `localhost` defensively or bind explicit loopback sockets.
4. Refuse wildcard, LAN, DNS, mapped, or ambiguous addresses before opening a socket.
5. Add `GET /healthz` and `GET /readyz`; readiness remains false until app-server initialization and authentication are ready.
6. Add request IDs, bounded body size, timeouts, abort propagation, graceful signal handling, and structured stderr logging.
7. Build OpenAI-shaped JSON errors for invalid JSON, validation failures, unsupported routes, overload, and internal failures.
8. Ensure warnings never enter SSE/JSON response bodies except through documented error events.

## Acceptance criteria

- `npm pack` produces a package whose CLI starts under Node 20.
- Loopback bind tests cover IPv4, IPv6, hostname, wildcard, LAN, and IPv4-mapped edge cases.
- The process shuts down without open handles after signals or startup failures.
- Health/readiness, body limit, timeout, and malformed-request tests pass offline.
- No default script starts Codex or makes a network/model call.

