# Stage 09: Fresh fallback at continuation admission

## Status and goal

Implemented on 2026-09-04; the offline gates (`npm run check`), the restructured bounded tool/restart
scenario, and documentation alignment pass. The live scenario is adapted but awaits its explicitly
authorized run under the five-response maximum.

Keep successful same-thread continuation as implemented. When local checks show that a requested
continuation is unavailable, execute the supplied full transcript on one new Codex thread.
This stage changes admission, not execution recovery.

Retain `x_codex.threadReused`, store schema v0, existing record states, leases, native tool replay
guards, usage attribution, and HTTP/SSE serialization. No native fork or migration is included.

## Behavior and scope

Matching **available tool definitions** still permits native reuse; actual calls, arguments,
and results need not repeat. Reuse also requires the existing exact model, reasoning effort,
cwd, tools, and policy binding, plus raw-response capability on the current transport when
client tools are active. Changed bindings select a fresh thread with the validated requested
settings. `tool_choice: "none"` normalizes to no active tools and changes a tool-bearing binding.

After a proxy or app-server restart, missing raw-response capability selects fresh execution
for active client tools, even if the next response would contain only text. Tool-free native
restart continuation remains supported.

`previous_response_id` remains a nonstandard request extension but becomes a preference for
native continuation when local admission permits it. Clients should supply their complete
intended transcript. An older selector does not recover hidden native history: fresh execution
uses only that transcript. Continue with the new response ID returned by fresh execution.
The proxy cannot detect omitted earlier text or compare replayed text with native history.

The existing nonstandard response extension `x_codex.threadReused` remains unchanged:
`true` after native continuation accepts its turn; `false` for ordinary fresh execution or
fallback. Errors retain their current envelopes and metadata. No new public outcome enum is needed.

Fallback is selected **before any app-server setup RPC for this request**. Once either execution
path begins, every failure follows existing error handling. In particular, remote read/resume,
injection/start, persistence, transport, quota, and model errors never trigger a second execution.
This also applies to definitive start rejection and ambiguous acknowledgements.

## Current implementation

Entry points, with line numbers at drafting time:

| File | Existing behavior |
| --- | --- |
| `src/http/chat.ts:43` | Resolves implicit tool selectors before execution; serializers expose the boolean. |
| `src/http/chat-execute.ts:399` | Chooses native or fresh setup eagerly, before HTTP output. |
| `src/http/chat-execute.ts:831` | Checks local mapping/binding/tools, claims a lease, then resumes and delivers input. |
| `src/http/chat-execute.ts:967` | Fresh setup installs tools/raw events, injects history, and starts one turn. |
| `src/http/chat-validate.ts:410` | Pairs client calls/results and counts unanswered calls or orphan/duplicate results. |
| `src/continuation/state.ts:353` | Acquires a thread and its dynamic-tool owner atomically. |
| `src/continuation/state.ts:410` | Commits the existing pre-injection replay tombstone. |

No changes to `chat-normalize.ts`, generated protocol structures, or persistence format are required.

## Admission rules

Keep syntax and effective-policy validation in the HTTP handler. Preserve the client error
requiring an explicit selector when implicit tool continuation is disabled.

Move implicit lookup into execution admission. Evaluate the following rules synchronously,
including lease acquisition, without an `await`:

| Condition | Decision |
| --- | --- |
| No selector and no terminal tool-result block | Existing ordinary fresh execution. |
| Implicit lookup reports duplicate result IDs | Existing typed client error. |
| Implicit lookup reports unknown, expired, or ambiguous call IDs | Fresh fallback, subject to the transcript check below. |
| Selected mapping is missing, expired, or superseded | Fresh fallback, subject to the transcript check. |
| Selected live pending mapping receives invalid/incomplete matching results, or a live ready mapping receives tool results | Existing typed client error. |
| Native model, reasoning, cwd, tool, or policy binding differs | Fresh fallback, subject to the transcript check. |
| Active client tools lack raw-response capability on this transport | Fresh fallback, subject to the transcript check. |
| Compatible mapping cannot acquire its local lease | Fresh fallback, subject to the transcript check. |
| Compatible mapping acquires its lease | Existing native setup and execution. |

Validate results against a selected live pending batch before binding/capability/contention
fallback checks. Keep exact recorded call names and arguments checks. A complete but different
batch submitted against a live pending selector remains an error in this smaller stage.

