# Release checklist

Record the command or workflow URL, UTC date, commit SHA, version, and result beside every completed item. A checked-in workflow or local pass is not remote or registry evidence.

## Prepare the candidate

- [ ] Confirm the candidate version and intended dist-tag. The first candidate is `0.1.0-rc.0` on `next`; the prerelease workflow rejects stable versions.
- [ ] Review the diff for credentials, login URLs, prompts, tool arguments/results, absolute personal paths, captured transcripts, and local state.
- [ ] Refresh the generated app-server contract only if the exact `@openai/codex` pin changed: update the pin, run `npm ci` and `npm run generate:protocol`, review the complete generated diff, and commit `protocol/VERSION.json` with both generated trees. Otherwise run `npm run check:protocol` and record that the `0.144.5` snapshot is clean.
- [ ] Update [CHANGELOG.md](CHANGELOG.md). Keep the candidate marked pending until registry verification succeeds.
- [ ] Run the deterministic offline gate from a clean install:

  ```sh
  npm ci
  npm run check
  ```

- [ ] Run the packed-artifact gate and retain its tarball path, digest, package name, size, file count, and result:

  ```sh
  npm pack --dry-run --json --ignore-scripts
  npm run test:package -- --retain
  ```

  Confirm the tarball contains only `dist`, `README.md`, `LICENSE`, `protocol/schemas`, `protocol/VERSION.json`, and npm-generated package metadata. The smoke must seed its isolated cache from the exact Codex packages already installed by `npm ci`, install the proxy tarball with npm offline mode and lifecycle scripts disabled, invoke its npm bin shim, and perform no registry request, login, or live model call. `--retain` must print and preserve the tested tarball path only after the smoke passes. Do not run `npm pack` or a directory-based `npm publish` afterward.

- [ ] Audit current dependency data and review every exception before release:

  ```sh
  npm audit --omit=dev
  npm audit
  ```

### Recorded local result — 2026-07-16

- `npm run check`: passed 19 test files and 155 tests with all coverage thresholds satisfied.
- `npm run test:package`: passed exact-tarball installation, generated-bin version/help/start, health/readiness, and one synthetic Chat Completions response with zero model calls.
- `npm pack --dry-run --json --ignore-scripts`: 51 files; 71,939 bytes packed; 295,941 bytes unpacked after the final published README revision.
- `npm run test:package -- --registry-install`: passed locally from an isolated empty cache; remote operating-system evidence remains pending.

These results are local source-tree evidence, not remote-matrix or registry evidence. Re-run them for any changed candidate and record the new tarball digest.

## Prove remote compatibility

- [ ] Push the exact candidate commit and record a green required offline matrix for Linux, macOS, and Windows on Node.js 24.
- [ ] Dispatch the `Registry-backed package smoke` workflow and record its clean registry-install/bin-shim results from Linux, macOS, and Windows on Node.js 24. Source-tree execution and the required offline matrix are not substitutes for this networked evidence.
- [ ] Resolve or explicitly defer every failed matrix, package, or dependency-audit result before tagging.

## Run the opt-in live smoke

This check costs model calls and requires explicit authorization. It is isolated from default tests and is never a pull-request prerequisite.

- [ ] Before starting on POSIX, record: model `gpt-5.4-mini`; expected normal total **7 calls**; hard maximum **7 calls**; candidate version, commit SHA, and operator.
- [ ] Run the dedicated live configuration serially through the authorized `codex-live-tests` environment, or locally with the same pinned package and an existing ChatGPT login:

  ```sh
  npm run test:live
  ```

- [ ] After completion, record the **exact model-call count**, result, UTC date, and bounded diagnostic location. A range or “within limit” is not an exact call record.
- [ ] Confirm the source-level scenarios cover high `reasoning_effort`, streamed reasoning, reasoning- and internal-activity-stripped role-history replay, client-defined tool continuation, usage when reported, policy selection, and completed-thread continuation after restarting both proxy and app-server. Do not persist credentials, login URLs, prompts, tool payloads, or raw live transcripts.

