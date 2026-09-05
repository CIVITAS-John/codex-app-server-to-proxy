# Repository guide

This guide is for contributors to `codex-openai-proxy`. User installation, API behavior, and `x_codex` extensions belong in the [root README](../README.md). Product decisions, stage gates, and implementation status belong in the [implementation plan](../plans/README.md).

## Requirements

- Node.js 20 or newer; Node.js 24 is the primary supported LTS
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
| `npm run models:live` | List the authenticated live Codex model catalog without starting a model turn |
| `npm run test:live` | Run the opt-in live contract suite |

The default local test command excludes `*.live.test.ts`, never makes a model call, and enables V8 coverage for maintained `src/` code. Generated protocol files, tests, and the executable shim do not inflate thresholds. Property tests use seed `17072026`, bounded run counts, and checked-in minimal regression examples under `protocol/fixtures/property-regressions.json`.

The protocol cleanliness check seeds a temporary protocol root, regenerates there with the package-owned executable and version pin, compares the complete file set and contents, and removes the temporary root in a `finally` path. It never rewrites checked-in artifacts; `npm run generate:protocol` remains the explicit mutating command.

`GET /v1/models` is the public compatibility route. It queries the active authenticated pinned app-server, aggregates all `model/list` pages, exposes visible model slugs accepted by Codex, and starts zero Codex threads or turns. When the temporary Responses Lite override is installed, it reflects that frozen catalog; otherwise it reflects app-server's ordinary catalog. The OpenAI-shaped `created: 0` and `owned_by: "openai"` fields are synthetic compatibility placeholders because app-server does not provide them. From a repository checkout, `npm run models:live` remains the hidden/full-metadata diagnostic: add `-- --include-hidden` for hidden entries or `-- --json` for complete metadata. It also starts zero model turns.

## Continuous integration

Required CI runs `npm ci`, then the full `npm run check` on Linux and `npm test` on macOS and Windows. Formatting, linting, and protocol regeneration produce platform-independent results, so they are gated once rather than three times; every platform still builds, type-checks, runs the whole offline suite, and tests the packed CLI. Linux, macOS, and Windows all exercise the primary Node.js 24 LTS. Node.js 20 is the minimum supported line; the `engines` range accepts newer majors, and matrix lines are added as they are validated.

CI sets `CODEX_TEST_COVERAGE` explicitly. The primary Node.js 24 Linux job alone runs coverage and its floors and publishes the offline `coverage/` directory; the other operating-system and Node.js compatibility jobs run the same tests without redundant instrumentation. Omitting the variable locally keeps coverage enabled. Coverage is limited to maintained source and thresholds are based on the Stage 07 baseline. Pull requests never run the live suite.

The recorded floors describe a complete offline run, so they are enforced only where one is possible. Windows skips the POSIX-only fixture, permission, and executable suites and therefore reports coverage without enforcing the floors; `npm run check` is expected to pass there. Treat the Linux coverage job as the authoritative gate.

## Live contract tests

The live suite runs serially with only `gpt-5.6-luna`, caps captured diagnostics, and remains excluded from default tests. In addition to role-history, dynamic-tool, restart (the restart step expects fresh fallback with delivered tool batches), and disabled-capability coverage, its opt-in scenarios exercise a platform-neutral `workspace-write` flow that reads a random fixture through `commandExecution`, writes the same nonce through `fileChange`/`apply_patch`, and verifies the file on disk; a live `webSearch` turn with filesystem and agents unavailable; and exactly one spawned child that returns a nonce to its parent and reaches a completed `agentsStates` entry. If the filesystem turn stops after its successful read without attempting the required write, the test permits one corrective continuation and combines both turns' lifecycle evidence; the suite-wide response ceiling includes that correction. The file/web app-server starts with subagents disabled; the separate spawn app-server starts with them explicitly enabled. This process-level separation proves filesystem access does not imply spawning and adds no per-request `x_codex` multi-agent field.

The hard cost guard is 32 distinct upstream model responses, deduplicated by `(threadId, responseId)` from `rawResponse/completed` across parent and child threads and retained across app-server restarts and both live backends. Here, the provider is the upstream model service used by app-server; one proxy-issued `turn/start` can produce several of these responses around tool calls, and child threads produce their own. The guard interrupts further work at the limit. A spawn run fails rather than undercounting if the app-server does not expose the child thread's raw completion. No expected normal count is stated until an authorized live calibration records one.

```sh
npm run test:live
```

Running that dedicated command is the explicit local opt-in. It uses an existing ChatGPT login when available and otherwise preserves the normal interactive login fallback in a TTY. The default executable is owned by the pinned npm package. Set `CODEX_PATH` only for an explicit override; it must report the exact pinned contract version.

The checked-in online workflow is manual, serial, protected by the `codex-live-tests` GitHub environment, and fails before dependency installation when `CODEX_ACCESS_TOKEN` is absent. Headless CI suppresses device-code URLs and one-time codes; credentials are never printed. The workflow is optional and never a required pull-request or release gate. Before either live path, state the `gpt-5.6-luna` model and the hard maximum of 32 deduplicated upstream model responses; record the normal count only after live calibration.

Transport framing, malformed-frame handling, process failures, and other fault injection remain fake-only because a live app-server cannot provide those cases deterministically.

## Documentation ownership

Keep documentation aligned with its audience:

- Describe installation, OpenAI compatibility, observable behavior, and `x_codex` extensions in `README.md`.
- Record architecture, repository layout, contributor workflows, and testing details under `docs/`.
- Record product decisions, stage status, acceptance gates, and compatibility consequences in `plans/`.

When a design decision changes, update the relevant stage plan as well as any user-facing contract it affects. Always label `previous_response_id`, reasoning deltas, and internal tool-result deltas as `x_codex` extensions rather than standard Chat Completions behavior.
