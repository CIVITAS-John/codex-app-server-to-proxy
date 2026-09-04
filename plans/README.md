# Implementation plan

The work is split into gated stages. Complete stages in order unless a stage explicitly calls for a parallel spike. Each stage must leave the repository testable and document unresolved protocol risk.

This directory is the source of truth for product decisions, implementation status, and stage gates. User-facing setup and API behavior live in the [root README](../README.md); repository structure and contributor workflows live in the [repository guide](../docs/development.md).

## Product decisions

- Provide `POST /v1/chat/completions` and `GET /v1/models` to generic HTTP clients.
    - The model route aggregates visible entries from the active authenticated pinned app-server. When installed, the temporary Responses Lite override supplies its frozen catalog; otherwise app-server's ordinary catalog is exposed. It starts no Codex thread or turn; `created: 0` and `owned_by: "openai"` are synthetic compatibility placeholders because app-server has no equivalents. This adds a standard client-discovery route without exposing hidden or full app-server catalog metadata.
- Ship only an npm CLI named `codex-openai-proxy`.
- Bind only to localhost/loopback and require no proxy bearer token.
- Spawn and supervise `codex app-server` as a child process.
- Depend on exact `@openai/codex 0.146.0` for default executable resolution and the generated contract. An explicit `--codex-path` override must report that same version; older and newer executables are rejected until their contracts are reviewed.
- Run the package-owned app-server in the proxy-owned `~/.codex-openai-proxy/codex-home` by default, shared across roots but isolated from the ordinary Codex CLI home. On every startup, `--sync-auth always` adopts `auth.json` from the pre-existing Codex home only when the target is missing or the source is strictly newer; `--sync-auth never` keeps a proxy-only login isolated. These are the only synchronization modes. Allow `--codex-home` to select another directory.
    - This is a breaking default from `0.1.0-rc.4`'s copy-once behavior. Strict-newer comparison prevents an older main-home refresh token from replacing credentials the proxy refreshed more recently, but sharing a single rotating ChatGPT login remains inherently racy.
    - After default synchronization supplied a credential that fails initial `account/read`, successful fresh recovery may use a best-effort strictly-newer guard and atomic replacement to write back to an existing older main-home `auth.json`. It never creates a target or writes back for `never`; this preserves proxy-only compatibility while allowing recovery to heal a stale shared home.
    - The current unversioned proxy home is a reviewed `0.146.0` compatibility decision. The `0.145.0` upgrade keeps proxy-owned persisted filenames and schemas unchanged, preserves unknown model-catalog metadata, and adds no incompatible app-server field used by the proxy. A future Codex pin must repeat that review or adopt an explicit versioned-home or migration decision before release.
- Use persisted Codex threads behind the additive `previous_response_id` continuation field.
- Support text, exposed reasoning, tool calls, tool results, and token usage streaming.
- Support client-defined dynamic tools across multiple HTTP requests. Interrupt the turn at the tool batch and deliver later results by injecting call/output pairs into the persisted thread (decision reversed 2026-07-26; see plans/05).
- Restrict request working directories to the configured root or its descendants. The root defaults to the proxy's launch directory.
- Default to a no-environment `disabled` sandbox, and support explicit `read-only`, `workspace-write`, and `danger-full-access` selections.
- Disable subagent spawning at app-server startup unless the operator explicitly passes `--subagents true`; keep this process-wide control independent of per-request filesystem and web policy.
- Expose each web-search mode the pinned app-server can enforce per request and reject the others.
- Handle approvals non-interactively with `auto_review` where policy permits and decline any unexpected approval request.
- On continuation, require the original tool set, model, reasoning effort, cwd, and policy.
    - The pinned protocol cannot replace dynamic tools on a resumed thread; a changed set is rejected rather than applied approximately or placed on a silent replacement thread.
