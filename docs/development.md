# Repository guide

This guide is for contributors to `codex-openai-proxy`. User installation, API behavior, and `x_codex` extensions belong in the [root README](../README.md). Product decisions, stage gates, and implementation status belong in the [implementation plan](../plans/README.md).

## Requirements

- Node.js 20, 22, 24, or 26; Node.js 24 is the primary supported LTS
- npm
- A ChatGPT login only for opt-in live tests

Install dependencies and run the complete offline gate:

```sh
npm install
npm run check
```

## Source layout

The maintained TypeScript modules are grouped by domain so the public HTTP contract remains separate from app-server details:

| Path | Responsibility |
| --- | --- |
| `src/bin.ts` | Root executable shim that preserves the published `dist/bin.js` entry point |
| `src/cli/` | CLI lifecycle, authentication, app-server recovery, and shutdown |
| `src/core/` | CLI configuration, loopback/path validation, and structured logging |
| `src/app-server/` | Child-process ownership, authentication flows, and JSON-RPC transport |
| `src/http/` | HTTP routing, Chat Completions translation, SSE output, and OpenAI-shaped errors |
| `src/continuation/` | Durable response mapping, pending tool coordination, and continuation validation |

`test/` mirrors the maintained source domains under `test/cli/`, `test/core/`, `test/app-server/`, `test/http/`, and `test/continuation/`. Cross-domain protocol contract and offline spike coverage lives under `test/contract/` and `test/spike/`. Shared fake backends, repository-path helpers, and typed protocol fixture builders live under `test/support/`.

`protocol/` contains the generated app-server protocol structures consumed by maintained code and tests. The exact `@openai/codex` dependency in `package.json` is the single version source for default runtime startup, generation, and the checked-in contract metadata. Runtime startup and generation invoke the package-owned JavaScript entry point through the current Node.js executable so it works consistently across supported operating systems; an explicit override remains a directly spawned host executable. Regenerate the artifacts with `npm run generate:protocol` after changing that pin; the command rejects an install/version mismatch, recreates both generated trees, and updates `protocol/VERSION.json`. Do not hand-edit generated output. `npm run check:protocol` seeds and regenerates a temporary protocol root, then compares every generated file and `VERSION.json` with the checked-in tree, so required CI detects removed, added, or changed artifacts without rewriting the workspace or using the network.

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
| `npm run check:protocol` | Regenerate in a temporary root and reject checked-in protocol drift |
| `npm run spike:offline` | Run the offline protocol spike |
| `npm run test:live` | Run the opt-in live contract suite |

The default local test command excludes `*.live.test.ts`, never makes a model call, and enables V8 coverage for maintained `src/` code. Generated protocol files, tests, and the executable shim do not inflate thresholds. Property tests use seed `17072026`, bounded run counts, and checked-in minimal regression examples under `protocol/fixtures/property-regressions.json`.

The protocol cleanliness check seeds a temporary protocol root, regenerates there with the package-owned executable and version pin, compares the complete file set and contents, and removes the temporary root in a `finally` path. It never rewrites checked-in artifacts; `npm run generate:protocol` remains the explicit mutating command.

## Continuous integration

Required CI runs `npm ci` followed by the same `npm run check` command contributors use locally. Linux covers the finite supported Node.js 20, 22, 24, and 26 lines. macOS and Windows cover the primary Node.js 24 LTS. Node.js 20 is retained as the compatibility minimum despite its upstream end of life; new Node.js majors are not automatically supported.

CI sets `CODEX_TEST_COVERAGE` explicitly. The primary Node.js 24 Linux job alone runs coverage and its floors and publishes the offline `coverage/` directory; the other operating-system and Node.js compatibility jobs run the same tests without redundant instrumentation. Omitting the variable locally keeps coverage enabled. Coverage is limited to maintained source and thresholds are based on the Stage 07 baseline. Pull requests never run the live suite.

## Live contract tests

The live suite exercises streaming role history, a function-tool round trip, completed-thread continuation after restarting the proxy and app-server, explicit read-only/disabled-web policy, bounded built-in tool observation, and continuation after that tool information. It runs serially, caps captured diagnostics, uses only `gpt-5.4-mini`, normally makes five model calls, and attempts at most six:

```sh
npm run test:live
```

Running that dedicated command is the explicit local opt-in. It uses an existing ChatGPT login when available and otherwise preserves the normal interactive login fallback in a TTY. The default executable is owned by the pinned npm package. Set `CODEX_PATH` only for an explicit override; it must report the exact pinned contract version.

The checked-in online workflow is manual, serial, protected by the `codex-live-tests` GitHub environment, and fails before dependency installation when `CODEX_ACCESS_TOKEN` is absent. Headless CI suppresses device-code URLs and one-time codes; credentials are never printed. The workflow is optional and never a required pull-request or release gate. Before either live path, state the expected normal total of five `gpt-5.4-mini` calls and the hard maximum of six.

Transport framing, malformed-frame handling, process failures, and other fault injection remain fake-only because a live app-server cannot provide those cases deterministically.

## Documentation ownership

Keep documentation aligned with its audience:

- Describe installation, OpenAI compatibility, observable behavior, and `x_codex` extensions in `README.md`.
- Record architecture, repository layout, contributor workflows, and testing details under `docs/`.
- Record product decisions, stage status, acceptance gates, and compatibility consequences in `plans/`.

When a design decision changes, update the relevant stage plan as well as any user-facing contract it affects. Always label `previous_response_id`, reasoning deltas, and internal tool-result deltas as `x_codex` extensions rather than standard Chat Completions behavior.
