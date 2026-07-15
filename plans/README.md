# Implementation plan

The work is split into gated stages. Complete stages in order unless a stage explicitly calls for a parallel spike. Each stage must leave the repository testable and document unresolved protocol risk.

This directory is the source of truth for product decisions, implementation status, and stage gates. User-facing setup and API behavior live in the [root README](../README.md); repository structure and contributor workflows live in the [repository guide](../docs/development.md).

## Product decisions

- Provide only `POST /v1/chat/completions` to generic HTTP clients.
- Ship only an npm CLI named `codex-openai-proxy`.
- Bind only to localhost/loopback and require no proxy bearer token.
- Spawn and supervise `codex app-server` as a child process.
- Prefer bundling or depending on a supported Codex npm distribution; otherwise discover the executable and provide installation guidance.
- Use persisted Codex threads behind the additive `previous_response_id` continuation field.
- Support text, exposed reasoning, tool calls, tool results, and token usage streaming.
- Support client-defined dynamic tools across multiple HTTP requests. Keep the app-server tool request pending for the short client round trip, as with a locally executed tool.
- Restrict request working directories to the configured root or its descendants. The root defaults to the proxy's launch directory.
- Support `read-only`, `workspace-write`, and explicit `danger-full-access` sandbox selections.
- Expose each web-search mode the pinned app-server can enforce per request and reject the others.
- Handle approvals non-interactively with `auto_review` where policy permits and decline any unexpected approval request.
- On continuation, require the original tool set, model, cwd, and policy.
    - The pinned protocol cannot replace dynamic tools on a resumed thread; a changed set is rejected rather than applied approximately or placed on a silent replacement thread.
- Reject message history that cannot be represented faithfully.
- Reject any request value the proxy cannot apply exactly. During v1 development, prefer a clear error over fallback or approximation.
- Ignore harmless unsupported fields and log structured warnings.
- Use TypeScript and Vitest for unit, integration, HTTP/SSE, and packed-CLI tests. Organize test files by responsibility rather than implementation stage, and keep the default Vitest configuration deterministic and offline.
- Use mocks by default and only `gpt-5.4-mini` for opt-in live development tests.

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

## Current status

Stages 01 through 05 are complete. The deterministic offline gate covers app-server ownership, Chat Completions translation, dynamic-tool lifecycles, continuation validation, restart recovery, atomic state migration, and failure paths. The focused `npm run test:live` contract passed on 2026-07-14 with two scenarios under its four-`gpt-5.4-mini`-turn guard: streaming role history, then a function-tool round trip followed by completed-thread continuation after restarting both the proxy and app-server. The tool round trip itself stayed within its two-call guard. Request policy selection and live policy observations remain Stage 06 work and continue to be rejected rather than approximated. Stage 08 owns packed-tarball installation and bin-shim proof.

Stage 01 and Stage 02 coverage now runs as type-checked TypeScript through Vitest. The files are split by protocol contract, continuation behavior, offline spike, configuration, HTTP server, and CLI lifecycle. The checked-in default configuration selects offline tests and excludes opt-in live-test filenames. This is a development-only compatibility change: it does not alter the Node.js 20+ runtime or the CLI/API contract, but contributors and CI must use the TypeScript and Vitest configurations.

## Cross-stage rules

- Standard Chat Completions fields take precedence over extensions where a faithful mapping exists.
- Request-side additions live under `x_codex` except the agreed continuation field `previous_response_id`. Response-side `reasoning` and `tool_results` are explicitly allowed direct compatibility fields; they are nonstandard Chat Completions fields and must be documented as such.
- A response ID maps to a Codex thread ID in a durable, versioned local store; raw thread IDs are not exposed.
- Supplying `previous_response_id` requires continuation.
    - The proxy must validate the local mapping and confirm that app-server can resume the mapped thread.
    - It rejects any non-resumable reference and never falls back to a new thread.
- Tool-result messages may omit `previous_response_id` when the default implicit-tool-continuation mode can correlate all `tool_call_id` values to exactly one live suspension. Operators may disable this mode and require the extension explicitly.
- A `previous_response_id` must reference its thread's newest completed response.
    - Continuing from an older response is a branch; v1 rejects it with a distinct error rather than resuming a thread whose later turns would be silently included.
    - `thread/fork` with `lastTurnId` is the documented mechanism if branching is ever supported.
- One HTTP completion corresponds to one externally visible response, though a Codex turn may remain suspended while a dynamic tool result is pending.
- A Codex thread runs at most one active turn.
    - A concurrent request targeting a thread with an active turn or suspended dynamic tool call is rejected immediately with an OpenAI-shaped HTTP 409 conflict.
    - Requests never queue or interleave.
- A registered `item/tool/call` request may remain pending for the client tool round trip. The deadline is configurable and defaults to five minutes.
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
- stream a `gpt-5.4-mini` chat completion;
- execute a client-defined tool across two HTTP requests;
- continue via `previous_response_id`;
- choose allowed policies;
- receive usage metadata when app-server reports attributable counts;
- restart the proxy and resume a completed thread;
- verify that the listener is unreachable through non-loopback interfaces.
