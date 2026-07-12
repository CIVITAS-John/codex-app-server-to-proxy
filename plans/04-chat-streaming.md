# Stage 04: Chat Completions translation and streaming

## Goal

Translate the supported Chat Completions subset to app-server threads/turns and stream faithful Chat Completion chunks.

## Work

1. Validate `model`, `messages`, `stream`, `stream_options`, `tools`, `tool_choice`, `previous_response_id`, and `x_codex`; collect harmless unsupported fields for one structured warning.
2. Convert system/developer/user/assistant/tool messages into app-server input using the history mechanism decided in Stage 01.
    - `turn/start` input carries no roles, so never silently collapse role or order into plain user text without documenting it.
3. Start a thread when no continuation exists, then start a turn with the request model and policy settings.
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
