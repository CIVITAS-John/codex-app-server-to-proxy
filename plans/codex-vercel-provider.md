# Staged plan: Codex app-server Vercel AI provider

## Goal

Build a Node.js/TypeScript Vercel AI SDK provider that uses a long-lived local `codex app-server` process and supports exactly:

- first-use ChatGPT login;
- streamed text, reasoning, and tool calls;
- Vercel-defined dynamic tools;
- selective sandbox and web-search enablement;
- token usage/provider metadata;
- maximum safe Codex thread reuse, especially across the steps of one `streamText` request.

## Non-goals

Do not add embeddings, image/audio models, MCP/apps, skills, approvals UI, file artifacts, realtime, thread browsing, remote transports, API-key login, or general-purpose access to the full app-server API. Internal handling of an app-server event is allowed only when required to make an in-scope flow safe (for example, interruption and process errors).

## Design principles

- Pin and test against explicit versions of both `@ai-sdk/provider` and the Codex CLI. Generate app-server TypeScript/JSON schemas from that exact CLI during development.
- Keep one initialized app-server connection per provider instance; never create a child process per turn.
- Treat stdout as JSONL RPC only and stderr as diagnostics only.
- Preserve stream order, surface terminal errors once, and make abort cleanup deterministic.
- Default to the least privilege: no web search and no writable sandbox without an explicit caller option.
- Put the Codex thread ID in typed provider metadata so continuity is observable and portable.
- Do not claim dynamic-tool support until a real AI SDK `streamText` execution proves the bridge cannot deadlock.

## Stage 0 — Contract spike and version lock

Purpose: resolve the only fundamental compatibility risk before building the package around an invalid assumption.

Work:

1. Create a minimal package with pinned current `ai`, `@ai-sdk/provider`, and `@ai-sdk/provider-utils` versions and record the minimum supported Node.js and Codex CLI versions.
2. Inspect the pinned `LanguageModelV3` `doStream` call options and stream-part types. Verify exactly what reaches a provider for a Vercel `tool`: schema only, or schema plus an executable callback.
3. Generate matching app-server schemas with `codex app-server generate-ts` and enable `initialize.params.capabilities.experimentalApi`.
4. Prototype one dynamic tool call end to end using `thread/start.dynamicTools` and the server-initiated `item/tool/call` request.
5. Test these possible bridges in order:
   - execute and answer `item/tool/call` inside the same `doStream` call if the pinned provider contract exposes the executor;
   - otherwise emit the AI SDK tool call, retain the pending Codex RPC/turn, and resume it from the SDK's tool-result continuation without waiting on a circular dependency;
   - if neither is possible through the public provider contract, document the limitation and define the smallest explicit provider extension (for example, a Codex provider option carrying an execution registry). Do not simulate tool execution with prompt text.
6. Prove multiple tool calls followed by final assistant text can use one Codex thread. Measure whether this is one Codex turn or multiple turns and name the behavior accurately.

Exit criteria:

- A checked-in executable spike streams `text → tool call → tool result → text` through `streamText` without hanging.
- Tool errors and abort during a pending tool call terminate both sides.
- The chosen bridge uses only public pinned APIs, or the required extension is explicitly accepted and tested.
- The thread/turn behavior is captured in an architecture decision record.

## Stage 1 — Process and bidirectional JSON-RPC foundation

Work:

1. Spawn `codex app-server --stdio` with configurable binary path, `cwd`, environment allowlist, and startup timeout.
2. Implement newline framing, request IDs, response correlation, notifications, and server-initiated requests on the same connection.
3. Perform `initialize` followed by `initialized`; identify the client and opt into the experimental API required for dynamic tools.
4. Add bounded pending-request state, malformed-message handling, stderr diagnostics with credential redaction, and process-exit fan-out.
5. Wire `AbortSignal` to request cleanup and later to `turn/interrupt`.
6. Add a lifecycle API (`close`/async disposal) and make repeated close safe.

Tests:

- fragmented/multiple JSONL messages;
- out-of-order responses and interleaved notifications;
- server-initiated request/response correlation;
- initialization failure, timeout, malformed JSON, and child exit;
- abort and disposal with no leaked listeners or promises.

