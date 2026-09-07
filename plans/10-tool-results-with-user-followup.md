# Tool results followed by user messages

## Status and goal

Implemented on 2026-09-06; the offline gates pass (`npm run check`, 26 files
and 329 tests). Every acceptance row is covered by the offline suites:
injection and turn-start failure are exercised with the new suffix, and
cancellation keeps its pre-existing disconnect and abort coverage on the
unchanged shared abort path. No live model run was performed, and none is
required by this plan. An explicit `previous_response_id` selecting a live
pending tool batch continues when its complete result block is followed by
one or more consecutive user messages. `previous_response_id` remains a
nonstandard request extension.

Success means the matching results and every following user message reach one
execution, in order. Compatible native execution reports the response extension
`x_codex.threadReused: true`; existing local unavailability checks still select
fresh execution with `false`. Missing or invalid pending results remain errors.

## Findings and decision

The exact reported shape can continue on the existing Codex thread. It does not
require steering an active turn or a new app-server capability:

- `src/http/chat-execute.ts:553` interrupts the original tool-call turn before
  handing the pending batch to the client. Pending state is a proxy checkpoint,
  not a suspended app-server request waiting for a result response.
- `src/http/chat-execute.ts:1001` resumes the idle thread, protects the pending
  checkpoint against replay, injects complete call/result pairs, and starts a turn.
- `src/http/chat-execute.ts:1166` already uses the final user message as turn input.
- `protocol/generated/typescript/v2/ThreadInjectItemsParams.ts` permits raw
  Responses history items; fresh execution already uses these for user history.
- The blocker is local admission: `src/http/chat-validate.ts:57` selects only a
  terminal tool block, `src/http/chat-execute.ts:919` rejects an empty selection,
  and `src/http/chat-validate.ts:516` finds the assistant relative to transcript end.

Prefer native continuation over unconditional fresh fallback: it preserves native
history and uses the established execution path. This is a source-level conclusion;
the new request shape has not been verified in a live model run. The checkout pins
Codex 0.153.4; its package version reads 0.1.0-rc.23 despite the report naming rc.24.

## Implementation plan

1. In `src/http/chat-validate.ts`, introduce a small typed batch-selection helper
   carrying the immediately preceding assistant message, its contiguous tool
   result block, and the following user messages. Walk backward over the final
   consecutive user messages, then over tool results. Never search older rounds
   for matching IDs or merge separated result blocks. Permit zero user messages
   so terminal tool continuation can use the same correlation representation.
   Keep `terminalToolResults` and its validation-time meaning unchanged. Update
   its documentation comment: it remains the implicit-selector view, but is no
   longer the sole view used for explicit pending-batch correlation.

2. Change `validateToolResults` to receive the selected assistant and result block
   explicitly, instead of calculating the assistant from the transcript length.
   Preserve exact pending call IDs, names, argument strings, one result per call,
   and current treatment of observational internal activity. Do not relax
   foreign, duplicate, partial, or malformed-result checks.

3. In `prepareContinuation`, use the broader selection only for an explicit
   selector whose record is `pending_tool`. Implicit selection continues to use
   terminal results only. Validate the selected batch before binding, capability,
   or contention fallback. No candidate results still returns the existing
   `409 tool_results_required`; an invalid candidate retains its typed 400.
   Carry validated results and any earlier suffix user messages in reuse admission.
   A missing, expired, superseded, incompatible, or contended selection retains
   existing fresh admission and complete-transcript pairing validation.

4. In `resumeContinuation`, append all suffix user messages except the last to
   the call/result injection, preserving separate user messages and their order.
   Reuse the role-preserving history mapper for these user-only items. For one
   trailing user message, no extra injected items are needed. The final user
   message remains `turn/start.input`; a terminal tool block retains empty input.
   Keep the single pre-injection replay tombstone, consumed-record handling,
   usage baseline, lease ownership, and cleanup. Never inject earlier transcript
   history on the native path. Do not add fallback after any native setup RPC.

5. Add deterministic regressions to `test/http/dynamic-tools.test.ts` and the
   admission cases in `test/continuation/thread-continuation.test.ts`. Extend
   existing typed fakes only where request capture or failure scripting needs it.
   Add documentation comments to new top-level source and test definitions.

6. Update README continuation/tool guidance, `plans/05-tools-and-threads.md`,
   `plans/09-thread-continuity.md`, and `plans/README.md` with the accepted suffix,
   retained errors, and unchanged implicit-selection rules. Mark this proposal
   implemented only after its acceptance checks pass. No version bump, generated
   protocol change, persistence migration, or new public field is needed.

## Acceptance checks

| Case | Required evidence |
| --- | --- |
| Explicit live pending selector, matching parallel results, final user | Same thread; one read/resume/injection/start sequence; pairs in recorded call order; final user exactly once as turn input; no thread/start. |
| Multiple consecutive suffix users | Earlier users injected after pairs in order; final user supplied once as turn input. |
| Aggregate and streaming responses | Correct final output; `x_codex.threadReused: true` once on the aggregate or first SSE chunk; replayed client calls/results not emitted as new activity. |
| Earlier completed tool rounds | Only the selected final batch and new user suffix enter native execution; no historical replay or selection of an older matching batch. |
| Missing/partial/foreign/duplicate results, changed call name/arguments, missing assistant | Existing typed errors before any setup RPC; source stays pending and a corrected request can consume it. Include these cases with trailing users. |
| User message splitting a parallel result batch | Rejected; separated blocks cannot be combined to satisfy the pending batch. |
| No selector, completed tool round then user | Remains ordinary fresh execution, including when implicit continuation is disabled. |
| Terminal tool results and ready-record user continuation | Existing explicit/implicit continuation and ready-record behavior remain unchanged. |
| Changed binding, restart capability loss, local contention, unavailable record | One fresh execution of the complete supplied transcript, `threadReused: false`; pending source and any source lease remain untouched. Malformed fallback pairing fails before RPC. |
| Injection failure, start failure, cancellation | Existing tombstone/lease cleanup semantics; no second execution or fresh retry inside the request. Exercise failures with the new suffix. |

Run the focused offline suites first, then `npm run check`. No live test is
required to implement this change, and none is run during planning. If a live
gate is requested, use the dedicated live configuration, serial execution,
`gpt-5.6-luna`, capped output, and a maximum of two model responses: one tool-call
response and one results-plus-user continuation, with no automatic retry.

## Boundaries and risks

The new native suffix consists only of contiguous tool results followed by
consecutive user messages. Arbitrary assistant/system/developer messages after
the selected batch, interleaved tool rounds, and reconstruction of omitted history
are outside this fix; do not silently skip such messages to find an older batch.
Native continuation retains its existing trust in prior native history rather
than comparing the entire replayed transcript. Ready-record and implicit selector
semantics are unchanged. Existing fallback may execute equivalent work on a
different thread, and existing replay guards protect only the native checkpoint.
