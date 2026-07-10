# Stage 06: Working directory, sandbox, approvals, and web search

## Goal

Expose per-request execution controls without weakening app-server or managed policy.

## Work

1. Require `x_codex.cwd` to be absolute, existing, and a directory. Canonicalize it without restricting it to the proxy launch directory.
2. Map `read-only`, `workspace-write`, and `danger-full-access` to the supported app-server sandbox/permission representation discovered in Stage 01.
3. Never default to `danger-full-access`. Make the safe default explicit and visible in startup logs.
4. Map `disabled`, `cached`, and `live` web search to the current supported Codex setting. Fail closed if the requested distinction cannot be honored.
5. Read effective configuration requirements where available and reject selections disallowed by organization or machine policy.
6. Define approval policy by sandbox mode. Read-only/workspace operations may surface approval requests through `x_codex`; full-access behavior must still respect effective managed policy.
7. Add an approval continuation mechanism only if it can be represented without confusing it with client function tools. Otherwise return a documented terminal error and leave interactive approvals out of v1.
8. Prevent policy changes on a continued response from mutating the historical meaning of prior tool calls. Record and validate effective settings on every response mapping.
9. Redact cwd and command details from default logs; provide opt-in diagnostic verbosity.

## Acceptance criteria

- A policy matrix covers every sandbox × web-search combination, allowed and managed-denied cases, and continuation changes.
- Symlink, nonexistent path, file-as-cwd, relative path, permission-denied, and platform path tests pass.
- Network/web-search disabled requests do not silently fall back to live search.
- `danger-full-access` can only be selected explicitly and cannot bypass stricter effective policy.
- Live policy smoke tests, if required, use `gpt-5.4-nano` and the minimum number of calls.

