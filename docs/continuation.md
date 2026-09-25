# Continuation and client tools

This page explains how the proxy preserves a Codex thread across Chat Completions requests. It is for contributors changing continuation, dynamic tools, or usage accounting. For the client request format, see [Function tools and Codex-specific extensions](../README.md#function-tools).

## Durable response mappings

The proxy returns an opaque Chat Completions response ID and stores its Codex thread mapping in `continuations.json` under the configured state directory. The store uses schema version `0`, writes a same-directory temporary file followed by atomic rename, and treats unreadable or unsupported data as untrusted. Records expire after 30 days by default; a newer response on the same thread supersedes its previous ready or pending record. The store retains expired records for a further retention interval before pruning them.

| Stored value                                                                               | Why it matters                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Response ID, thread ID, state, and timestamps                                              | Select the newest usable checkpoint without exposing a raw Codex thread ID to clients. States are `ready`, `pending_tool`, `expired`, and `superseded`. |
| Model, reasoning effort, canonical working directory, tool hash, and effective-policy hash | Native reuse requires an identical thread binding. The hashes use SHA-256 over recursively key-sorted JSON, with ordering independent of locale.        |
| Pending call ID, name, and exact argument string                                           | Rebuild each complete `function_call`/`function_call_output` pair after a client returns tool results, including after a proxy restart.                 |
| Optional exact cumulative `usageTotal`                                                     | Establish the next response's token-accounting boundary without estimating missing usage. An all-zero boundary is valid.                                |

The [store schema](../protocol/schemas/response-mapping.schema.json) describes the persisted shape. `ResponseStore` owns disk writes and retention; `ContinuationCoordinator` owns transport-generation leases and dynamic-tool callback routing. Both live in [`src/continuation/state.ts`](../src/continuation/state.ts).

## Admission before execution

[`prepareContinuation`](../src/http/chat-execute.ts) makes one synchronous selection. An explicit `previous_response_id` selects a record; without one, a terminal contiguous tool-result block can identify exactly one unexpired pending record by its call IDs. Implicit lookup can be disabled through the CLI. Request validity and continuation compatibility are separate: malformed values, duplicate assistant IDs, and duplicate results in the selected batch are client errors, while a valid but mismatched batch selects fresh execution. Exact argument strings are required for native reuse, even when two strings parse to equivalent JSON. A ready record receiving results is also incompatible. A compatible record must have an available local thread lease.

| Condition                                                                                                                  | Outcome                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| No selector and no terminal tool results                                                                                   | Start a fresh Codex thread.                                                                                                                          |
| Unknown, expired, or superseded record; ambiguous or unavailable implicit lookup                                           | Execute the supplied transcript on a fresh thread.                                                                                                  |
| Changed model, reasoning effort, canonical working directory, declared tools, or effective policy; local thread contention | Execute the supplied transcript on a fresh thread, leaving the source mapping intact.                                                                |
| Changed call IDs, names, exact arguments, missing or foreign results; results against a ready record                         | Execute the supplied transcript on a fresh thread, leaving the source mapping intact.                                                                |
| Active client tools but no raw-response batch capability on the current transport                                          | Execute on a fresh thread. This includes active-tool continuations after an app-server restart. Tool-free restart continuation can reuse the thread. |
| Matching current record, compatible results, and available lease                                                           | Read and resume the mapped thread, inject results, then start one turn.                                                                              |
| Busy/non-resumable read or resume status, returned thread ID mismatch, or RPC error response                               | Release source ownership and execute once on a fresh thread.                                                                                        |
| Duplicate assistant call IDs or duplicate results in the selected batch                                                    | Return an ambiguous-input client error before execution.                                                                                            |
| Malformed response envelope, cancellation, transport failure, local policy/configuration error, or persistence failure     | Return the error; do not dispatch a replacement execution.                                                                                          |
| Pending replay protection, result injection, or turn start already attempted                                                | Return the error; do not dispatch a replacement execution.                                                                                          |

Fresh execution uses the ordinary fresh-request transcript mapping, whether selected initially or reached after a continuation mismatch or read/resume preflight. System messages become base instructions. Complete historical assistant tool-call/result pairs are injected; unanswered calls and orphan results are dropped and produce one structured `unpaired_history_tool_items_dropped` warning. The final user message becomes turn input, or input is empty when there is no user message. Repeated IDs across historical rounds are allowed, while duplicate assistant IDs and duplicate result IDs within the selected continuation batch remain ambiguous input. Only submitted history can be reconstructed: any earlier context omitted from the transcript is lost. Native reuse retains the stored Codex history and injects only the selected pending results and new user input. A fresh fallback reports `x_codex.threadReused: false` and leaves the source checkpoint intact for a later matching request.

## Tool batch and result handoff

Fresh threads enable raw app-server response events. Direct declared `function_call` items and the matching `rawResponse/completed` delimit a client-tool batch; callbacks are merged by call ID. A callback dispatched after its raw completion gets a one-second quiet window, reset by another callback. The proxy durably records the batch, interrupts the originating Codex turn, and returns `finish_reason: "tool_calls"`. Cancelled app-server callbacks are left unanswered because the interrupt already resolved them. No Codex turn remains parked while the client runs its functions.

```mermaid
sequenceDiagram
    participant Client
    participant Proxy
    participant Store
    participant Codex as app-server
    Client->>Proxy: Completion with declared tools
    Proxy->>Codex: thread/start, turn/start
    Codex-->>Proxy: function_call items, rawResponse/completed
    Proxy->>Store: Persist pending_tool batch
    Proxy->>Codex: turn/interrupt
    Proxy-->>Client: tool_calls and opaque response ID
    Client->>Proxy: Tool results, optional following user messages
    Proxy->>Store: Select, validate, and lease checkpoint
    Proxy->>Codex: thread/read, thread/resume preflight
    alt Compatible and resumable
        Proxy->>Store: Mark checkpoint expired before injection
        Proxy->>Codex: thread/inject_items with call/result pairs
    else Incompatible or unavailable
        Proxy->>Store: Release source lease and settle queued callbacks
        Proxy->>Codex: thread/start with reconstructed transcript
    end
    Proxy->>Codex: turn/start with final user message, if any
    Codex-->>Proxy: New turn events
    Proxy->>Store: Persist new response mapping
    Proxy-->>Client: Completion
```

For a live pending batch, validation checks the immediately preceding assistant call batch against recorded IDs, names, and exact argument strings, requiring an unambiguous set of results for native reuse. A valid transcript that differs in IDs, names, arguments, or result membership falls back to a fresh thread. In particular, a user message within a parallel result block leaves the selected batch incomplete and selects fallback; it is not by itself malformed input. Implicit continuation accepts only a terminal tool-result block. An explicit selector can accept that block followed by consecutive user messages. On reuse, suffix users are injected after the result pairs in order; the last becomes turn input. On fallback, ordinary transcript mapping injects complete historical tool pairs and uses the last user message as input, dropping unanswered calls or orphan results with the structured warning. Earlier completed tool rounds in a replayed transcript do not participate in current-batch correlation, and repeated IDs across those rounds are allowed.

Before injecting results, the proxy durably marks the pending record `expired`. This replay guard survives an ambiguous injection failure; successful injection then best-effort marks it `superseded`. A new response mapping is written for the continued turn. Process-local tombstones separately prevent delayed callbacks from an interrupted turn from being routed to a newer turn on the same thread.

## Usage boundary

The event normalizer attributes exact app-server token totals from the current turn, excluding pre-turn usage replayed by `thread/resume`. A response may span several upstream model requests, so it subtracts its stored cumulative baseline from the latest complete `thread/tokenUsage/updated` total. If complete cumulative attribution is unavailable, it can use an attributable exact `last` breakdown; unavailable counts are omitted. Raw response usage is not added to HTTP usage because that could count the same tokens twice.

Completed and interrupted turns collect updates for a fixed one-second window after the first idle notification. Earlier usage and later corrections do not end or extend that window. A ten-second terminal collection backstop, request abort, or transport/queue failure can end it sooner. This adds up to one second after idle before aggregate output or streaming terminal frames; text and tool deltas still stream as they arrive.

After persisting the continuation, streaming emits the final usage once in an empty-choice chunk, then the finish reason and `[DONE]`. Unlike the previous finish-then-usage ordering, this lets clients stopping at `finish_reason` receive counts without duplicate usage records. Clients must locate the usage field instead of assuming usage occupies the last chunk. Explicit `stream_options.include_usage: false` suppresses only its HTTP output, not collection or boundary persistence.

Each successful response records the exact boundary the next response should use. A pending tool response that receives no usage keeps its starting boundary, allowing the continuation to report those tokens when app-server later attributes them. The handoff therefore does not invent usage or discard a known zero boundary. See [`src/http/chat-normalize.ts`](../src/http/chat-normalize.ts) for attribution and [`src/http/chat-execute.ts`](../src/http/chat-execute.ts) for persistence at terminal events.
