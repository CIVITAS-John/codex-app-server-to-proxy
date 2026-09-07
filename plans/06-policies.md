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
10. Log failures and diagnostics as plaintext at every level; treat all log captures as sensitive.

## Acceptance criteria

- A policy matrix covers every sandbox × web-search combination, allowed and managed-denied cases, and continuation changes.
- Root equality, valid descendants, sibling paths, prefix lookalikes, symlink escapes, nonexistent paths, files, relative paths, permission-denied paths, and platform-specific paths are tested.
- Network/web-search disabled requests do not silently fall back to live search.
- `danger-full-access` can only be selected explicitly and cannot bypass stricter effective policy.
- Native Windows defaults an unconfigured backend to `unelevated`, preserves explicit backend settings and managed requirements, and fails closed if configuration cannot be resolved. Other platforms receive no Windows override.
- Live policy smoke tests, if required, use `gpt-5.6-luna` and the minimum number of calls.

## Implementation status

**Decision (2026-09-06): default unconfigured native Windows sandboxing to `unelevated`.** The pinned Codex `0.153.4` removed the known-safe-command exemption for restricted filesystem policy without an active Windows sandbox backend. `workspaceWrite` alone does not select that backend, so the proxy's preferred approval policy `never` can reject commands before any `commandExecution` lifecycle item exists. Select `unelevated` only when configuration and managed requirements do not already select a backend; retain operator-selected elevated sandboxing and let Codex enforce managed restrictions. The shared path also covers the isolated live-test home. Compatibility consequence: otherwise-unconfigured Windows requests with explicit filesystem access can execute inside the restricted-token sandbox without administrator setup. The public default remains `disabled`; writable roots, network restrictions, approval policy, and observational output semantics retain their existing contract. Reporting pre-execution policy rejections and diagnosing parallel dynamic-tool dispatch remain separate work.

Resolve `config/read` for the request's canonical cwd before native Windows thread start or resume, so project configuration participates in backend selection. Supply the thread config default only when no backend is selected and managed requirements permit `unelevated`; if they exclude it, leave selection to Codex. Do not persist a Windows setting into the user's config file or apply a process-wide override that would hide a project setting. Configuration-read failures stop the request before thread execution.

Verification (2026-09-06): `npm run check` passed 27 offline test files with 337 passed and 27 skipped tests on Windows. The deterministic contract ceiling was corrected from 18 to 20 turns to include the existing two-turn tool-result/user-suffix scenario; the live ceiling remains 32 provider responses. The explicitly selected `gpt-5.6-luna` filesystem live scenario passed through the real app-server with the unelevated default, verifying completed `commandExecution` and `fileChange` output and the written nonce on disk. Its declared maximum was 32 provider responses; six other live tests were skipped. Sandboxed attempts encountered provider stream disconnection, so the successful verification ran outside the development tool sandbox while retaining the request's `workspace-write` policy. No runtime transcripts were retained.

Stage 06 is complete through the deterministic offline gate. `x_codex` accepts canonical root-bounded `cwd`, the public `disabled`, `read-only`, `workspace-write`, and `danger-full-access` sandbox modes, and all four generated web-search modes (`disabled`, `cached`, `indexed`, and `live`). The safe defaults are the configured root, disabled execution environments, and disabled web search; startup logs expose the latter two without logging the root. `--log-level debug` is the explicit diagnostic opt-in that may include root context.

The proxy reads `configRequirements/read` after initialization when the method is available and enforces sandbox, approval-policy, approval-reviewer, and web-search allowlists. Unknown or unrecognized allowlist entries are skipped; an allowlist with no usable supported value still fails startup. Approval policy remains proxy-owned: it prefers the stricter `never`, falls back only to a managed-allowed supported policy, skips every non-string allowlist entry — including a structured granular approval policy — rather than approximating it, uses `auto_review` when permitted, and sends method-specific declines for every unexpected approval request.

Fresh threads and resumed threads receive canonical cwd, the native sandbox realization, approval, and per-thread `config.web_search` settings. Fresh disabled threads and every disabled turn additionally receive `environments: []`; resume omits that unsupported field and the following turn reapplies it. Every new turn receives explicit cwd, approval, and full sandbox-policy overrides. Continuation records bind the public sandbox selection, so `disabled` and `read-only` cannot cross on continuation even though both use native read-only protection. Managed policy must allow native `read-only` before `disabled` can be selected.

Changing the default from `read-only` to `disabled` is intentionally breaking. Requests that relied on implicit shell or file-read access must opt into `read-only`, and pre-change continuations created without an explicit sandbox must also pass `sandbox: "read-only"` or fail with `continuation_policy_mismatch`.

The pinned generated protocol added the `indexed` web-search mode beyond the earlier checked-in `x_codex` schema. Stage 06 exposes it as a compatibility addition because the same per-thread `config.web_search` mapping applies to every generated mode. Deterministic tests prove exact forwarding and no shared-configuration mutation. No live policy smoke test or model call was run, so actual provider-side search behavior remains an explicit opt-in verification item rather than an offline claim.

**Decision (2026-09-02): subagent capability is process-scoped and default-off.** Every app-server spawn receives explicit false command-line overrides for both Codex multi-agent controls unless the operator opts in with `--subagents true`. The platform-neutral `workspace-write` scenario reads a random fixture through `commandExecution` and writes its nonce through `fileChange`/`apply_patch`, verified on disk; the live `webSearch` scenario uses the same no-agent backend with filesystem access unavailable. A second app-server enables subagents only for the spawn scenario. The compatibility consequence is that read/write and web capability can be enabled independently of child spawning without adding a per-request `x_codex` multi-agent setting. These scenarios remain pending an authorized live run.

Starting `thread/start` with a writable sandbox can mark the selected cwd as trusted in the user's `config.toml`. The README now calls out that side effect prominently; canonical root containment bounds which projects the proxy can cause app-server to trust.

## Post-review hardening

A high-effort review of the offline gate produced follow-up fixes: the continuation store default is derived from the canonical root and lives outside it (under `~/.codex-openai-proxy`, namespaced per root), with startup rejection when a broad root would contain that default; an approval allowlist with no usable policy or reviewer fails at startup instead of as a per-request 400; requests without `x_codex.cwd` no longer re-canonicalize the root per call; and managed requirements are mandatory when installing a live transport. A later prerelease simplification removed logger redaction contexts, so root, state, executable, home, URL, token, and failure details may be present in plaintext logs at any level. Root canonicalization and every root-derived option are resolved at one asynchronous boundary; as a compatibility consequence, an explicit relative `--state-dir` is now resolved against the canonical root rather than retaining a symlinked root spelling. The implicit tool-continuation path is documented as requiring the original `x_codex`.

The continuation store remains schema version 0 because there are no released clients or persisted compatibility guarantees. Only the current `{ version: 0, records }` shape is accepted; migration code was removed, and any other version is left untouched and treated as untrusted.
