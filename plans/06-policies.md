# Stage 06: Working directory, sandbox, approvals, and web search

## Goal

Expose per-request execution controls without weakening app-server or managed policy.

## Work

1. Canonicalize the configured root and every `x_codex.cwd`. Require cwd to be an existing directory whose resolved path is the root or a descendant.
    - Default the root to the proxy's launch directory and allow an explicit `--root` override.
    - Reject relative paths, sibling paths, prefix lookalikes, and symlink escapes.
2. Map `read-only`, `workspace-write`, and `danger-full-access` to the supported app-server sandbox/permission representation discovered in Stage 01.
3. Never default to `danger-full-access`. Make the safe default explicit and visible in startup logs.
4. Accept each web-search mode that app-server can enforce for the individual request. Reject unsupported modes and never mutate shared configuration to simulate them.
5. Read effective configuration requirements via `configRequirements/read` where available (`allowedSandboxModes`, `allowedApprovalPolicies`, `allowedWebSearchModes`) and reject selections disallowed by organization or machine policy.
6. Use non-interactive `auto_review` where effective policy permits; full access must still respect managed policy.
7. Do not add an approval continuation protocol in v1. Approval activity may be reported as `x_codex` diagnostics, but generic Chat Completions clients cannot answer it.
    - Never leave a server-initiated approval request unanswered. Apply the selected non-interactive reviewer/policy, and immediately decline any unexpected request that still reaches the proxy.
8. Account for the project-trust side effect: `thread/start` with a `cwd` and a writable sandbox marks that project as trusted in the user's `config.toml`.
    - Document it prominently.
    - The configured root boundary limits which directories the proxy can cause app-server to trust.
9. Prevent policy changes on a continued response from mutating the historical meaning of prior tool calls.
    - Record and validate effective settings on every response mapping.
    - `turn/start` config overrides become the default for subsequent turns on the same thread, so set or verify the effective policy explicitly on every turn instead of relying on prior-request state.
10. Redact cwd and command details from default logs; provide opt-in diagnostic verbosity.

## Acceptance criteria

- A policy matrix covers every sandbox × web-search combination, allowed and managed-denied cases, and continuation changes.
- Root equality, valid descendants, sibling paths, prefix lookalikes, symlink escapes, nonexistent paths, files, relative paths, permission-denied paths, and platform-specific paths are tested.
- Network/web-search disabled requests do not silently fall back to live search.
- `danger-full-access` can only be selected explicitly and cannot bypass stricter effective policy.
- Live policy smoke tests, if required, use `gpt-5.4-nano` and the minimum number of calls.