Before selecting fallback, validate its complete supplied history using `toHistoryItems` with
the same history slice as fresh setup: exclude only a final user message, which becomes turn
input. Reject nonzero `unansweredCalls` or `orphanResults` with a typed 400 before any RPC.
A terminal tool-result block needs its complete preceding assistant call batch. Do not borrow
missing history from a mapping or silently discard client calls/results. Preserve existing
internal observational-tool replay rules.

This stricter pairing check applies to fallback. Ordinary fresh requests retain their existing
history handling; native continuation retains its existing validation.

Disposed coordinators, cancelled requests, and elapsed request deadlines remain errors, not
fallback reasons. Only named local unavailability conditions select fresh. Remote status,
identity, and resume checks remain in place: a thread that proves active/non-resumable remotely,
a malformed response, or a read/resume failure still returns an error.

### Checkpoint semantics

Fallback leaves the source checkpoint unchanged and creates its own response mapping on success.
It never injects into an expired or consumed native checkpoint. However, replaying a complete
transcript through such a selector now permits fresh execution, including when implicit lookup
reports a consumed record as unknown. This intentionally replaces the old HTTP replay rejection
with isolation on a new thread; it is not global duplicate suppression.

A live pending record bypassed because of binding, capability, or contention remains pending.
A later compatible request may still consume it natively. Separate HTTP requests can therefore
execute equivalent work on different threads. Existing guards prevent repeated injection into
the same native checkpoint only. Do not mark the source consumed merely because fallback ran,
and do not mutate a checkpoint owned by another request.

Direct-turn crash recovery remains as implemented. This stage adds no durable user-input claim,
exactly-once guarantee, or automatic recovery from ambiguous native execution.

## Implementation instructions

### 1. Extract local admission

In `src/http/chat-execute.ts`, add a private synchronous `prepareContinuation` helper returning
a small discriminated result:

- `fresh`, with an optional fixed internal fallback reason.
- `reuse`, with the selected response ID, stored record, and validated result map when needed.
  The existing execution handle owns the acquired lease.

Move local lookup, mapping/binding checks, tool validation, raw-response preflight, and lease
acquisition from `resumeContinuation` into this helper. Reuse `findPendingResponse`; catch only
its unknown/expired/ambiguous codes, not duplicate IDs or generic errors. Do not modify the
coordinator's lookup semantics or add a routing module.

Call admission inside the existing eager-setup `try`, after the queue, handle, callback, and
binding exist but before any RPC. Check cancellation before admission and fresh dispatch. Add a
small synchronous `ContinuationCoordinator.assertActive()` in `src/continuation/state.ts` that
throws when disposed; call it before admission and fresh dispatch. This exposes the existing
lifecycle guard without acquiring a dummy lease or changing persistence. Claim the existing lease last,
only for reuse, and attach the source thread ID to the handle only after acquiring it.
A fresh result must not retain the rejected source's thread ID or lease.

Remove implicit lookup and mutation of `request.previousResponseId` from `src/http/chat.ts`.
Pass the resolved ID through the reuse result instead. Do not clear the request's selector or
re-run HTTP validation to force fresh execution.

Use a narrow helper in `chat-validate.ts` for fallback pairing validation if useful. Reuse
`toHistoryItems` and the existing typed-error factory. Perform this check before fresh setup.
Log one fallback diagnostic with a fixed reason code and request ID; omit transcript, arguments,
and raw thread IDs.

### 2. Execute the chosen path once

Replace the selector branch in `execute` with the admission result. Fresh calls
`startFreshThread` once. Reuse calls `resumeContinuation` with the prepared record, selected
ID, and results, without a second lookup or lease acquisition.

Keep remote resume, injection, start, cleanup, and terminal handling in their existing order.
Preserve `protectPendingFromReplay` before native injection and best-effort
`recordPendingConsumed` afterward. The setup catch still cleans up and throws. Add no retry
catch, recursive execution, or transition back to admission.

Check capability using the existing transport-scoped `rawResponseThreads(options.rpc)` set.
Do not persist capability or infer it from matching definitions. Existing generation disposal
and signal checks remain authoritative; replacement during execution returns an error.

The fresh helper already injects all history and uses empty turn input when the request ends
with tool results. Update its obsolete comment that terminal tool blocks cannot reach it.
Fallback must pass the pairing check before `thread/start`; the existing fresh helper then
installs requested tools and raw events.

Keep boolean metadata and usage attribution: reuse uses the stored baseline; fresh uses zero.
Keep first-chunk SSE metadata, pre-header errors, event filtering, stream termination, and
final mapping-write behavior. No changes to public error or response schemas are needed.