This source-level live suite is a prepublication compatibility check. It does not prove the npm-registry artifact or first-run login; those have separate prerelease checks below.

## Publish the prerelease

### Bootstrap an unclaimed package name once

npm trusted publishing is configured from an existing package's settings. If `npm view codex-openai-proxy` shows that the package already exists and the expected npm owner controls it, skip this section and use OIDC below. If the name is unclaimed, reserve it with the tested `0.1.0-rc.0` candidate:

- [ ] Check the registry immediately before choosing a path. An `E404` from the first command means the name is not yet reserved; if it exists, verify the expected owner with the second command:

  ```sh
  npm view codex-openai-proxy name version dist-tags --json
  npm owner ls codex-openai-proxy
  ```

- [ ] Re-run `npm run check` and `npm run test:package -- --retain`, preserve the emitted `codex-openai-proxy-0.1.0-rc.0.tgz` path, and compute and record its digest before publication. The command retains the file only after its smoke passes. Name availability is race-prone until publication completes.
- [ ] In a private interactive terminal, authenticate as the intended npm package owner with write-enabled 2FA. Verify the account before changing the registry:

  ```sh
  npm login
  npm whoami
  ```

- [ ] Publish the exact tested tarball to `next`. Let npm prompt interactively for the one-time 2FA code; do not place the code in shell history, CI, or the evidence record:

  ```sh
  npm publish ./codex-openai-proxy-0.1.0-rc.0.tgz --tag next --access public
  ```

- [ ] Record this as a one-time non-OIDC bootstrap exception: npm owner, UTC time, commit SHA, tarball digest, pack metadata, local-gate results, registry integrity, and `next` dist-tag. Do not claim workflow provenance for this artifact.
- [ ] Do not trigger the automated prerelease publisher for an already published `0.1.0-rc.0`; npm versions are immutable. Configure the package's trusted publisher immediately, and use a new candidate version for its first OIDC verification.

### Publish subsequent candidates through OIDC

- [ ] Once per package, configure npm trusted publishing for repository `CIVITAS-John/codex-app-server-to-proxy`, workflow `publish-prerelease.yml`, and GitHub environment `npm`. Keep the workflow permissions at `contents: write` and `id-token: write`; do not add an npm token.
- [ ] Add the upcoming candidate to [CHANGELOG.md](CHANGELOG.md) and commit it to `main`. Do not edit package versions or create release tags manually.
- [ ] From `main`, dispatch **Publish npm prerelease**. An optional `dry_run` runs the matrix, version bump, and package gates without pushing refs or publishing.
- [ ] For a real run, confirm the workflow passes, publishes the exact tested tarball to `next` with provenance, creates the version tag, and advances `main` to the generated version commit. Download the retained tarball if longer-lived evidence is required; workflow artifacts expire after 14 days.
- [ ] Record the workflow URL, dispatch SHA, generated tagged commit, tested tarball digest, published integrity, and provenance result. GitHub provenance identifies the `main` dispatch commit, while the version tag identifies its workflow-generated child commit.
- [ ] After the first successful OIDC publication, restrict traditional publishing access according to the owner-recovery policy. Retain a 2FA-protected owner account for deprecation and dist-tag incident response; do not create an automation token.

The workflow owns the offline matrix, npm/OIDC identity checks, version bump, package gates, tag lifecycle, exact-tarball publication, and final `main` update. If publication fails, verify the exact npm version before redispatching; the workflow deletes an unpublished tag only after npm returns E404 and otherwise retains it for investigation.

If npm accepted the version but the final `main` push failed, land the retained tag before redispatching:

```sh
git fetch --tags
git merge vX.Y.Z-rc.N
git push origin main
```

## Verify the registry

