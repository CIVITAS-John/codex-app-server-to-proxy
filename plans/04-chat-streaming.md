# Stage 04: Chat Completions translation and streaming

## Goal

Translate the supported Chat Completions subset to app-server threads/turns and stream faithful Chat Completion chunks.

## Work

1. Validate `model`, `messages`, `stream`, `stream_options`, `tools`, `tool_choice`, `previous_response_id`, and `x_codex`. Reject any value that cannot be applied faithfully; warn only for fields proven harmless to ignore.
2. Convert system/developer/user/assistant/tool messages into app-server input using the history mechanism decided in Stage 01.
    - `turn/start` input carries no roles, so never silently collapse role or order into plain user text without documenting it.
3. Start a thread when no continuation exists, then start a turn with only the request model and policy settings proven enforceable in Stage 01.
4. Create a single event-normalization layer for app-server item lifecycle and delta notifications.
    - Treat `item/*` notifications as the canonical item stream.
    - `turn/completed` currently carries an empty `items` array and must not be relied on for content.
5. Translate assistant text to `choices[0].delta.content` and exposed reasoning to documented `choices[0].delta.x_codex.reasoning` parts.
6. Translate internal shell, file, MCP, web-search, approval, and tool-result activity to typed `x_codex` deltas. Do not disguise internal activity as a client-defined function call.
7. Produce stable response, choice, and tool-call IDs; preserve event ordering per item while allowing interleaved items.
8. Emit standard finish reasons where applicable: `stop`, `length`, `tool_calls`, and `content_filter`; map other terminal states to an error or documented extension.
    - A mid-turn `error` notification may precede `turn/completed` with `status: "failed"` carrying the same payload; deduplicate into one client-visible error.
9. For `stream_options.include_usage`, emit a final usage-bearing chunk with empty choices before `[DONE]`.
    - Include cached and reasoning details only when reported.
    - `thread/resume` replays restored `thread/tokenUsage/updated` notifications before any turn starts; usage attribution must ignore these pre-turn replays per the Stage 01 attribution decision.
10. Implement `stream: false` by aggregating the same normalized event stream, avoiding a second translation path.
11. Propagate client disconnect to turn interruption unless a documented pending-tool suspension owns the turn.

## Acceptance criteria

- Golden fixtures cover text, reasoning summary/text, multiple interleaved items, internal tools, usage, empty output, interruption, error, and disconnect.
- SSE frames are valid under arbitrary JSON-RPC chunk boundaries and HTTP backpressure.
- A generic SSE parser can ignore every `x_codex` field and still reconstruct standard text/tool calls.
- Missing usage detail is omitted and never synthesized.
- Non-streaming output matches the aggregation of streaming output.

## Implemented decisions

- A fresh request must end in one text-only user message. Earlier system, developer, user, and assistant messages are passed to `thread/inject_items` as role-preserving raw Responses API message items; they are never flattened into user text.
- One stateful event normalizer owns item indexes and maps both streaming and non-streaming output. Assistant text uses standard `delta.content`; reasoning and internal app-server activity use typed `x_codex` extensions. Dynamic tool-call starts use standard `delta.tool_calls`, while the pending-result lifecycle remains Stage 05 work.
- Usage attribution begins only after `turn/start` returns and accepts only matching thread and turn notifications. The exact `tokenUsage.last` values are mapped; unavailable details are omitted.
- Client abort requests `turn/interrupt` for an active turn. Streaming writes wait for HTTP drain before consuming another normalized event.
- `previous_response_id`, tool-result messages, and nonempty policy `x_codex` objects are rejected until Stages 05 and 06 can enforce their full state and policy contracts.

These decisions add working fresh-completion compatibility without changing the planned continuation or policy contracts. Clients relying on later-stage extensions receive an explicit validation error instead of fallback behavior.
