# Stage 07: Quality, security, compatibility, and CI

## Goal

Make the proxy predictable under hostile local input, protocol churn, and operational failure, with a deterministic offline release gate and a separately authorized live compatibility gate.

## Implemented baseline

1. Vitest is the sole maintained test runner. `npm test` builds the source, type-checks maintained tests, and invokes `vitest run` once in non-watch mode.
    - `vitest.config.js` selects all offline `*.test.ts` files and excludes `*.live.test.ts`.
    - `vitest.live.config.js` selects only live tests and runs them serially with one worker.
    - The fake and real app-server backends share the Chat Completions contract in `test/support/chat-contract.ts`. Fault injection remains fake-only.
    - `test/support/protocol-fixtures.ts` type-checks maintained client requests, client notifications, server requests, server notifications, and method-specific responses against generated structures and builds complete nested `Thread` and `Turn` values.
2. The deterministic suites already cover the main implemented contract and many failure paths:
    - partial JSON-RPC frames, interleaved notifications and responses, malformed frames and error objects, overload errors, intentional concurrent listener fanout, and transport closure;
    - streaming and aggregate Chat Completions output, exact usage when reported, dynamic tools, built-in Codex activity normalization, and continuation/restart behavior;
    - body and request timeouts, Host-header validation, client disconnects, stalled-client backpressure and slot recovery, ingress-queue overflow, late SSE failures, duplicate tool results, tool timeouts, lifecycle persistence failures, same-thread concurrency rejection, resume races, state corruption, and atomic-write rollback;
    - unsafe bind rejection, app-server initialization failure, elicitation fail-closed behavior, authentication cancellation, and basic signal shutdown; and
    - the full offline sandbox × web-search policy matrix, managed denials, canonical cwd enforcement, and fresh/resumed request forwarding.
3. Structured event names and HTTP request IDs are implemented. Failure summaries and diagnostics are plaintext and unredacted at every level, so all log captures are sensitive.
4. New continuation state directories and files request `0700` and `0600` modes, respectively. Persisted records contain identifiers, bindings, lifecycle state, optional usage boundaries, and full pending-call metadata including tool arguments.
5. Generated protocol artifacts, the generated-type-checked exposed-event corpus, the root README, the repository guide, and the protocol contract are checked in. Required CI regenerates both protocol trees and compares their complete file sets and contents with the reviewed baseline.
6. The exact `@openai/codex 0.146.0` runtime dependency is the single Codex version source. Default startup and protocol generation resolve its declared JavaScript entry point and invoke it through the current Node.js runtime so the package-owned path works cross-platform. Explicit overrides are spawned directly without a shell and must be executable on the host while reporting the same version. Regeneration recreates both output trees, and `protocol/VERSION.json` records the package pin. This intentionally rejects older or newer Codex executables until their generated contract has been reviewed and checked in.

## Implemented scope

All implementation items below are now represented in the source tree and deterministic offline gate. The final local Node.js 20.19.1 verification passed 21 files and 196 tests with 82.68% statements, 80.91% branches, 86.98% functions, and 85.43% lines. The expanded live contract remains opt-in and was not executed as part of this implementation run; its normal provider-response count awaits calibration.

1. Add checked-in CI with two explicit modes.
    - Define a finite runtime support policy and align `engines`, the README, and CI. Exercise the minimum Node.js 20 line, every retained LTS line, and the current release on Linux; exercise the primary supported LTS on macOS and Windows. Deduplicate overlapping versions rather than creating an unbounded `20+` matrix.
    - Required pull-request and release CI is deterministic and offline. Run `npm ci` and `npm run check` using the checked-in default Vitest configuration.
    - Type-check both Vitest configuration files. Keep packed-tarball installation and npm bin-shim smoke testing in Stage 08.