- [ ] Set the exact version under review—`0.1.0-rc.0` for the bootstrap or the new candidate version for OIDC—then record its version, `next` dist-tag, integrity, tarball URL, repository, and license:

  ```sh
  CODEX_PROXY_RELEASE_VERSION=0.1.0-rc.0
  npm view "codex-openai-proxy@${CODEX_PROXY_RELEASE_VERSION}" version dist-tags dist.integrity dist.tarball repository license --json
  ```

- [ ] For an OIDC-published candidate, verify the npm provenance attestation links to the expected repository, workflow, `main` dispatch ref, dispatch commit, and tested tarball. Separately verify that the release tag names the generated version commit whose parent is that dispatch commit. Verify registry signatures and attestations from a clean temporary install where supported. For the one-time manual bootstrap, record that provenance is unavailable rather than claiming it passed.
- [ ] Install the exact registry version in a clean temporary project with lifecycle scripts disabled, invoke `codex-openai-proxy --version` through its npm bin shim, and repeat the bounded published-package smoke.
- [ ] In an explicitly authorized disposable login profile with no existing Codex session, start the exact registry-installed bin shim on loopback and record that browser or device-code login reaches `/ready`. An already-authenticated startup is not first-run login evidence. Do not record the authorization URL, device code, token, or profile path.
- [ ] From the exact registry-installed bin shim, run the published-prerelease live scenarios with only `gpt-5.4-mini`: on POSIX, declare the expected normal total and hard maximum of **7 calls** before starting, then record the exact count. Cover high `reasoning_effort`, streamed reasoning, reasoning- and internal-activity-stripped role-history replay, client-defined tool continuation, usage when reported, policy selection, and completed-thread continuation after restarting both the installed proxy and its app-server. The fake packed smoke and source-level `npm run test:live` do not satisfy this item.
- [ ] Confirm [CHANGELOG.md](CHANGELOG.md) records the verified publication date.

## Promote a stable release

The Stage 08 workflow is prerelease-only and always publishes to `next`. It must not be used to move `latest`.

- [ ] Accept the prerelease evidence and close or explicitly defer every release-blocking issue.
- [ ] Choose a stable version, update the changelog and package version, and add or approve a trusted-publishing path that rejects prerelease versions and publishes the stable version to `latest` with provenance.
- [ ] Repeat the offline matrix, packed smoke, registry-backed operating-system smoke, dependency audit, exact live-call declaration/record if required, and registry verification for the stable artifact. Publish its exact tested tarball with provenance; do not rebuild at publish time or promote by retagging an unverified local build.

## Roll back or deprecate

- [ ] OIDC trusted publishing does not authorize deprecation or dist-tag changes. In a private interactive terminal, authenticate as a current npm package owner with write-enabled 2FA, then verify identity and ownership:

  ```sh
  npm login
  npm whoami
  npm owner ls codex-openai-proxy
  ```

- [ ] Before changing tags, verify the replacement accepts the existing version-0 continuation store and the exact Codex contract, or document that users must keep the prior compatible package installed for continuation access.
- [ ] Move the affected tag to a verified compatible version first, then deprecate the defective version. These concrete `next` examples replace `0.1.0-rc.1` and the message as appropriate; use `latest` instead of `next` for a stable rollback. Let npm prompt for 2FA and never record the one-time code:

  ```sh
  npm dist-tag add codex-openai-proxy@0.1.0-rc.1 next
  npm deprecate codex-openai-proxy@0.1.0-rc.0 "Critical issue; use 0.1.0-rc.1 instead."
  npm dist-tag ls codex-openai-proxy
  ```

  Never unpublish merely to hide a defect.

- [ ] Never delete, move, truncate, or rewrite `~/.codex-openai-proxy` or a custom `--state-dir` during package install, upgrade, deprecation, or rollback.
- [ ] If no compatible replacement exists, leave the affected artifact obtainable, deprecate it with clear guidance, and ship a tested migration or read-only export path before a persistence-breaking release.
- [ ] Record the deprecated version, replacement, dist-tag changes, compatibility result, date, and incident link in the changelog.