Exit criteria: a fake app-server protocol harness passes deterministically and one real CLI initialization smoke test passes.

## Stage 2 — First-use ChatGPT authentication

Work:

1. After initialization, call `account/read` once and cache only the state, not credentials.
2. If `requiresOpenaiAuth` is true and `account` is null, start `account/login/start` with `{ type: "chatgpt" }`.
3. Surface the returned `authUrl` through a configurable callback. The default Node behavior may open the browser only when supported; otherwise print/return a clear actionable URL.
4. Wait for the matching `account/login/completed`, handle `account/updated`, enforce a timeout, and allow cancellation via `account/login/cancel`.
5. Coalesce simultaneous first-use calls behind one login attempt and retry the original request only after success.

Tests:

- already signed in;
- auth not required;
- successful login, rejection, timeout, cancellation, and process exit;
- multiple callers trigger one login.

Exit criteria: a clean Codex home can authenticate once and the next provider call proceeds without another prompt.

## Stage 3 — Minimal provider and text/reasoning streaming

Work:

1. Implement the pinned `ProviderV3`/`LanguageModelV3` surface with `doStream`; implement `doGenerate` only by consuming the same stream path if the interface requires it.
2. Translate supported system/user/assistant text prompt parts to app-server inputs. Reject unsupported content with AI SDK warnings/errors rather than silently dropping it.
3. Start a thread and turn, then map:
   - `item/agentMessage/delta` to text stream parts;
   - reasoning summary boundaries/deltas to reasoning parts;
   - raw reasoning deltas when available and representable;
   - `turn/completed` and `error` to one terminal finish/error.
4. Track item IDs so interleaved reasoning and text maintain correct boundaries.
5. Map provider abort to `turn/interrupt` and wait for terminal completion before releasing thread ownership.

Tests:

- text only, reasoning plus text, interleaving, empty response;
- failed/interrupted turns and mid-stream transport loss;
- slow consumer/backpressure and abort races.

Exit criteria: `streamText` exposes live text and reasoning with no duplicate or missing terminal event.

## Stage 4 — Thread coordinator and request continuity

Work:

1. Add a coordinator keyed by Codex thread ID with single-turn ownership and explicit states (`idle`, `running`, `interrupting`, `closed`).
2. Start a thread for new conversations and use `thread/resume` for a supplied ID that is not loaded/owned by the connection.
3. Return `threadId` and `turnId` in namespaced provider metadata on response/finish parts.
4. Read that metadata from subsequent AI SDK prompt/tool-result steps and reuse the same thread. Avoid replaying earlier messages already persisted in Codex; send only the new continuation inputs.
5. Define deterministic behavior for missing/stale metadata, concurrent continuations, failed turns, and caller-requested fresh threads.
6. Keep a thread alive for the full outer streaming/tool loop and release it only at terminal completion/abort. Never share a thread across unrelated requests based only on prompt equality.

Tests:

- multiple sequential turns reuse one thread;
- tool steps in one `streamText` run retain one thread ID;
- unrelated requests receive different threads;
- concurrency cannot start two turns on one thread;
- abort followed by explicit resume is safe.

Exit criteria: integration traces demonstrate the minimum possible number of threads and turns for text-only and multi-tool streams.

## Stage 5 — Vercel dynamic tools

Work:

1. Convert AI SDK tool definitions to `thread/start.dynamicTools`, preserving name, description, and JSON Schema. Validate Codex naming/reserved-namespace constraints before starting a turn.
2. Implement the bridge selected in Stage 0 for `item/tool/call` and correlate by `callId`, `threadId`, and `turnId`.
3. Stream standards-compliant tool-call parts, execute through the Vercel tool path, and return a Codex `contentItems` response with an explicit `success` value.
4. Define lossless mappings for JSON/text results and errors. Initially reject unsupported binary/remote-image outputs.
5. Support sequential and parallel calls, duplicate response protection, execution timeout, thrown errors, malformed arguments, and caller abort.
6. Ensure the final Codex answer continues on the originating thread, preferably in the active turn when the verified contract permits it.

Exit criteria:

- real `streamText` tests cover one tool, multiple tools, tool failure, and abort;
- tool-call parts are consumable by standard AI SDK callbacks/UI conversion;
- no pending RPC remains after any terminal path.

## Stage 6 — Selective sandbox and web search

Work:

1. Define narrow provider options with secure defaults:
   - `sandbox: false | "read-only" | "workspace-write"` (exact final spelling follows the public package API);
   - `webSearch: boolean`, default `false`.
2. Map sandbox selection to the pinned app-server `sandbox`/`sandboxPolicy` representation. Never send both legacy sandbox fields and permission profiles.
3. Determine the pinned Codex configuration switch that controls availability of the built-in web-search tool and validate it with a real CLI test. Do not equate sandbox network access with web-search enablement.
4. Apply sticky thread settings consistently and reject incompatible per-turn changes that could silently alter an existing thread's authority.
5. Decide how built-in Codex `webSearch` items appear: expose as namespaced provider metadata unless an exact AI SDK source/tool part mapping exists in the pinned contract.

Tests:

- both capabilities absent by default;
- each capability independently enabled;
- workspace roots and network state are not widened;
- a resumed thread cannot accidentally inherit broader policy than requested.

Exit criteria: matrix tests and real CLI smoke tests prove independent, least-privilege behavior.

## Stage 7 — Usage and metadata

Work:

1. Consume `thread/tokenUsage/updated` snapshots and distinguish per-turn delta from cumulative thread totals.
2. Map available input, cached-input, output, reasoning, and total counts to the pinned AI SDK usage type; use `undefined`, not invented zeroes, for unavailable fields.
3. Attach namespaced Codex metadata such as thread ID, turn ID, model, and cumulative usage without leaking account details or filesystem paths.
4. Emit exactly one final usage record even if usage notifications arrive before or after `turn/completed`; define a short terminal drain rule if the protocol ordering requires it.

Tests:

- fresh and resumed threads;
- multiple turns where cumulative totals must not be double-counted;
- cached/reasoning tokens, missing fields, failure, and abort.

Exit criteria: usage agrees with captured app-server fixtures and remains correct after thread reuse.

## Stage 8 — Hardening, packaging, and release

Work:

1. Add fixture-based protocol tests plus opt-in real-Codex integration tests that do not require CI login.
2. Test supported Node platforms, binary discovery failures, spaces in paths, large deltas, backpressure, process restarts, and version/schema mismatch diagnostics.
3. Document installation, first login, model creation, dynamic tools, sandbox/web-search options, thread metadata continuation, abort, and disposal.
4. Publish ESM/CJS/types as required by the pinned AI SDK ecosystem, with a minimal export surface and no credential-handling dependency.
5. Add a compatibility table for provider, AI SDK, Codex CLI, and app-server schema versions.

Release gates:

- all in-scope acceptance tests pass against fake and real app-server paths;
- no experimental app-server dependency is undocumented;
- security defaults are tested, not merely documented;
- dynamic tools and thread reuse have trace-backed integration tests;
- package examples run from a clean install.

## Proposed module boundaries

```text
src/
  codex-provider.ts          Provider factory and public options
  codex-language-model.ts    Pinned AI SDK language-model contract
  app-server/process.ts      Child lifecycle and stderr handling
  app-server/rpc.ts          Bidirectional JSON-RPC over JSONL
  app-server/schema.ts       Generated or narrowed protocol types
  auth/chatgpt-login.ts      First-use auth gate
  threads/coordinator.ts     Thread ownership, resume, interruption
  adapters/prompt.ts         AI SDK prompt → Codex input
  adapters/stream.ts         Codex events → AI SDK stream parts
  adapters/tools.ts          Dynamic tool declarations/calls/results
  adapters/policy.ts         Sandbox and web-search mapping
  adapters/usage.ts          Usage snapshots/deltas and metadata
```

## Definition of done

A consumer can install the package, call `streamText` with a Codex model, complete ChatGPT login only when needed, observe streamed reasoning/text/tool calls, execute Vercel tools, independently opt into sandbox and web search, receive accurate usage metadata, abort safely, and continue all compatible steps on the same Codex thread. No out-of-scope app-server feature is exposed as public API.
