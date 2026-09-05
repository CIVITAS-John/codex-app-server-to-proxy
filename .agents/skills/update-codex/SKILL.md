---
name: update-codex
description: Update this proxy's pinned upstream Codex dependency, run the automated upgrade attempt, and repair and review app-server compatibility. Use when upgrading Codex in this repository or recovering a failed npm run update:codex attempt.
---

# Update upstream Codex

Run from the repository root. The executable helper is [scripts/update-codex.mjs](../../../scripts/update-codex.mjs), exposed as `npm run update:codex`.

## Attempt the update

Inspect Git status and the current dependency pin, `protocol/VERSION.json`, and `protocol/CONTRACT.md`. Preserve existing user changes. Record pre-existing check failures when relevant so they are not mistaken for upstream regressions.

- For a user-selected version: `npm run update:codex -- <exact-version>`.
- For the latest stable npm release: `npm run update:codex` (resolves `latest` once and installs that exact version).
- If a failed attempt already left a new pin or generated output, inspect that attempt and continue repairs; use `npm run update:codex -- --check` to validate without reinstalling or overwriting generated output.

The helper refuses uncommitted changes to package manifests, generated protocol trees, or version metadata before an update. Use a separate checkout based on the intended starting state when those files contain unrelated work; do not reset, stash, or commit the user's work automatically. Other dirty paths remain untouched by generation but may affect validation.

Installation requires registry access, disables dependency lifecycle scripts, and updates the lockfile. Generation uses the package-owned executable. The helper stops on install/generation failure and otherwise runs all independent offline gates, returning nonzero if any fail. It preserves partial changes and prints failures to the terminal. It does not launch an agent itself: when running this skill, you own the recovery loop.

## Repair and review compatibility

Inspect the generated diff, including removed files, against the previous pin. Consult the matching upstream release notes and app-server source/reference when a change needs explanation; avoid treating a moving latest reference as evidence for a different pinned release. Update `docs/codex-app-server.md` when the reference changes and record its provenance.

Review these areas even when tests pass:

- App-server request parameters, notification unions, nested `Thread`/`Turn` values, tool-call and result lifecycles, usage attribution, errors, cancellation, and ordering. Follow affected fields through `src/app-server/`, `src/http/`, `src/continuation/`, typed fixture builders, and `protocol/fixtures/exposed-events.ts`.
- Effective policy and approval behavior: preserve loopback binding, sandbox constraints, denied requests, and the documented HTTP surface. Newly generated upstream methods or events are not automatically public proxy features.
- Existing proxy homes and continuation stores: inspect auth synchronization, Codex thread resume behavior, persisted filenames/formats, and model-cache metadata. Explicitly decide whether the unversioned home remains compatible, needs migration, or must be refused without rewriting it.
- The version-specific Responses Lite workaround in `src/app-server/responses-lite-override.ts`: determine whether it remains necessary and correct. A successful compilation does not validate this runtime workaround.

For failures, identify whether installation/environment, generation, or proxy compatibility caused them. Adapt maintained source and synthetic typed fixtures to the target contract, add focused success/failure regressions for changed behavior, and regenerate if needed. Do not hand-edit generated files, loosen types to hide failures, drop coverage, or weaken policies to make the gates pass. If an upstream change cannot preserve the existing public contract, explain the incompatibility and obtain a product decision before introducing a breaking behavior outside the requested upgrade scope.

Repeat `npm run update:codex -- --check` after repairs. Do not repeatedly reinstall a failing target. If an external dependency or missing user decision prevents progress, retain the evidence and describe the blocker.

## Finish

Update current-version claims in `README.md`, `protocol/CONTRACT.md`, and relevant docs; retain version numbers that describe historical decisions. Record the target version, compatibility decision, and persistence consequence in `plans/07-quality-and-ci.md` and `plans/08-packaging-and-release.md` as applicable. Update the changelog for observable changes.

Require the offline gates and the normal pull-request OS matrix before release. Live tests remain separately opt-in: state `gpt-5.6-luna` and the hard maximum of 32 deduplicated upstream model responses before an authorized run, following `docs/development.md`. Never persist runtime transcripts as fixtures or diagnostics.

Report old and new pins, repairs, compatibility findings, passed/failed checks, and any unverified live behavior. A green helper run is evidence for offline compatibility, not automatic permission to merge, publish, or assert live compatibility.
