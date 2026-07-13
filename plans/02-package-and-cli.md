# Stage 02: Package and CLI foundation

## Goal

Create an installable TypeScript CLI with strict loopback enforcement and no dependency on a live model.

## Work

1. Initialize the npm package, strict application and test TypeScript configurations, formatter, linter, Vitest, build output, and executable `bin` entry.
    - Keep `npm test` non-interactive and offline by default.
    - Use a separate Vitest project or explicit opt-in script for live tests so the default include patterns cannot discover them.
2. Implement `codex-openai-proxy serve` with `--host`, `--port`, `--root`, `--codex-path`, `--tool-timeout`, log level, state-directory, and shutdown options.
    - `--root` defaults to the launch directory.
    - `--tool-timeout` defaults to five minutes.
3. Default to `127.0.0.1`; normalize and allow only `127.0.0.1`, `::1`, and `localhost`. Resolve `localhost` defensively or bind explicit loopback sockets.
4. Refuse wildcard, LAN, DNS, mapped, or ambiguous addresses before opening a socket.
5. Add `GET /health` and `GET /ready`; readiness remains false until app-server initialization and authentication are ready.
6. Add request IDs, bounded body size, timeouts, abort propagation, graceful signal handling, and structured stderr logging.
7. Build OpenAI-shaped JSON errors for invalid JSON, validation failures, unsupported routes, overload, and internal failures.
8. Ensure warnings never enter SSE/JSON response bodies except through documented error events.

## Acceptance criteria

- `npm pack` produces a package whose CLI starts under Node 20.
- Loopback bind tests cover IPv4, IPv6, hostname, wildcard, LAN, and IPv4-mapped edge cases.
- The process shuts down without open handles after signals or startup failures.
- Health/readiness, body limit, timeout, and malformed-request tests pass offline.
- Unit and CLI tests run through Vitest under Node.js 20+.
- No default script starts Codex or makes a network/model call.

## Implementation status

Complete. The package builds a strict TypeScript CLI with an executable npm `bin`, validates loopback hosts before listening, and normalizes `localhost` to `127.0.0.1` without DNS resolution. The offline suite covers IPv4, IPv6, hostname, wildcard, LAN, mapped-address, HTTP error, body-limit, timeout, startup-failure, and signal-shutdown behavior.

`GET /health` reports process liveness. `GET /ready` deliberately remains unavailable until Stage 03 initializes and authenticates app-server. `POST /v1/chat/completions` validates its content type, body bound, and JSON syntax, then returns `app_server_not_ready`; translation begins in Stage 04.

The packed artifact contains only the compiled CLI declarations/source maps, README, and protocol artifacts. No default npm script starts Codex or makes a network or model call.

The Stage 02 coverage is type-checked and runs through Vitest, with files split by configuration, HTTP server, and CLI lifecycle responsibilities. Vitest is a development dependency, and the default non-watch configuration excludes opt-in live-test filenames. 