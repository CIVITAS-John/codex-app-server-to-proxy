# Repository guide

This guide is for contributors to `codex-openai-proxy`. User installation, API behavior, and `x_codex` extensions belong in the [root README](../README.md). Product decisions, stage gates, and implementation status belong in the [implementation plan](../plans/README.md).

## Requirements

- Node.js 20 or newer
- npm
- A ChatGPT login only for opt-in live tests

Install dependencies and run the complete offline gate:

```sh
npm install
npm run check
```

## Source layout

The maintained TypeScript modules separate the public HTTP contract from app-server details:

| Path | Responsibility |
| --- | --- |
| `src/bin.ts` | Executable entry point and startup failure reporting |
| `src/cli.ts` | CLI lifecycle, authentication, app-server recovery, and shutdown |
| `src/config.ts` | CLI option parsing and loopback/path validation |
| `src/server.ts` | HTTP routing, limits, readiness, and disconnect handling |
| `src/chat.ts` | Chat Completions validation, translation, aggregation, and SSE output |
| `src/app-server.ts` | Child-process ownership and app-server initialization |
| `src/json-rpc.ts` | Newline-delimited JSON-RPC transport |
| `src/auth.ts` | ChatGPT browser and device-code authentication flows |
| `src/state.ts` | Durable response mapping and pending tool coordination |
| `src/continuation.ts` | Continuation-state validation helpers |
| `src/errors.ts` | OpenAI-shaped HTTP errors |
| `src/logger.ts` | Structured stderr logging |

`test/` contains deterministic unit, protocol, HTTP, lifecycle, tool, and continuation coverage. Shared fake backends and typed protocol fixture builders live under `test/support/`.

`protocol/` contains the generated app-server protocol structures consumed by maintained code and tests. Regenerate them with `npm run generate:protocol`; do not hand-edit generated output.

`docs/codex-app-server.md` is a checked-in protocol reference. `plans/` contains the staged implementation record and compatibility decisions.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm start` | Build and run the local proxy |
| `npm run build` | Compile strict TypeScript |
| `npm test` | Build, type-check tests, and run deterministic offline tests |
| `npm run check` | Check formatting, lint, build, and offline tests |
| `npm run format` | Apply Prettier formatting |
| `npm run generate:protocol` | Refresh generated app-server protocol structures |
| `npm run spike:offline` | Run the offline protocol spike |
| `npm run test:live` | Run the opt-in live contract suite |

The default test command excludes `*.live.test.ts` and never makes a model call.

## Live contract tests

The live suite exercises streaming role history, a function-tool round trip, and completed-thread continuation after restarting the proxy and app-server. It runs serially, caps captured diagnostics, uses only `gpt-5.4-mini`, and attempts at most four model calls:

```sh
npm run test:live
```

Running that dedicated command is the explicit opt-in. It uses an existing ChatGPT login when available and otherwise starts the normal interactive or device-code login flow. Set `CODEX_PATH` to target a specific Codex executable.

Transport framing, malformed-frame handling, process failures, and other fault injection remain fake-only because a live app-server cannot provide those cases deterministically.

## Documentation ownership

Keep documentation aligned with its audience:

- Describe installation, OpenAI compatibility, observable behavior, and `x_codex` extensions in `README.md`.
- Record architecture, repository layout, contributor workflows, and testing details under `docs/`.
- Record product decisions, stage status, acceptance gates, and compatibility consequences in `plans/`.

When a design decision changes, update the relevant stage plan as well as any user-facing contract it affects. Always label `previous_response_id`, reasoning deltas, and internal tool-result deltas as `x_codex` extensions rather than standard Chat Completions behavior.
