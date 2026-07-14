# Repository conventions

## Purpose

This repository builds `codex-openai-proxy`, a localhost-only TypeScript CLI that translates OpenAI Chat Completions requests to `codex app-server`.

## Writing conventions

- Write concise, implementation-oriented Markdown.
- Use sentence case for headings.
- Define a term once and use it consistently. Prefer `app-server`, `Chat Completions`, `Codex thread`, and `proxy`.
- Clearly label nonstandard fields and events as `x_codex` extensions. Never imply that `previous_response_id`, reasoning deltas, or internal tool-result deltas are standard Chat Completions features.
- Use `gpt-5.4-nano` in every live-test command, fixture intended for live use, and development example that could incur model cost.
    - Other model names may appear only when documenting generic client input or protocol history.
- Keep examples safe by default: loopback hosts, `read-only` or `workspace-write`, temporary directories, and no secrets.
- Do not paste access tokens, OAuth callbacks, user home paths, or captured production transcripts into docs or fixtures.
- Update the relevant file in `plans/` when a design decision changes. Record the decision and its compatibility consequence.

## Implementation conventions

- Target Node.js 20+ and strict TypeScript.
- Add a concise documentation comment to every top-level definition in maintained source and test code. Generated artifacts are exempt.
- Add inline comments at important implementation points where security constraints, protocol behavior, lifecycle ordering, or other non-obvious reasoning would otherwise be unclear.
- Keep the public product surface CLI-only. Internal modules should still have narrow interfaces and be independently testable.
- Bind only to validated loopback addresses. Treat any possible non-loopback bind as a release-blocking security defect.
- Spawn app-server without a shell and use structured argument arrays.
- Keep JSON-RPC transport, HTTP translation, event aggregation, thread mapping, and policy validation in separate modules.
- Preserve unknown app-server events in diagnostics, but expose only documented and tested HTTP output.
- Ignore harmless unsupported Chat Completions fields with one structured warning per request. Reject malformed, ambiguous, or unsafe values with OpenAI-shaped errors.
- Never weaken Codex or managed policy. A request may choose among allowed policies but cannot override a stricter effective constraint.
- Omit unavailable token counts; never estimate usage.

## Testing conventions

- Default tests must be deterministic and offline, using recorded synthetic fixtures or a fake app-server.
- Tests must cover partial JSON-RPC frames, interleaved notifications, SSE backpressure, disconnects, duplicate tool results, process exit, and malformed inputs.
- Live tests must be opt-in through an explicit environment flag, run serially, cap output, and use only `gpt-5.4-nano`.
- Never run a live test as part of the default `test` script or pull-request CI.
- Redact login URLs, tokens, filesystem paths, prompts, and tool arguments from snapshots and logs where they could contain sensitive data.
    - A first-run authorization URL may be written once to the interactive terminal as a login fallback, but must not enter structured logs, captured diagnostics, or persisted state.

## Completion standard

A stage is complete only when its acceptance criteria pass, its decisions are reflected in the README and relevant plan, and mocked tests cover both success and failure paths. Any live verification must state its expected maximum number of model calls.