2. Close the remaining deterministic failure-path gaps.
    - Add a real slow-client/SSE backpressure test that proves bounded buffering and ordered drain behavior.
    - Assert the HTTP 429 `overloaded` rejection when `maxRequests` is reached; the existing `maxRequests: 1` test proves only that a disconnect releases capacity.
    - Drive a real unexpected child exit through CLI recovery; the current test pins only the retry-delay schedule constant.
    - Assert bind-time port-conflict failure, shutdown during an in-flight login, and signal-driven shutdown after an interrupted dynamic tool call whose captured requests were already answered.
    - Preserve existing coverage for request-body, ingress-queue, per-thread concurrency, request, tool, login, startup, and shutdown bounds.
3. Add bounded property tests for JSON-RPC framing, SSE serialization, fragmented dynamic-tool arguments, response aggregation, ignored Chat Completions fields, and canonical binding material. Use deterministic seeds in required CI and retain minimal failing cases as regression fixtures.
4. Expand the opt-in live contract without duplicating the offline matrix.
    - Replace the Stage 03-specific `stage03Live` switch and the stale `test:live:hello` script alias with named scenario selection so the live suite can state exactly which compatibility claims it verifies.
    - Pass the authenticated app-server's actual managed requirements into the live proxy instead of substituting unrestricted requirements.
    - Start the live app-server through the same package-owned executable resolution as the runtime, keeping `CODEX_PATH` as an explicit override. The live backend currently defaults to a bare `codex` on `PATH` while its documentation claims package ownership.
    - Allocate one ephemeral root and one external state directory for the live suite, reuse both across proxy/app-server restarts so cwd and continuation bindings remain stable, expose the canonical root to contract scenarios, and remove both paths during suite cleanup.
    - Retry recursive live-suite cleanup for a bounded interval when Windows reports a just-released app-server working directory as `EBUSY` or `EPERM`; cleanup failure after that bound still fails the suite.
    - Define high reasoning effort and the requested sandbox/web modes as live prerequisites. If the selected model or managed requirements disallow a value, report the unsupported prerequisite before starting provider work rather than weakening policy or substituting a different mode.
    - Add one serial, platform-neutral `gpt-5.6-luna` scenario using `workspace-write` in the ephemeral test root. Pre-seed a random nonce, require `commandExecution` to read it, require `fileChange`/`apply_patch` to write the same nonce to a separate root-bounded path, and verify the resulting file on disk as well as the correlated observational `tool_calls` and terminal `tool_results`. This is already-executed Codex activity and must not produce `finish_reason: "tool_calls"` or a client `role: "tool"` reply.
    - Add one live `webSearch` scenario with `x_codex.web_search: "live"`; assert the web-search lifecycle rather than nondeterministic answer prose. Run it with filesystem environments unavailable and agents disabled.
    - Add one exactly-one-child scenario. Require a single `spawnAgent`, a completed `agentsStates` entry, a random nonce returned from child to parent, and at least one child-thread `rawResponse/completed`. Reject any additional built-in activity and fail the scenario if child raw completions are unavailable.
    - Use two isolated live backends. The filesystem/web app-server uses the proxy's default-off subagent arguments; the spawn-only app-server explicitly enables them. This process-level split proves filesystem access does not imply spawning and deliberately adds no per-request `x_codex` multi-agent field.
    - Add one default-policy `gpt-5.6-luna` scenario that asks to run the bounded observation command and proves the `disabled` sandbox completes as pure chat: no built-in tool calls or results are exposed, and the observation token is absent.
    - Keep exact policy mapping and denial coverage offline. The live scenario proves that one safe explicit policy reaches and works with the real app-server; it must not claim that one model call validates every sandbox or web-search mode.
    - The client-defined tool scenario first requires two independent calls in one parallel batch, replays the complete transcript through three consecutive `role: "tool"` result requests, then resumes the completed response after restart. Across all scenarios, enforce a suite-wide hard maximum of 24 distinct `(threadId, responseId)` pairs from `rawResponse/completed`, counted globally across parent and child threads, app-server restarts, and both live backends. Interrupt further work at the limit. Do not publish a normal count until an authorized live calibration establishes it.
    - Retain the former built-in continuation and fresh-replay behavior as deterministic offline coverage. It is no longer a registered live scenario and therefore has no separate live provider-response allowance.