- Reject message history that cannot be represented faithfully.
- Reject any request value the proxy cannot apply exactly. During v1 development, prefer a clear error over fallback or approximation.
- Ignore harmless unsupported fields and log structured warnings.
- Emit plaintext, unredacted structured logs and treat captures from every log level as sensitive.
- Use TypeScript and Vitest for unit, integration, HTTP/SSE, and packed-CLI tests. Organize test files by responsibility rather than implementation stage, and keep the default Vitest configuration deterministic and offline.
- Group maintained source by CLI, core, app-server, HTTP, and continuation domains, and mirror those domains under `test/` alongside contract, spike, and shared-support folders.
    - Keep `src/bin.ts` as the root executable shim so compilation continues to publish the CLI at `dist/bin.js`; the restructure changes contributor-facing paths but not the package bin contract.
- Use mocks by default and only `gpt-5.6-luna` for opt-in live development tests.
- Bound the serial live suite by 32 deduplicated upstream model responses observed through `rawResponse/completed`, including child threads and restarts. Start filesystem/web coverage with the default-off subagent policy and explicitly enable subagents only for the separate spawn app-server; this is test-process configuration, not a new per-request `x_codex` multi-agent control.
- Reserve an unclaimed npm package name once with an interactive package-owner/2FA publication of the exact tested `0.1.0-rc.0` tarball to `next`; that bootstrap has no OIDC provenance. Publish later candidates through the `main`-only prerelease workflow with trusted publishing. The workflow never moves `latest`.
- Treat npm deprecation and dist-tag changes as interactive package-owner operations protected by 2FA. Trusted-publishing OIDC authority is limited to publication and does not authorize rollback registry mutations.
- Preserve per-root continuation state across uninstall, deprecation, and rollback. A persistence-incompatible release must migrate explicitly or leave the prior compatible package available; package lifecycle actions never delete the store.

## Stage map

| Stage | Outcome | Gate |
| --- | --- | --- |
| [01](01-contract-and-spikes.md) | Offline compatibility contract and risk-reduction fixtures | Offline contract gate passes |
| [02](02-package-and-cli.md) | Installable CLI and loopback HTTP skeleton | Offline CLI tests pass |
| [03](03-app-server-and-auth.md) | Reliable child process, ChatGPT login, and live protocol verification | Fake-server tests and bounded live spike pass |
| [04](04-chat-streaming.md) | Chat request/response and SSE translation | Golden protocol tests pass |
| [05](05-tools-and-threads.md) | Multi-request tools and persisted thread reuse | Continuation/restart tests pass |
| [06](06-policies.md) | Per-request cwd, sandbox, approvals, and web search | Policy matrix tests pass |
| [07](07-quality-and-ci.md) | Security, compatibility, observability, and CI | Release test matrix passes |
| [08](08-packaging-and-release.md) | Publishable npm artifact and release runbook | Packed-install smoke test passes |
| [09](09-thread-continuity.md) | Safe same-thread reuse, native branching, and continuity outcomes | Acceptance matrix, in-place schema v2 migration, and bounded live gate pass |

## Current status

### Implemented locally

Stages 01 through 08 are implemented in the source tree. Stage 08 includes the package metadata, deterministic packed-package smoke, registry-backed smoke workflow, trusted-publishing prerelease workflow, published-user README, changelog, and release runbook. The exact Codex dependency and generated contract remain pinned to `0.146.0`. Stage 09 is planned only; its continuity enum, native branching, in-place schema v2 migration, and one-shot redirect-based fresh fallback are not implemented.

Stage 09 uses one routing table and a shared fresh fallback. Its simplified design keeps five checkpoint states, leaves fork sources unchanged, and replaces tail deduplication with conservative fallback from unresolved checkpoints.

Until Stage 09 is implemented, the cross-stage continuation rules below describe the Stage 08 runtime (including its boolean reuse field and newest-response restriction). [Stage 09](09-thread-continuity.md) is the planned replacement design and is not current product behavior.

The default TypeScript/Vitest configuration is deterministic and offline; opt-in live-test filenames are excluded. The expanded serial live contract retains its existing compatibility scenarios and adds disk-verified `workspace-write` command/file-change coverage, isolated live web search, and an exactly-one-child nonce handoff. It uses only `gpt-5.6-luna` and enforces a hard maximum of 32 deduplicated upstream model responses across parent and child threads; its normal count remains unknown until live calibration. On 2026-07-16, `npm run check` passed 19 files and 155 tests with coverage thresholds, the offline `npm run test:package` and local `--registry-install` mode passed, and the final dry pack contained 51 files at 71,939 bytes packed and 295,941 bytes unpacked.

