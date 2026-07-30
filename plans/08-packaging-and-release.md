# Stage 08: Packaging and release

## Goal

Publish a reproducible npm CLI that a clean machine can install without cloning the repository and drive through the generated npm bin shim.

## Release decisions

- The first candidate is `codex-openai-proxy@0.1.0-rc.0`, intended for the npm `next` dist-tag. The stable `latest` tag is not part of the prerelease workflow.
- npm trusted publishing cannot be configured until the package exists. If `codex-openai-proxy` is still unclaimed, the first `0.1.0-rc.0` publication is a one-time bootstrap: an npm package owner authenticated interactively with 2FA publishes the exact locally tested tarball to `next`, records the exception and artifact evidence, and then configures the trusted publisher. This bootstrap is not OIDC publication and has no workflow provenance.
- Every candidate after the name-reserving bootstrap uses the `main`-only **Publish npm prerelease** workflow with npm trusted publishing. The workflow runs the full offline matrix, creates and validates the RC commit, publishes the exact tested tarball to `next` with provenance, tags it, and advances `main`. It never rebuilds at publication time or publishes to `latest`. Release evidence records both the dispatch commit named by provenance and its workflow-generated tagged child.
- Publish recovery is conservative: failures before the tag push leave remote refs unchanged; after a failed publish command, the workflow removes the tag only when npm confirms the version is absent. If npm accepted the version but `main` was not updated, the tagged commit must be landed before another dispatch.
- Runtime support remains Node.js 20 or newer. The retained offline matrix is Node.js 24 on Linux, macOS, and Windows.
- The exact `@openai/codex 0.146.0` runtime dependency owns default executable resolution and the generated app-server contract. An explicit `--codex-path` override must report the same version. Older and newer Codex executables are rejected until their generated contracts are reviewed and checked in.
- The app-server defaults to the proxy-owned `~/.codex-openai-proxy/codex-home`, shared across roots but isolated from the ordinary Codex CLI home. Every startup adopts `auth.json` from the ordinary Codex home only when the target is missing or the source is strictly newer; `--sync-auth if-missing` preserves the earlier copy-once behavior, `--sync-auth never` supports a proxy-only login, and `--codex-home ~/.codex` restores the earlier shared-home behavior. After default synchronization supplied a credential that fails initial `account/read`, a successful fresh recovery may use a best-effort strictly-newer guard and atomic replacement to write back to an existing older ordinary-home `auth.json`; it never creates a target or runs for `if-missing` or `never`. This is a breaking default from `0.1.0-rc.4`, and sharing one rotating ChatGPT login remains racy even with strict-newer synchronization.
- The unversioned proxy home is accepted for the reviewed `0.146.0` contract. The `0.145.0` to `0.146.0` upgrade leaves proxy-owned persisted filenames and schemas unchanged, preserves unknown model-catalog metadata, and changes only additive or unrelated generated app-server fields, so no home migration is required. A future Codex upgrade must repeat this compatibility review or ship an explicit versioned-home or migration decision before publication.
- The npm artifact is limited to `dist`, `README.md`, `LICENSE`, `protocol/schemas`, and `protocol/VERSION.json`. Generated protocol TypeScript, tests, fixtures, coverage, plans, scripts, workflows, and local proxy state are not published.
- Package installation has no proxy install hook. `prepack` builds the publisher's artifact, but installing it never starts Codex, performs login, or invokes the proxy.
- Removing or deprecating a package version must not delete `~/.codex-openai-proxy`, a custom `--state-dir`, or a custom `--codex-home`. Persisted mappings and proxy-owned login data remain available to a compatible installed version; an incompatible replacement must provide an explicit migration or refuse the store without rewriting it.

These decisions make the prerelease intentionally narrow: users get a reproducible package and pinned protocol, while a Codex upgrade, stable npm promotion, or persistence-format change requires a new reviewed release decision.

## Implemented in the source tree

