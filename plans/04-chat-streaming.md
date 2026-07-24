# Stage 04: Chat Completions translation and streaming

## Goal

Translate the supported Chat Completions subset to app-server threads/turns and stream faithful Chat Completion chunks.

## Work

1. Validate `model`, `reasoning_effort`, `messages`, `stream`, `stream_options`, `tools`, `tool_choice`, `previous_response_id`, and `x_codex`. Reject any value that cannot be applied faithfully; warn only for fields proven harmless to ignore.
2. Convert system/developer/user/assistant/tool messages into app-server input using the history mechanism decided in Stage 01.
    - `turn/start` input carries no roles, so never silently collapse role or order into plain user text without documenting it.
3. Start a thread when no continuation exists, then start a turn with the request model, reasoning effort, and policy settings proven enforceable in Stage 01.
4. Create a single event-normalization layer for app-server item lifecycle and delta notifications.
    - Treat `item/*` notifications as the canonical item stream.
    - `turn/completed` currently carries an empty `items` array and must not be relied on for content.
5. Translate assistant text to the standard `choices[0].delta.content` shape and exposed reasoning text to the nonstandard direct compatibility field `choices[0].delta.reasoning`; request a detailed app-server reasoning summary by default so those deltas are emitted, but disable it for explicit `reasoning_effort: "none"` and do not expose the app-server `reasoning_summary` naming.
6. Normalize internal command, file, MCP, web-search, collaboration, approval, and other supported tool-like activity into the standard function-shaped `tool_calls` shape and the nonstandard direct compatibility field `tool_results`.
    - Correlate lifecycle events directly through the matching `id` repeated in `tool_calls` and `tool_results`; expose only a stable tool name, bounded arguments/output or progress, terminal status, and structured error.
    - When correlated `item/*` progress arrives without an observed start, synthesize a bounded generic function-shaped call from its `itemId` and a safe method-derived name, then emit that call with its result. Do not expose unknown global notifications.
7. Produce stable response, choice, and tool-call IDs; preserve event ordering per item while allowing interleaved items.
8. Emit standard finish reasons where applicable: `stop`, `length`, `tool_calls`, and `content_filter`; map other terminal states to an error or documented extension.
    - A mid-turn `error` notification may precede `turn/completed` with `status: "failed"` carrying the same payload; deduplicate into one client-visible error.
9. For `stream_options.include_usage`, emit a final usage-bearing chunk with empty choices before `[DONE]`.
    - Include cached and reasoning details only when reported.
    - `thread/resume` replays restored `thread/tokenUsage/updated` notifications before any turn starts; usage attribution must ignore these pre-turn replays per the Stage 01 attribution decision.
10. Implement `stream: false` by aggregating the same normalized event stream into `content`, `reasoning`, `tool_calls`, and `tool_results`. Preserve concatenated text when tool calls also exist.
11. Propagate client disconnect to turn interruption unless a documented pending-tool suspension owns the turn.

## Acceptance criteria

- Golden fixtures cover text, reasoning summary/text, multiple interleaved items, internal tools, usage, empty output, interruption, error, and disconnect.
- SSE frames are valid under arbitrary JSON-RPC chunk boundaries and HTTP backpressure.
- Streaming chunk order faithfully reconstructs text, reasoning, calls, and results.
- Missing usage detail is omitted and never synthesized.
- Non-streaming output matches the aggregation of streaming output.

## Implemented decisions

- A fresh request must end in one text-only user message. Earlier system, developer, user, and assistant messages are passed to `thread/inject_items` as role-preserving raw Responses API message items; they are never flattened into user text.
- Standard `reasoning_effort` accepts the documented Chat Completions values and maps directly to app-server `turn/start.effort`. App-server controls reasoning work and exposed summaries separately, so `turn/start.summary` defaults to `"detailed"`, while explicit `none` maps to `summary: "none"`. Reasoning effort is part of the durable thread binding and must match on continuation so omission or a changed value cannot silently inherit different sticky state.
- A replayed assistant message may include the proxy's nonstandard string `reasoning` response extension, the equivalent `reasoning_content` field that OpenAI-compatible clients such as the Vercel AI SDK replay in its place, and a structurally valid, self-correlating `tool_calls`/`tool_results` transcript of already-executed Codex activity. The proxy accepts and discards those observational fields, injecting only non-null assistant `content` and skipping tool-only assistant messages; malformed values remain invalid, and client-defined tool continuation still requires matching `role: "tool"` messages.
- One stateful event normalizer maps both streaming and non-streaming output. Streaming order is chunk order. Reasoning deltas are emitted immediately; a completed reasoning item backfills only text not already emitted by that item's summary or raw-reasoning deltas.
- Reasoning uses `reasoning`, and internal app-server tools use function-shaped `tool_calls` plus self-correlating `tool_results`. Internal tools remain observational and never produce `finish_reason: "tool_calls"`.
- One explicit notification registry distinguishes dedicated normalization, generic `itemId`-correlated progress, intentionally ignored lifecycle metadata, and diagnostic-only methods. Unstable approval auto-review notifications and terminal-interaction input remain bounded redacted diagnostics rather than public activity. Every intentionally handled notification is structurally required to appear in the generated-protocol-typed event corpus, so adding a known method cannot silently opt it into HTTP output.
- Non-streaming output aggregates the identical direct fields. Pre-tool text remains in `message.content`, which may coexist with calls and results.
- Usage attribution begins only after `turn/start` returns and accepts only matching thread and turn notifications. The exact `tokenUsage.last` values are mapped; unavailable details are omitted.
- Client abort requests `turn/interrupt` for an active turn. Streaming writes wait for HTTP drain before consuming another normalized event, and response closure terminates that wait so a disconnected or timed-out client cannot strand the handler.
- Stage 05 implements `previous_response_id` and tool-result continuation. Nonempty policy `x_codex` objects remain rejected until Stage 06 can enforce their full contract.

These decisions expose exact reasoning, text, tool, result, and later-output order without a response-side `x_codex` activity transcript. Clients relying on unsupported policy extensions receive an explicit validation error instead of fallback behavior.