Local implementation is not evidence that npm, GitHub Actions, or every supported platform accepted the candidate. [Stage 08](08-packaging-and-release.md) records the local acceptance evidence separately from the pending external gates.

### External evidence pending

- The checked-in offline CI matrix still must finish green remotely on Node.js 24 on Linux, macOS, and Windows.
- The dispatch-only registry-backed package smoke still must pass on remote Linux, macOS, and Windows runners; this networked evidence is not part of required offline CI.
- The expanded live contract still awaits an explicitly authorized run under its hard maximum of 32 deduplicated `gpt-5.6-luna` upstream model responses, plus an exact recorded count and calibration of the normal count. Earlier repository notes describe a 2026-07-14 two-scenario run under a prior four-call guard, but they do not record an exact count, commit, or workflow URL and are not Stage 08 release evidence.
- The npm prerelease, registry metadata, integrity, and `next` dist-tag still must be verified after publication. If name reservation requires the documented owner/2FA bootstrap, that first artifact will not have OIDC provenance; the trusted publisher and provenance must be verified with the next candidate.
- Stable publication is intentionally not implemented by the prerelease workflow. A reviewed stable path and accepted prerelease evidence are required before `latest` moves.

No remote CI, live, npm publication, provenance, or stable-promotion check is claimed as passing here. The evidence procedure is [RELEASE.md](../RELEASE.md).

## Cross-stage rules

- Standard Chat Completions fields take precedence over extensions where a faithful mapping exists.
- Request-side additions live under `x_codex` except the agreed continuation field `previous_response_id`. Response-side `reasoning` and `tool_results` are explicitly allowed direct compatibility fields; they are nonstandard Chat Completions fields and must be documented as such.
- A response ID maps to a Codex thread ID in a durable, versioned local store; raw thread IDs are not exposed.
- Supplying `previous_response_id` requires continuation.
    - The proxy must validate the local mapping and confirm that app-server can resume the mapped thread.
    - It rejects any non-resumable reference and never falls back to a new thread.
- Tool-result messages may omit `previous_response_id` when the default implicit-tool-continuation mode can correlate all `tool_call_id` values to exactly one unexpired pending mapping. Operators may disable this mode and require the extension explicitly.
- A `previous_response_id` must reference its thread's newest completed response.
    - Continuing from an older response is a branch; v1 rejects it with a distinct error rather than resuming a thread whose later turns would be silently included.
    - `thread/fork` with `lastTurnId` is the documented mechanism if branching is ever supported.
- One HTTP completion corresponds to one externally visible response; a dynamic-tool turn ends with its response and later results continue on the persisted thread.
- A Codex thread runs at most one active turn.
    - A concurrent request targeting a thread another request owns is rejected immediately with an OpenAI-shaped HTTP 409 conflict.
    - Requests never queue or interleave.
- An `item/tool/call` batch ends its turn immediately; pending tool mappings are durable and expire with normal continuation retention (decision reversed 2026-07-26; see plans/05).
    - Every other server-initiated app-server request must be answered or rejected within the owning HTTP request lifecycle.
- Elicitation is disabled.
    - The proxy does not advertise form-elicitation capability or expose user-input elicitation.
    - It immediately rejects any unexpected elicitation request from app-server.
- Client disconnects must not leak active turns, pending JSON-RPC requests, or child processes.
- No default test invokes a paid model.
- `npm test` runs Vitest in non-watch mode and cannot select opt-in live tests.

## Definition of done

The first release is done when a fresh user can:

- install the npm package and run one command;
- complete ChatGPT browser login;
- stream a `gpt-5.6-luna` chat completion;
- execute a client-defined tool across two HTTP requests;
- continue via `previous_response_id`;
- choose allowed policies;
- receive usage metadata when app-server reports attributable counts;
- restart the proxy and resume a completed thread;
- verify that the listener is unreachable through non-loopback interfaces.
