---
name: improve-docs
description: Improve a set of existing documentation pages through staged, subagent-delegated review and revision. The stages are fact-checking the pages against the implementation (checking with the user on which side should change when they disagree), fanning out single-lens readability reviewers and per-section revisers, re-verifying the facts after the rewrite, and a final flow edit for natural, efficient language. Use when the user asks to "improve the docs", "fact-check this page", "align the docs with the code", "tighten or shorten documentation", or names pages that read poorly. The goal is shorter documentation that a reader understands faster than reading the code.
---

# Improve Docs

Turn a set of existing documentation pages into shorter, accurate pages a reader actually understands. A doc that is winding, stale, or padded is worse than reading the code, so the deliverable is fewer words carrying more truth, not more polish on the same length.

Two principles run through every phase:

- **Delegate.** Fan the reading, checking, and rewriting out to less expensive subagents (for example `sonnet` or `Terra` for fact lookups and mechanical rewrites); spend your own reasoning on reconciling findings and final judgment. Use read-only agents to review, editing agents to revise.
- **Facts, then form, then flow.** Align facts before improving readability so the rewrite restates true content, re-check facts after the rewrite because rewriting drifts them, and polish language only once both are settled.

**Flow:** scope → fact alignment loop → readability fan-out → fact re-check → flow edit → verify and land. Match depth to the work: one short page may need one checker and one editor, a whole section of the site earns the full loop. Track the target pages in a `TodoWrite` list.

## Phase 1: Scope

Identify the target pages and, for each, its named reader: player guide, contributor guide, or specification. Read [docs/AGENTS.md](../../../docs/AGENTS.md) and the repository agents guide first; their audience, linking, and readability conventions are the bar every reviewer below applies. Note anything the user already said about direction (what feels too long, what confused a reader) so the briefs can carry it.

## Phase 2: Fact alignment loop

A readable lie is worse than a clumsy truth, so ground every page in the implementation before touching style.

1. **Check.** Fan out read-only fact-checkers (`sonnet`, `Explore`), one per page or subsystem, in a single message. Each brief: extract every checkable claim from the page (paths, commands, names, defaults, behavior, ordering of steps) and verify it against the current code, returning a list of divergences with evidence as `path:line`. Demand conclusions, not file dumps.
2. **Decide direction with the user.** For each divergence, judge which side should change. Often the doc is stale and the fix is obvious. When it is genuinely unclear whether the implementation is wrong or the doc or spec is outdated, batch those cases into `AskUserQuestion` with your recommended direction first. Do not silently pick a side on a product rule.
3. **Revise.** Delegate doc fixes to editing subagents. When the user rules that the code is what is wrong, delegate a small code fix to an editing subagent in the same pass; if the fix is substantial, pause and recommend running `plan-changes` and `implement-plan` for it instead, since a documentation pass should not quietly grow into a feature change.
4. **Loop.** Re-run checkers on the changed pages until no material divergence remains.

## Phase 3: Readability fan-out

First review, then revise, both fanned out.

**Review.** Spawn fresh-context, read-only reviewers in one message, one lens per agent so each has a single target. Give each the pages, the audience rules from Phase 1, and an adversarial brief to return prioritized, located findings (page and section), defaulting to skepticism. Lenses, applied where they fit the audience:

- **Player fit** (player-facing pages only): is anything too technical, assumed, or framed around the platform instead of the reader and their assignment?
- **Contributor fit** (contributor guides and specs): is anything too terse, hand-wavy, or missing the purpose-then-location-then-how shape?
- **Length and form:** what can be cut outright, what reads easier as a bullet list, table, or small diagram, and where does layered writing (why we changed X, why not Y) survive that should be flattened into the current rule?
- **Duplication and linking:** what repeats content that lives elsewhere and should become a link, and what sits in the wrong home per the documentation guide?
- **Structure and entry:** does each page lead with its purpose, prerequisites, and common path, are headings scannable, should a page split?
- **Terminology:** are the shared product terms used consistently and defined on first use?

Add or drop lenses to match the pages; the constraint is one lens per agent, every relevant lens covered.

**Reconcile.** Read all findings and decide which hold. Lenses will conflict (one asks for more explanation, another for fewer words): resolve toward the shortest version the named reader still understands. Turn the survivors into a revision brief per page or section.

**Revise.** Fan out editing subagents, each owning a disjoint page or section so they cannot collide, briefed with the exact findings to apply and the audience rules. Each rewrites its part fresh rather than patching sentences, and reports what it cut and why.

## Phase 4: Fact re-check

Rewriting drifts facts: a tightened sentence can quietly overclaim, and a new table can invent a default. Re-run fresh fact-checkers (Phase 2 brief) on every rewritten page. Fix divergences through small delegated edits, re-checking until clean. New divergences that trace back to Phase 2 decisions go back to the user, not around them.

## Phase 5: Flow edit

One final editing pass per page, delegated to a stronger model, reading top to bottom as the page's named reader. The brief: smooth the seams the sectioned rewrite left, expand anything now too terse to follow, and tighten anything still winding, so every sentence earns its place. This pass rewords only; it may not add content, change facts, or reorder rules. Shorter is the default direction whenever meaning survives.

## Phase 6: Verify and land

Run the strict documentation build, `uv run python scripts/ci.py docs`, and fix what it flags (broken links are the usual casualty of restructuring). Then summarize for the user: pages changed, facts corrected on each side (docs and code), what was cut or restructured, and anything deliberately left open. Confirm they are satisfied; material feedback loops back to the matching phase.
