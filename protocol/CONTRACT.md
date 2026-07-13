# Stage 01 compatibility contract

This contract targets `codex-cli 0.144.0-alpha.4`. The checked-in TypeScript and JSON Schema artifacts were generated with `--experimental`; they are the wire-type source of truth. Regenerate them with `npm run generate:protocol` after changing the pinned Codex version.

## Request fields

| Field | Classification | Mapping |
| --- | --- | --- |
| `model` | Standard, required | `thread/start.model`; must match on continuation. |
| `messages` | Standard, required | A new thread accepts exactly one user text message. On continuation, accept the omitted history or the canonical assistant tool-call plus matching tool results. Other history is rejected as `unrepresentable_message_history`; no role flattening occurs. |
| `tools` | Standard | Function tools become experimental `dynamicTools`. Their canonical JSON SHA-256 must match on continuation. |
| `tool_choice` | Standard, restricted | Omitted or `auto` only. `none`, `required`, and named choices are rejected as `unsupported_tool_choice` because this app-server has no faithful per-turn equivalent. |
| `stream` | Standard | `true` streams SSE. `false` buffers the same event pipeline and emits one response. |
| `stream_options.include_usage` | Standard | When true, an otherwise empty final choices array carries attributable usage before `[DONE]`. |
| `previous_response_id` | Nonstandard continuation field | Resolves a durable local mapping and always preflights `thread/resume`; never falls back to `thread/start`. Tool-result continuation requires this field and `tool_call_id`. |
| `x_codex` | Nonstandard extension | Validated by `schemas/x-codex.schema.json`; contains `cwd`, sandbox, and web-search policy. |
| `temperature`, `top_p`, `n`, `stop`, `max_tokens`, `max_completion_tokens`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `logprobs`, `top_logprobs`, `seed`, `response_format`, `modalities`, `audio`, `prediction`, `service_tier`, `store`, `metadata`, `user`, `parallel_tool_calls` | Rejected | Each lacks an exact mapping in the pinned app-server. Return `unsupported_parameter`; never approximate. |
| Any unknown top-level field | Ignored with warning | Emit one structured `unsupported_field_ignored` warning per request, not one per occurrence. Unknown fields under `messages`, `tools`, or `x_codex` are rejected as malformed/ambiguous. |

## Protocol mapping

| App-server method/event | Proxy behavior |
| --- | --- |
| `initialize`, `initialized` | Required once before other traffic. Experimental capabilities are enabled by the generated contract. |
| `thread/start` | Creates a new thread only after validation succeeds. Supplies model, cwd, policy, `approvalsReviewer: auto_review`, and dynamic tools. |
| `thread/resume` | Preflight for every mapped continuation. Restored token usage is ignored for new-response attribution. |
| `turn/start` | Starts one turn on a non-busy thread. Input is user text or the tool result delivered to a pending dynamic request. |
| `item/agentMessage/delta` | Standard `choices[0].delta.content`. |
| `item/tool/call` request | Standard function `tool_calls` fragments; request remains pending until continuation, timeout, disconnect, turn resolution, or shutdown. |
| reasoning delta events | `choices[0].delta.x_codex.reasoning`; never standard `content`. |
| command, file-change, MCP progress, approval state | `choices[0].delta.x_codex.activity`. Internal tools never produce standard client tool calls. |
| `thread/tokenUsage/updated` | Attribute only `last` usage observed after `turn/started`. Omit unavailable values and never subtract or estimate. Replayed resume usage is ignored. |
| `turn/completed` | Finalize mapping. Standard finish reason is `stop`, or `tool_calls` when client dynamic calls remain pending. Internal activity does not change the finish reason. |
| `error` or JSON-RPC error | OpenAI-shaped error; an SSE stream emits one error event and then closes without `[DONE]`. Overload `-32001` maps to retryable HTTP 503 before headers. |
| approval requests | Use `auto_review` when effective policy allows; immediately answer unexpected requests with decline. Approval state is diagnostic only. |
| `serverRequest/resolved` | Remove/cancel matching pending dynamic call. Duplicate client results are rejected. |
| account read/login events | `account/read` detects auth. `account/login/start` with ChatGPT opens the returned URL when possible; one interactive-terminal fallback may print it, but logs/state never retain it. |

Unknown app-server events are retained only in redacted diagnostics and are not exposed over HTTP.

## SSE mapping

The first chunk has `delta.role: "assistant"`. Text uses `delta.content`. A client tool call first emits its index, id, type, and function name, then argument fragments at that same index. Nonstandard activity appears only below `delta.x_codex`. The final choice has an empty delta and `finish_reason` of `stop` or `tool_calls`. If requested and reported, usage follows in a chunk with `choices: []`. A successful stream ends with `data: [DONE]`.

The extension shapes are:

```json
{"x_codex":{"reasoning":{"kind":"summary|text","item_id":"item","text":"fragment"}}}
{"x_codex":{"activity":{"kind":"command|file_change|mcp_tool|web_search|approval|tool_result","item_id":"item","status":"in_progress|completed|failed","text":"optional redacted fragment"}}}
```

## Errors and continuation invariants

Errors use `{"error":{"message":"...","type":"invalid_request_error|conflict_error|server_error","param":"field or null","code":"stable_code"}}`. `protocol/fixtures/continuation-cases.json` freezes the continuation statuses and codes. A rejection is read-only: it must not mutate the mapping, invoke `turn/start`, or invoke `thread/start`.

Response IDs are `chatcmpl_codex_` plus at least 128 bits of URL-safe cryptographic randomness. Version 1 mappings follow `schemas/response-mapping.schema.json`. The newest completed response ID is stored per thread; any older ID is superseded and branching is rejected. `thread/fork(lastTurnId)` remains unproven and is not a v1 feature.

Continuation requires exact model, canonical tool set, canonical cwd, and effective-policy fingerprints. Inconsistent repeated messages return `continuation_history_mismatch`. A pending tool call is process-local, defaults to a five-minute deadline, and is registered before the originating HTTP response ends. Timeout answers the app-server request with failure and marks the mapping expired. Disconnect and shutdown interrupt the turn, reject pending requests, and clear memory.

## Unproven live behavior

The offline gate does not claim the following as verified: browser launch fallback, the actual pending-request lifetime, web-search enforcement, `thread/fork` fidelity, executable npm ownership, or live restart resumption. Until opt-in spikes prove otherwise, per-request web search is rejected as `unsupported_web_search_mode`, branching is unsupported, and executable discovery uses an explicit path or `PATH`.

Each live spike must declare its expected observation, cleanup, output cap, and maximum calls. The entire stage permits four calls, all with `gpt-5.4-nano`: text, tool request, tool continuation, and post-restart continuation.