### 3. Verify and document

Extend existing tests and shared fake-server scenarios:

| Case | Required evidence |
| --- | --- |
| Current ready/pending mapping with matching definitions and capability | Same thread, `threadReused: true`; actual tool calls may differ. |
| Unknown/expired/older selector, each binding mismatch, local contention | One fresh thread/turn, full transcript, `false`; no source RPC or source mutation. |
| Implicit unknown/expired/ambiguous lookup, including consumed calls | Complete transcript executes fresh; duplicate IDs or incomplete pairs fail before RPC. |
| Restart with active tools, explicit and implicit selection | Fresh before source RPC, even for a text-only request; actual new tool batches remain deliverable. |
| Tool-free restart | Existing native reuse succeeds. |
| Live pending record with missing/foreign/duplicate results or changed recorded arguments | Existing client error; no injection or fallback. |
| Malformed input, forbidden policy, implicit-disabled missing selector | Typed error and no thread start. |
| Remote read/resume failure; injection/start rejection, timeout, malformed/lost acknowledgement | Existing error and cleanup; no fresh retry. |
| Accepted quota/rate-limit/model failure, before/after output | One execution; existing JSON/SSE error, reset metadata, and stream termination. |
| Cancellation, stale coordinator, replay-guard/final mapping-write failure | Existing lifecycle/error behavior; no retry or leaked lease. |
| Fresh fallback fails | Return its error; no second attempt. |
| Aggregate/SSE success | Existing boolean shape; only chosen execution's output and exact usage. |

Primary files are `test/continuation/thread-continuation.test.ts`,
`test/http/dynamic-tools.test.ts`, `test/http/chat.test.ts`, and
`test/http/chat-sse.test.ts`. Reuse existing lifecycle and state tests.
Assert source lease ownership is unaffected by a contending fallback, and an untouched pending
source can still be consumed later. A disposed coordinator with an otherwise open fake transport
must reject before any RPC. Assert RPC/model-call counts and absence of `thread/fork`.

Add only needed existing-method scenarios/builders to `test/support/chat-backends.ts` and
`test/support/protocol-fixtures.ts`, typed against generated structures. Update restart
expectations in `test/support/chat-contract.ts`. No fork handler or response type is needed.

When implementing, align the root README, `protocol/CONTRACT.md`, `CHANGELOG.md`,
`plans/05-tools-and-threads.md`, and `plans/README.md`. Replace never-fresh, unconditional
local-busy 409, older-reference, changed-binding, and replay-rejection rules with the bounded
admission behavior. Preserve remote setup errors and exact request/policy validation.
Update schema descriptions/fixtures only if they claim strict continuation; keep their shapes.
The upstream reference `docs/codex-app-server.md` needs no proxy-behavior rewrite.

Run `npm run check` after implementation, including build and test type-checks.

For live verification, retain the existing parallel-batch and three-consecutive-result coverage
in the tool/restart scenario, adapting its final restart expectation. Run in the dedicated live
configuration with **at most five upstream model responses across all attempts**, no retries,
only `gpt-5.6-luna`, identical available tools with `tool_choice: "auto"`, loopback,
temporary state/root directories, and a pure marker tool:

1. Fresh request includes a synthetic completed history round and requests the existing parallel
   batch. Assert `false` and the history marker in actual tool arguments: one model response.
2. Keep all three existing full-history result continuations on the same transport. Assert
   `true`, the same thread, and the existing intermediate batch/final-text expectations:
   three more model responses. Available definitions stay identical throughout.
3. Restart with retained state and continue from that final response using the complete history
   and the same available tools. Request an actual new tool batch. Assert `false`, a new thread,
   no source RPC, and tool delivery: one final model response. Do not submit this batch's results.

Text-only output does not pass a step requiring a batch. Cover restart from a pending checkpoint,
including implicit selection, offline. Keep this scenario within the live suite's existing
32-response ceiling, counting across restarts with the existing provider-call budget. Update quality/live documentation
only where the changed scenario requires it. Keep captures transient and live tests out of
default tests and PR CI. Drafting this plan incurs no live model calls.

Stage 09 completes after the offline checks, bounded live scenario, and documentation alignment
pass. There is no migration gate.

## Deferred work

Native fork, remote-setup fallback, retry after dispatch, four-value continuity metadata, new
checkpoint states, durable direct-turn claims, strict store migration, commit-then-publish store
changes, successful-output recovery from mapping failure, and hidden-history recovery are
separate work. None is a prerequisite for local admission fallback.