5. Complete the security review and permission hardening.
    - Record the threat model for loopback DNS rebinding, hostile or missing Host headers, browser-originated form requests, oversized bodies, log injection, executable substitution, malicious tool names and arguments, path disclosure, and local multi-user state access.
    - Decide and document the Origin policy. Preserve JSON-only Chat Completions POSTs and exact loopback authorities so browser-simple form requests and non-loopback aliases fail closed.
    - Tighten or reject pre-existing state directories/files with permissive modes where the platform supports it, then assert resulting permissions without making Windows tests depend on POSIX mode bits.
    - Keep runtime log captures out of snapshots, fixtures, and CI artifacts. Logs at every level may contain prompts, credentials, login URLs, filesystem paths, and tool payloads; use synthetic diagnostics in the repository.
6. Make protocol drift visible and reproducible.
    - Add an offline clean-tree comparison that fails on unexplained generated protocol changes.
    - Type-check the authoritative `protocol/fixtures/exposed-events.ts` corpus against generated protocol types, including complete nested values, instead of maintaining duplicate JSON and JSONL copies.
    - Add shared typed builders for maintained fake client requests, server requests, responses, and notifications. Validate every fake app-server message against the applicable generated union or method-specific generated type; the existing notification and `Turn` helpers are only the starting point.
    - Reconcile the maintained schema-version-0 continuation store with the stale version-1 `response-mapping.schema.json` documentation. Beyond the version constant, the documented record shape — `turnId`, `updatedAt`, a `fingerprint` object, and a different status enum — no longer matches the persisted record, and the store already treats the documented version 1 as untrusted.
    - Preserve unknown app-server events in bounded plaintext diagnostics as documented. Record the method name and parameter keys once per transport under the fixed distinct-method cap; log child stderr lines plainly.
7. Cover generic-client compatibility against the deterministic fake backend. Reduced 2026-07-30 to the one case a non-`fetch` client exercises differently — consuming chunked SSE through Node's own streaming client. The proxy cannot distinguish HTTP clients, so a `curl` subprocess case only tested `curl` while adding a CI dependency on it being present on all three runners.
8. Finish user and contributor documentation for known incompatibilities, `x_codex` extension schemas, Host-header behavior, body/concurrency/time limits, overload and restart behavior, troubleshooting, protocol refresh, CI modes, and live-test authorization.
9. Publish Vitest coverage for offline suites. Record the baseline before setting thresholds, then enforce thresholds without allowing the runner migration or generated files to disguise lost maintained-code coverage.

## Acceptance criteria

- Required CI is deterministic and offline across the supported Node.js and operating-system matrix. Online CI is optional, explicitly authorized, serial, and never a prerequisite for ordinary pull requests.
- `npm test` invokes Vitest once in non-watch mode, excludes live tests, and required CI uses that same checked-in configuration.
- No startup path accepts a non-loopback bind, and every HTTP route rejects non-loopback or malformed Host authorities.
- Deterministic security tests prove body, queue, concurrency, timeout, disconnect, backpressure, process-failure, and shutdown bounds.
- Elicitation is absent from advertised capabilities, and injected elicitation requests fail closed without leaving an app-server request pending.
- Runtime logs are treated as sensitive and excluded from fixtures and CI artifacts; checked-in synthetic artifacts pass the secrets/path review, and state permission tests pass on supported POSIX platforms.
- Runtime and generated protocol versions agree, checked-in schemas regenerate cleanly, and every maintained fake app-server message type-checks against generated protocol structures.
- Opt-in live tests run only through the explicitly selected serial configuration, hard-code `gpt-5.6-luna`, and enforce a 24-response hard maximum by deduplicating `(threadId, responseId)` pairs from `rawResponse/completed` globally across parent/child threads, restarts, and both isolated backends. They retain role-history, parallel client-tool, tool-result continuation, restart, and disabled-execution coverage, and add a platform-neutral disk-verified `workspace-write` command/file-change turn, live web-search lifecycle with filesystem and agents unavailable, and exactly one spawned child with completed nonce handoff. Child raw completion is mandatory. The normal count remains unclaimed pending live calibration.
- The role-history live scenario uses two fresh requests: it captures nonstandard streamed reasoning plus assistant text from the first, replays both fields with the original role history and a second user message, and verifies that the response-only reasoning field is accepted but never forwarded as app-server history.
- Published compatibility examples pass through the fake backend with generic HTTP/SSE clients.
- Offline coverage is published from a recorded baseline and meets the adopted thresholds.

