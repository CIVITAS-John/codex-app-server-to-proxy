# Stage 08: Packaging and release

## Goal

Publish a reproducible npm CLI that a clean machine can install without cloning the repository and drive to a successful local request through the generated npm bin shim.

## Baseline from the 2026-07-16 pre-stage review

- The offline gate passes locally (18 files, 134 tests). The capacity-release race in `test/http/server.test.ts` was fixed with bounded `/health` polling, and `--help` is now recognized after the `serve` command as well as before it.
- CI workflows are checked in, but the remote matrix has not yet proven the retained lines: Node.js 20, 22, 24, and 26 on Linux and Node.js 24 on macOS and Windows.
- `npm pack` currently emits 1,065 files (3.8 MB unpacked) because the `files` allow-list ships both generated protocol TypeScript trees. The runtime imports nothing from `protocol/`; only the JSON Schemas and `protocol/VERSION.json` are user-facing.
- `package.json` declares MIT but the repository has no LICENSE file, so none would be packed. `repository`, `homepage`, `bugs`, `keywords`, `author`, and a releasable version are absent, and `--version` is unimplemented.
- The README already covers quick start, curl examples, the tool round trip, the `x_codex` reference, the security model, and troubleshooting, but it is written from the unpublished run-from-repository perspective.

## Work

1. Prove the checked-in offline CI matrix on GitHub Actions before making packaging claims. This is the carried-over Stage 07 gate; no release step may cite a matrix that has not run green remotely.
2. Finalize package metadata: `repository`, `homepage`, `bugs`, `keywords`, `author`, and the initial release version. Add the MIT LICENSE file so npm includes it automatically, and enable provenance through trusted publishing from CI rather than local `npm publish`.
3. Trim the `files` allow-list to `dist`, `README.md`, `protocol/schemas`, and `protocol/VERSION.json`. Verify with `npm pack --dry-run` that the generated TypeScript trees, tests, fixtures, coverage, and local state are absent and that README links into `protocol/` still resolve inside the installed package.
4. Pin or constrain the supported Codex distribution/version based on Stage 01.
    - The exact `@openai/codex 0.144.5` runtime dependency now owns default executable resolution and the generated contract. Stage 08 must preserve that pin through packed-install testing and document that `--codex-path` overrides require the same version.
5. Ensure installation scripts do not execute downloaded binaries or perform login/network activity.
6. Add `--version`, startup diagnostics, and actionable errors for missing/incompatible Codex, failed login, unavailable port, invalid host, and denied policy. `--help` is already implemented for both argument positions and stays covered by CLI tests.
7. Test installation from a freshly built tarball in clean Node 20+ environments on each supported OS, including invocation through the generated npm bin shim. Delete stale local tarballs first so no smoke test can run against an old artifact.
8. Rewrite the end-user README from the published-package perspective: `npx` quick start first, curl examples, tool continuation example, `x_codex` reference, security model, troubleshooting, and uninstall/state cleanup instructions covering the per-root `~/.codex-openai-proxy` store.
9. Create a release checklist covering schema refresh, changelog, offline suite, packed smoke test, opt-in nano live smoke, dependency audit, provenance, and rollback/deprecation.
10. Publish a prerelease first. Validate install, login, streaming, every retained Stage 01 feature, usage when reported, and restart continuation before a stable tag.

## Acceptance criteria

- The remote offline CI matrix is green on every retained Node.js and operating-system line.
- A clean user can install and run the CLI without cloning the repository.
- `npm pack --dry-run` contains only `dist`, the README, the LICENSE, the protocol JSON Schemas, and `protocol/VERSION.json` — no generated TypeScript trees, credentials, fixtures with private data, or local state.
- Published package metadata resolves: the repository link, license, and provenance attestation are verifiable from the npm registry entry.
- `--version` reports the package version, and `--help` prints usage from either argument position with exit code 0.
- Packed-install smoke tests pass on macOS, Linux, and Windows with Node 20+.
- The packed CLI starts through its installed npm bin shim; source-tree invocation alone is not sufficient evidence.
- One manual prerelease smoke uses only `gpt-5.4-mini`, declares its expected maximum call count before execution, and records its exact call count.
- The README accurately labels every compatibility extension and known limitation, and documents uninstall and state cleanup.
- The release can be rolled back or deprecated without stranding persisted thread mappings.
