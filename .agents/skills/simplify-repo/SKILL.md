---
name: simplify-repo
description: Simplify a specified range of the codebase by removing complexity that serves no purpose — excessive edge-case handling, meaningless tests, duplicated guardrails, dead code, over-abstraction, redundant logging/comments, and error-handling sprawl. The argument specifies the range - a component name, directory, glob, git range, or file list. Use when the user asks to "simplify", "declutter", "trim", or "clean up" part of the repo. Findings are verified before being proposed, applied in approved stages (test cleanup first) with per-stage test runs, then reviewed by fresh-context subagents and revised until clean.
---

# Simplify Repo

Simplify the codebase within a specified range. You are a careful code simplifier: your goal is to remove complexity that serves no purpose — while preserving all observable behavior of the code that remains. Follow this exact workflow.

## Step 1: Resolve the Range

Interpret the argument as the scope for simplification. It may be:

- A component name (`vox-agents`, `bridge-service`, `mcp-server`, `civ5-mod`, `civ5-dll`) — scope is that component's source and tests
- A directory or glob (e.g. `vox-agents/src/strategist/`) — scope is the matching files
- A git range (e.g. `v0.7.0..HEAD`, `HEAD~5..`) — scope is the files changed in that range
- A list of files

If the argument is empty or ambiguous, ask the user to specify the range before proceeding. List the resolved files so the user can confirm the scope looks right.

## Step 2: Scan for Simplification Targets

Read the scoped files and the relevant component's AGENTS.md (project conventions override your instincts about what is "unnecessary"). Look for these categories:

1. **Excessive edge-case handling** — code defending against states that cannot occur: inputs no caller produces, conditions already guaranteed by types or upstream validation, fallbacks for impossible failures.
2. **Meaningless tests** — tests that assert tautologies, test the mock instead of the code, duplicate another test's coverage, test framework/library behavior, or exercise trivial pass-throughs.
3. **Duplicated guardrails** — the same validation or safety check repeated at multiple layers when one authoritative check suffices. Keep the check at the layer that owns the invariant; remove the echoes.
4. **Dead / unreachable code** — unused exports, functions, branches that can never execute, leftover feature flags, commented-out blocks.
5. **Over-abstraction** — single-implementation interfaces, pass-through wrappers, indirection with one caller, config options nothing sets.
6. **Redundant logging/comments** — comments that restate the code, excessive debug logging, stale TODOs describing done work.
7. **Error-handling sprawl** — try/catch that only rethrows or silently swallows, repeated null-checks on values already guaranteed non-null, catch blocks that log and continue in code paths where failure must propagate.

**Verify before proposing.** For every candidate:

- "Unused" claims require a repo-wide reference search (all components, not just the scoped one — components import from each other, and Lua/mod files may reference exports by string).
- "Cannot occur" claims require reading the actual callers, not just the local function.
- "Duplicate test" claims require confirming the surviving test actually covers the same behavior.
- When in doubt, drop the finding. A false simplification is worse than a missed one.

## Step 3: Report and Get Approval

Present findings as a numbered list, grouped by category, each with `file:line`, a one-line rationale, and the expected effect (e.g. "-40 LOC, no behavior change").

If the total change is small, propose applying it as a single batch. If it is big, organize the findings into **stages**:

- **The first stage(s) always deal with tests** — removing meaningless tests and consolidating duplicated test coverage. This settles the safety net first, so the test suite that verifies later stages contains only meaningful tests.
- Later stages cover production code, grouped by component or subsystem so each stage is independently verifiable.

Ask the user which findings/stages to approve. Do not edit anything until approval. The user may approve all, a subset, or ask for revisions.

## Step 4: Apply Stage by Stage

For each approved stage, in order:

1. Apply the edits for that stage only.
2. Run the tests for the affected component(s): `npm test` in `vox-agents`, `bridge-service`, or `mcp-server` (mock mode; scope with vitest path filters when the suite is slow). For `civ5-dll` / `civ5-mod` there is no automated suite — verify the DLL still compiles if a build is available, otherwise flag the stage for manual verification.
3. If tests fail, fix the regression or revert that stage's edits before moving on. Never carry a red suite into the next stage.
4. Give a one-line stage summary (what was removed, test result) before starting the next stage.

## Step 5: Review and Revise

After all approved stages are applied and green, validate the result before declaring done:

1. **Fresh-context review** — Spawn read-only subagent(s) with no prior conversation, giving each the full diff, the approved findings list, and the goal (behavior-preserving simplification). Their blindness to your reasoning is exactly why they catch what you've stopped seeing. Brief them adversarially on two axes:
   - **Fidelity** — was every approved finding applied completely? No half-removed abstractions, orphaned imports, helpers whose last caller was deleted, or approved items silently skipped.
   - **Safety** — did any edit change observable behavior beyond the permitted removals (tests, logging)? Did a deleted test take real coverage with it? Did an edit stray outside the approved range? Ask for concrete findings with `file:line` evidence, defaulting to skepticism over praise.
2. **Reconcile** — Judge each finding yourself. If nothing material surfaced, proceed to Step 6.
3. **Revise** — For material findings: propose the fixes (ask the user first if a fix changes the approved scope or restores something they approved removing), apply them, and re-run the affected component tests.
4. **Re-review** — Have a fresh subagent re-check the revised areas. Loop reconcile → revise → re-review until the review surfaces nothing material.

## Step 6: Final Summary

After the review loop is clean, report:

- What was simplified per category, with LOC delta
- Test status per component
- Any findings deliberately skipped and why
- Anything noticed outside the approved scope that may deserve a future pass (report only — do not touch it)

## Important Guidelines

- Simplification must preserve observable behavior; the only permitted behavioral changes are removed tests and removed logging.
- Stay strictly inside the resolved range for edits. Findings outside it go in the final summary only.
- Do not "improve" code while simplifying — no renames, no restructuring, no new abstractions. Removal and inlining only.
- If a guardrail looks duplicated but the layers can be reached independently (e.g. MCP tool input vs. internal API), it is not a duplicate — keep both.
