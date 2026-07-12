# Stage 08: Packaging and release

## Goal

Publish a reproducible npm CLI that can locate a compatible Codex executable and guide a new user to a successful local request.

## Work

1. Finalize package metadata, files allow-list, bin mapping, license, provenance, repository links, supported engines, and platform declarations.
2. Pin or constrain the supported Codex distribution/version based on Stage 01.
    - If it cannot be installed as an npm dependency, add precise detection and official installation guidance instead of an implicit runtime download.
3. Ensure installation scripts do not execute downloaded binaries or perform login/network activity.
4. Add `--version`, `--help`, startup diagnostics, and actionable errors for missing/incompatible Codex, failed login, unavailable port, invalid host, and denied policy.
5. Test installation from the packed tarball in clean Node 20+ environments on each supported OS.
6. Write the end-user quick start, curl examples, tool continuation example, `x_codex` reference, security model, troubleshooting, and uninstall/state cleanup instructions.
7. Create a release checklist covering schema refresh, changelog, offline suite, packed smoke test, opt-in nano live smoke, dependency audit, provenance, and rollback/deprecation.
8. Publish a prerelease first. Validate install, login, streaming, tool continuation, usage, policy selection, and restart continuation before a stable tag.

## Acceptance criteria

- A clean user can install and run the CLI without cloning the repository.
- `npm pack --dry-run` contains only intended runtime/docs files and no credentials, fixtures with private data, or local state.
- Packed-install smoke tests pass on macOS, Linux, and Windows with Node 20+.
- One manual prerelease smoke uses only `gpt-5.4-nano` and records its exact call count.
- The README accurately labels every compatibility extension and known limitation.
- The release can be rolled back or deprecated without stranding persisted thread mappings.

