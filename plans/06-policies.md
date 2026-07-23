# Stage 06: Working directory, sandbox, approvals, and web search

## Goal

Expose per-request execution controls without weakening app-server or managed policy.

## Work

1. Canonicalize the configured root and every `x_codex.cwd`. Require cwd to be an existing directory whose resolved path is the root or a descendant.
    - Default the root to the proxy's launch directory and allow an explicit `--root` override.
    - Reject relative paths, sibling paths, prefix lookalikes, and symlink escapes.
2. Map public `read-only`, `workspace-write`, and `danger-full-access` selections to the supported native app-server sandbox representation. Realize public `disabled` as native `read-only` plus experimental `environments: []`, so the model has no execution environment while ignored environment selection still fails safe to read-only access.
3. Default to `disabled`, never to a file-capable or full-access mode. Make the safe default explicit and visible in startup logs.
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
- Live policy smoke tests, if required, use `gpt-5.4-mini` and the minimum number of calls.

## Implementation status

Stage 06 is complete through the deterministic offline gate. `x_codex` accepts canonical root-bounded `cwd`, the public `disabled`, `read-only`, `workspace-write`, and `danger-full-access` sandbox modes, and all four generated web-search modes (`disabled`, `cached`, `indexed`, and `live`). The safe defaults are the configured root, disabled execution environments, and disabled web search; startup logs expose the latter two without logging the root. `--log-level debug` is the explicit diagnostic opt-in that may include root context.

The proxy reads `configRequirements/read` after initialization when the method is available and enforces sandbox, approval-policy, approval-reviewer, and web-search allowlists. Approval policy remains proxy-owned: it prefers the stricter `never`, falls back only to a managed-allowed supported policy, uses `auto_review` when permitted, and sends method-specific declines for every unexpected approval request.

Fresh threads and resumed threads receive canonical cwd, the native sandbox realization, approval, and per-thread `config.web_search` settings. Fresh disabled threads and every disabled turn additionally receive `environments: []`; resume omits that unsupported field and the following turn reapplies it. Every new turn receives explicit cwd, approval, and full sandbox-policy overrides. Continuation records bind the public sandbox selection, so `disabled` and `read-only` cannot cross on continuation even though both use native read-only protection. Managed policy must allow native `read-only` before `disabled` can be selected.

Changing the default from `read-only` to `disabled` is intentionally breaking. Requests that relied on implicit shell or file-read access must opt into `read-only`, and pre-change continuations created without an explicit sandbox must also pass `sandbox: "read-only"` or fail with `continuation_policy_mismatch`.

The pinned generated protocol added the `indexed` web-search mode beyond the earlier checked-in `x_codex` schema. Stage 06 exposes it as a compatibility addition because the same per-thread `config.web_search` mapping applies to every generated mode. Deterministic tests prove exact forwarding and no shared-configuration mutation. No live policy smoke test or model call was run, so actual provider-side search behavior remains an explicit opt-in verification item rather than an offline claim.

Starting `thread/start` with a writable sandbox can mark the selected cwd as trusted in the user's `config.toml`. The README now calls out that side effect prominently; canonical root containment bounds which projects the proxy can cause app-server to trust.

## Post-review hardening

A high-effort review of the offline gate produced follow-up fixes: the continuation store default is derived from the canonical root and lives outside it (under `~/.codex-openai-proxy`, namespaced per root), with startup rejection when a broad root would contain that default; an approval allowlist with no usable policy or reviewer fails at startup instead of as a per-request 400; requests without `x_codex.cwd` no longer re-canonicalize the root per call; managed requirements are mandatory when installing a live transport; and each logger binds one redaction context that masks the root, state directory, configured executable, and home in default-visible request, lifecycle, and initial-startup failure summaries while retaining full detail at `debug`. Root canonicalization and every root-derived option are resolved at one asynchronous boundary; as a compatibility consequence, an explicit relative `--state-dir` is now resolved against the canonical root rather than retaining a symlinked root spelling. The implicit tool-continuation path is documented as requiring the original `x_codex`.

The continuation store remains schema version 0 because there are no released clients or persisted compatibility guarantees. Only the current `{ version: 0, records }` shape is accepted; migration code was removed, and any other version is left untouched and treated as untrusted.
