# Stage 08: Packaging and release

## Goal

Publish a reproducible npm CLI that a clean machine can install without cloning the repository and drive through the generated npm bin shim.

## Release decisions

- The first candidate is `codex-openai-proxy@0.1.0-rc.0`, intended for the npm `next` dist-tag. The stable `latest` tag is not part of the prerelease workflow.
- npm trusted publishing cannot be configured until the package exists. If `codex-openai-proxy` is still unclaimed, the first `0.1.0-rc.0` publication is a one-time bootstrap: an npm package owner authenticated interactively with 2FA publishes the exact locally tested tarball to `next`, records the exception and artifact evidence, and then configures the trusted publisher. This bootstrap is not OIDC publication and has no workflow provenance.
- Every candidate after the name-reserving bootstrap uses a `main`-only manual GitHub Actions dispatch with npm trusted publishing. The publish job pins npm `11.18.0` and, before changing a remote ref, verifies that GitHub can mint an npm-audience OIDC token whose repository, workflow, `main` ref, `npm` environment, and runner claims match the trusted-publisher decision without logging or persisting that token. The pinned npm CLI remains the sole implementation of the registry exchange. The workflow requires the full remote matrix, creates the prerelease version commit and tag on its runner, tests and publishes the exact retained tarball with provenance, and then fast-forwards `main`. Rebuilding at `npm publish` time is forbidden. This replaces local versioning and tag-triggered publication; failures before the tag push leave the repository untouched, while an unsuccessful publish command deletes the remote tag only when the tag still exists and npm returns E404 for the exact version. An existing version or unverifiable registry retains the tag; the next dispatch reconfirms the version is absent from npm and replaces the leftover tag itself. A post-publish `main` failure requires manually merging the tagged commit into `main`; a redispatch before that repair detects the published-but-unmerged state and fails with the recovery instructions. GitHub provenance identifies the dispatch commit rather than its runner-created child, so release evidence records both commits and verifies their parent/tag relationship.
- Runtime support remains Node.js 20 or newer. The retained offline matrix is Node.js 24 on Linux, macOS, and Windows.
- The exact `@openai/codex 0.144.5` runtime dependency owns default executable resolution and the generated app-server contract. An explicit `--codex-path` override must report the same version. Older and newer Codex executables are rejected until their generated contracts are reviewed and checked in.
- The npm artifact is limited to `dist`, `README.md`, `LICENSE`, `protocol/schemas`, and `protocol/VERSION.json`. Generated protocol TypeScript, tests, fixtures, coverage, plans, scripts, workflows, and local proxy state are not published.
- Package installation has no proxy install hook. `prepack` builds the publisher's artifact, but installing it never starts Codex, performs login, or invokes the proxy.
- Removing or deprecating a package version must not delete `~/.codex-openai-proxy` or a custom `--state-dir`. Persisted mappings remain available to a compatible installed version; an incompatible replacement must provide an explicit migration or refuse the store without rewriting it.

These decisions make the prerelease intentionally narrow: users get a reproducible package and pinned protocol, while a Codex upgrade, stable npm promotion, or persistence-format change requires a new reviewed release decision.

## Implemented in the source tree

- npm metadata identifies the repository, homepage, issue tracker, author, MIT license, prerelease version, supported Node.js range, CLI bin, and exact Codex runtime dependency.
- The package allow-list excludes source-only generated protocol trees and retains the request-extension and continuation-state JSON Schemas referenced by the published README.
- `--version` reports the package version, and `--help` succeeds before or after `serve`.
- Startup failures retain actionable categories for invalid hosts, unavailable ports, incompatible Codex overrides, authentication failures, and denied managed policy while default logs redact sensitive paths and login data.
- The deterministic packed-package smoke builds one fresh tarball, seeds an isolated npm cache from the exact Codex packages installed by `npm ci`, installs the proxy tarball in npm offline mode with lifecycle scripts disabled, invokes the generated bin shim, checks package contents and metadata, and uses a local fake Codex executable. It performs no registry request, live model call, proxy login, or non-loopback runtime request. The default cleans the tarball; `--retain` preserves it only after the smoke passes.
- A separate `--registry-install` mode starts with an isolated empty cache, installs the exact runtime and current-platform Codex packages from npm, validates their versions, and runs the same smoke. Its dispatch-only Linux/macOS/Windows workflow is external registry evidence, not part of required offline CI.
- The checked-in prerelease workflow rejects non-`main` dispatches, first requires the full reusable offline matrix, pins a trusted-publishing-capable npm CLI, validates the non-secret GitHub OIDC identity claims, and confirms the package already exists for OIDC. It creates the RC version commit and tag locally, rejects stable or already-published versions, reruns the offline release gate on the bumped tree, runs the packed smoke with `--retain`, and uploads the exact tested tarball for 14-day evidence retention. A dry run stops before remote changes. A real run pushes only the tag, lets the pinned npm CLI exchange the OIDC identity and publish that tarball to `next` with provenance, and fast-forwards `main`; after a failed publish command it confirms the tag exists, retains it for an existing or unverifiable npm version, and deletes it on E404 so the next dispatch can recreate it.
- The published-user README now starts with the `npx ...@next` path, documents exact Codex override compatibility, preserves curl and tool-continuation guidance, labels every Codex-specific field as nonstandard, and explains uninstall plus per-root state cleanup.
- [RELEASE.md](../RELEASE.md) is the evidence checklist and rollback runbook. [CHANGELOG.md](../CHANGELOG.md) records the candidate without claiming it has been published.

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
- The opt-in live smoke must be explicitly authorized, use only `gpt-5.4-mini`, state the expected normal count of five model calls and maximum of six before execution, and record the exact count afterward.
- If the package name is unclaimed, the one-time owner/2FA bootstrap must be recorded and the trusted publisher configured immediately afterward. Otherwise the candidate must be published through trusted publishing. In both cases its repository, license, tarball integrity, and `next` dist-tag must be verified; provenance is required for every OIDC-published candidate but cannot be claimed for the manual bootstrap.
- Install, login, streaming, the retained Stage 01 behaviors, usage when reported, and completed-thread continuation across a proxy/app-server restart must be verified from the published prerelease.
- A stable version and stable-promotion workflow remain pending. Do not move `latest` until prerelease evidence is accepted; the Stage 08 prerelease workflow intentionally cannot publish a stable version.

No remote CI, live, registry, provenance, or stable-promotion result is recorded as passing in this document.

## Acceptance status

| Criterion | Status |
| --- | --- |
| Publishable package metadata, license, narrow allow-list, exact Codex pin, `--version`, and published-user docs | Local gate passed |
| Fresh tarball installation and generated npm bin shim | Local offline smoke passed; remote OS evidence pending |
| Remote offline Node.js/OS matrix | Pending external evidence |
| Opt-in `gpt-5.4-mini` live smoke with exact call record | Pending explicit authorization |
| npm `next` publication, metadata, and integrity | Pending registry publication or one-time bootstrap |
| Trusted-publishing provenance | Pending for the first OIDC-published candidate; not available for a manual bootstrap |
| Stable `latest` promotion | Pending prerelease acceptance and a stable workflow decision |
| Rollback/deprecation without stranding persisted mappings | Runbook defined; exercise only if a published release needs intervention |

Stage 08 source implementation and local acceptance commands are complete. The release itself remains incomplete until every applicable external item in [RELEASE.md](../RELEASE.md) has dated evidence.
