# Changelog

All notable user-facing changes are recorded here. This project follows semantic versioning once a version is published.

## 0.1.0-rc.0 — pending publication

First prerelease candidate for the localhost-only `codex-openai-proxy` npm CLI.

### Added

- Non-streaming and streaming text Chat Completions through Codex app-server.
- Client-defined function tools, persisted linear thread continuation, exact usage metadata when app-server reports it, and per-request Codex policy selection.
- Nonstandard Codex extensions for top-level `previous_response_id`, request policy under `x_codex`, and direct response `reasoning` and `tool_results` fields.
- Loopback-only HTTP enforcement, bounded recovery and capacity, redacted structured logs, and deterministic offline tests.
- A packed-install smoke test and trusted-publishing prerelease workflow.

### Release process

- If the npm package name has not been reserved, this candidate is published once by an interactive package owner with 2FA from the exact tested tarball, then trusted publishing is configured for subsequent candidates. The bootstrap artifact does not claim OIDC provenance.

### Compatibility

- Requires Node.js 20 or newer.
- Pins `@openai/codex` to exactly `0.144.5`; `--codex-path` overrides must report that same version.
- Implements a focused, text-only Chat Completions subset. It does not implement the Responses API or general OpenAI endpoints.
- Persists version-0 continuation mappings per canonical root under `~/.codex-openai-proxy` by default. Uninstalling the npm package does not remove them.

Replace “pending publication” with the publication date after registry verification. For an OIDC candidate, provenance verification is also required; for the one-time manual bootstrap, record the documented provenance exception instead.