## Decisions and stage boundary

Vitest remains the sole runner for maintained automated suites. The default configuration is the required offline gate; the dedicated live configuration is a separately authorized compatibility smoke and never substitutes for deterministic fault coverage.

The runtime policy enforces a lower bound only: `engines` is `>=20`, so Node.js 20 is the minimum compatibility line and newer majors are accepted without an upper cap. CI exercises the primary Node.js 24 LTS on Linux, macOS, and Windows; the matrix gains lines as they are validated but does not bound what the package accepts.

Required property tests use deterministic seed `17072026` and bounded runs. Minimal regression values are checked in separately from generated protocol artifacts. Coverage measures maintained `src/` TypeScript only, excludes the executable shim, and publishes text, JSON summary, and LCOV output from the primary Linux Node.js 24 job. CI explicitly disables coverage on compatibility-matrix jobs; default local tests keep it enabled.

The recorded Stage 07 offline baseline on Node.js 20.19.1 is 80.49% statements, 79.13% branches, 83.58% functions, and 83.30% lines across maintained source. Adopted global floors are 80% statements, 79% branches, 83% functions, and 83% lines. CLI subprocess tests do not contribute in-process V8 coverage, but `src/cli/cli.ts` remains included so that limitation cannot inflate the maintained-source result.

The HTTP Origin policy is fail-closed: every request carrying `Origin` is rejected, including health routes. This complements exact loopback `Host` validation and the JSON-only Chat Completions media type; the proxy does not implement CORS.

Continuation persistence remains schema version 0 until the format is released. `protocol/schemas/response-mapping.schema.json` now documents the actual wrapper and flattened records rather than the abandoned version-1 draft, so version 1 remains untrusted by design.

Required CI seeds a temporary protocol root, regenerates there from the package-owned executable, compares the complete TypeScript tree, JSON Schema tree, and version metadata with the checked-in snapshot, and cleans up in a `finally` path. The cleanliness gate is non-destructive; only the explicit generation command writes checked-in artifacts. The typed exposed-event source is the single authoritative compatibility corpus.

The manual live workflow fails before installation when `CODEX_ACCESS_TOKEN` is absent and never echoes credentials. Headless live authentication suppresses device-code URLs and one-time codes, while local TTY runs preserve the interactive fallback.

Codex built-in tools are observational, already-executed activity. Their function-shaped `tool_calls` and nonstandard direct `tool_results` remain distinct from client-defined dynamic tools, which alone suspend with `finish_reason: "tool_calls"` and require a later `role: "tool"` request.

The filesystem live smoke is platform-neutral: compatibility is asserted from root-bounded `commandExecution` and `fileChange` lifecycle data plus the exact nonce found on disk, not from a POSIX-specific displayed command spelling or assistant prose. Web-search compatibility is likewise the observed `webSearch` lifecycle, not answer wording. Multi-agent coverage is process-scoped and spawn-only; it does not change the public `x_codex` schema.

Stage 07 owns source-tree quality, security, compatibility, schema-drift, coverage, and CI gates. Stage 08 owns `npm pack`, clean packed installation, and proof through the generated npm bin shim.