- npm metadata identifies the repository, homepage, issue tracker, author, MIT license, prerelease version, supported Node.js range, CLI bin, and exact Codex runtime dependency.
- The package allow-list excludes source-only generated protocol trees and retains the request-extension and continuation-state JSON Schemas referenced by the published README.
- `--version` reports the package version, and `--help` succeeds before or after `serve`.
- Startup failures retain actionable categories for invalid hosts, unavailable ports, incompatible Codex overrides, authentication failures, and denied managed policy while default logs redact sensitive paths and login data.
- The package-owned app-server runs with the configured isolated Codex home. Best-effort newest-wins auth synchronization, including recovery-only reverse write-back, logs only a sanitized error code on failure, so an arbitrary source `CODEX_HOME` cannot enter structured logs. An RPC-reported unusable login follows one bounded logout and browser/device-code recovery attempt before startup fails closed; reverse write-back occurs only after the authenticated re-read and skips a missing or already-newer source credential at its guard check.
- The deterministic packed-package smoke builds one fresh tarball, seeds an isolated npm cache from the exact Codex packages installed by `npm ci`, installs the proxy tarball in npm offline mode with lifecycle scripts disabled, invokes the generated bin shim, checks package contents and metadata, and uses a local fake Codex executable. It performs no registry request, live model call, proxy login, or non-loopback runtime request. The default cleans the tarball; `--retain` preserves it only after the smoke passes.
- A separate `--registry-install` mode starts with an isolated empty cache, installs the exact runtime and current-platform Codex packages from npm, validates their versions, and runs the same smoke. Its dispatch-only Linux/macOS/Windows workflow is external registry evidence, not part of required offline CI.
- The prerelease workflow is complete. It enforces the release decisions above, supports a no-mutation dry run, retains the tested tarball for 14 days, and emits actionable recovery instructions at each remote failure boundary.
- The published-user README now starts with the `npx ...@next` path, documents exact Codex override compatibility, preserves curl and tool-continuation guidance, labels every Codex-specific field as nonstandard, and explains uninstall plus per-root state cleanup.
- [RELEASE.md](../RELEASE.md) is the operator checklist and rollback runbook. [CHANGELOG.md](../CHANGELOG.md) records release status.

## Local evidence from 2026-07-16

- `npm run check` passed 19 offline test files and 155 tests with all coverage thresholds satisfied.
- `npm run test:package` passed the fresh-tarball install, generated-bin version/help/start, health/readiness, and one synthetic Chat Completions response with zero model calls.
- `npm pack --dry-run --json --ignore-scripts` reported exactly 51 files, 71,939 bytes packed, and 295,941 bytes unpacked, limited to the documented artifact set plus npm-generated package metadata after the final published README revision.
- `npm run test:package -- --registry-install` also passed locally against an isolated empty cache; the remote three-operating-system dispatch remains pending.

These local results prove source-tree mechanics for this candidate. They do not prove npm publication, provenance, or remote platform compatibility.

## External evidence still required

- The GitHub Actions offline matrix must finish green on every retained Node.js and operating-system line. A checked-in workflow is not evidence of a remote pass.
- The dispatch-only registry-backed package smoke must pass on clean macOS, Linux, and Windows runners with Node.js 24. Its results are separate from the required offline matrix.
- The registry-facing dependency audit must complete against current npm advisory data.
- The opt-in live smoke must be explicitly authorized, use only `gpt-5.6-luna`, state the expected normal count of eleven and hard maximum of twelve model calls on POSIX before execution, and record the exact count afterward. Its client-defined tool scenario must observe two independent calls in the initial parallel batch and reach the third consecutive full-history tool-result request.
- If the package name is unclaimed, the one-time owner/2FA bootstrap must be recorded and the trusted publisher configured immediately afterward. Otherwise the candidate must be published through trusted publishing. In both cases its repository, license, tarball integrity, and `next` dist-tag must be verified; provenance is required for every OIDC-published candidate but cannot be claimed for the manual bootstrap.
- Install, login, high reasoning-effort streaming, the retained Stage 01 behaviors, usage when reported, and completed-thread continuation across a proxy/app-server restart must be verified from the published prerelease.
- A stable version and stable-promotion workflow remain pending. Do not move `latest` until prerelease evidence is accepted; the Stage 08 prerelease workflow intentionally cannot publish a stable version.

No remote CI, live, registry, provenance, or stable-promotion result is recorded as passing in this document.

## Acceptance status

| Criterion | Status |
| --- | --- |
| Publishable package metadata, license, narrow allow-list, exact Codex pin, `--version`, and published-user docs | Local gate passed |
| Fresh tarball installation and generated npm bin shim | Local offline smoke passed; remote OS evidence pending |
| Remote offline Node.js/OS matrix | Pending external evidence |
| Opt-in `gpt-5.6-luna` live smoke with exact call record | Pending explicit authorization |
| npm `next` publication, metadata, and integrity | Pending registry publication or one-time bootstrap |
| Trusted-publishing provenance | Pending for the first OIDC-published candidate; not available for a manual bootstrap |
| Stable `latest` promotion | Pending prerelease acceptance and a stable workflow decision |
| Rollback/deprecation without stranding persisted mappings | Runbook defined; exercise only if a published release needs intervention |

Stage 08 source implementation and local acceptance commands are complete. The release itself remains incomplete until every applicable external item in [RELEASE.md](../RELEASE.md) has dated evidence.
