# Stage 01 compatibility contract

This contract targets `codex-cli 0.144.5`, pinned by the exact `@openai/codex` runtime dependency. The checked-in TypeScript and JSON Schema artifacts were generated from that package-owned executable with `--experimental`; they are the wire-type source of truth. Regenerate them with `npm run generate:protocol` after changing the package pin.

## Request fields

| Field | Classification | Mapping |
| --- | --- | --- |
| `model` | Standard, required | `thread/start.model`; must match on continuation. |
| `reasoning_effort` | Standard | Validates `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` and maps the selected value to `turn/start.effort`; `turn/start.summary` defaults to `"detailed"` so exposed reasoning summaries are emitted, while explicit `none` requests `summary: "none"`; must match on continuation. Individual models may support only a subset. |
| `messages` | Standard, required | Text-only role history is validated. A new thread must end in a user message. A continuation may end in a tool message only when it resolves that response's pending dynamic calls; a ready continuation ending in a tool message is rejected with HTTP 409 `tool_results_without_pending_call` rather than flattened into user text. |
| `tools` | Standard | Function tools become experimental `dynamicTools`. Their locale-independent, UTF-16-code-unit-key-sorted canonical JSON SHA-256 must match on continuation because the pinned protocol cannot replace tools on `thread/resume` or `turn/start`. |
| `tool_choice` | Standard, restricted | Omitted and `auto` expose the declared dynamic tools. `none` is accepted by omitting dynamic tools. `required` and named choices are rejected because this app-server has no faithful per-turn equivalent. |
| `stream` | Standard | `true` streams SSE. `false` buffers the same event pipeline and emits one response. |
| `stream_options.include_usage` | Standard | When true, an otherwise empty final choices array carries attributable usage before `[DONE]`. |
| `previous_response_id` | Nonstandard continuation field | Resolves a durable local mapping and always preflights `thread/resume`; never falls back to `thread/start`. Tool results may omit it by default when their `tool_call_id` values uniquely identify one live suspension; server configuration can require it. |
| `x_codex` | Nonstandard extension | Optional `cwd`, `sandbox`, and `web_search` controls. `cwd` is canonicalized inside the configured root; sandbox accepts `read-only`, `workspace-write`, or explicit `danger-full-access`; web search accepts `disabled`, `cached`, `indexed`, or `live`. Defaults are root, `read-only`, and `disabled`. |
| `temperature`, `top_p`, `n`, `stop`, `max_tokens`, `max_completion_tokens`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `logprobs`, `top_logprobs`, `seed`, `response_format`, `modalities`, `audio`, `prediction`, `service_tier`, `store`, `metadata`, `user`, `parallel_tool_calls` | Ignored with warning | These harmless unsupported top-level fields are not forwarded. Emit one structured `unsupported_chat_fields_ignored` warning per request containing the sorted field names. |
| Any other unknown top-level field | Ignored with warning | Apply the same single `unsupported_chat_fields_ignored` warning. Unknown fields within `messages`, `tools`, `stream_options`, or `x_codex` remain malformed or unsupported. |

## Protocol mapping

| App-server method/event | Proxy behavior |
| --- | --- |
| `initialize`, `initialized`, `configRequirements/read` | Initialization precedes traffic. Experimental capabilities are enabled by the generated contract. Managed policy allowlists are loaded when available; method-not-found means unrestricted proxy defaults, while malformed requirements fail startup. |
| `thread/start` | Creates a new thread only after validation succeeds. Supplies `model`, `ephemeral: false`, and `dynamicTools` when enabled, plus canonical cwd, sandbox, approval settings, and per-thread `config.web_search`. |
| `thread/resume` | Preflight for every mapped continuation and explicitly reapplies canonical cwd, sandbox, approval settings, and `config.web_search`. Restored token usage is ignored for new-response attribution. |
| `turn/start` | Starts one turn on a non-busy thread and explicitly applies requested reasoning effort plus cwd, approval settings, and the full sandbox policy so sticky prior-turn state is never inherited accidentally. |
| `item/agentMessage/delta` | Standard `choices[0].delta.content`. |
| `item/tool/call` request | Centrally routed by thread to exactly one active owner and exposed with the standard function-shaped `tool_calls` field; request remains pending until continuation, timeout, disconnect, turn resolution, or shutdown. |
| reasoning delta events | Nonstandard direct compatibility field `choices[0].delta.reasoning`; never standard `content` and never a response-side `x_codex` field. |
| command, file-change, MCP, plan, web-search, collaboration, and other supported internal activity | Function-shaped `tool_calls` plus the nonstandard direct compatibility field `tool_results`. These calls are observational, are not client-executable dynamic calls, and do not cause `finish_reason: "tool_calls"`. |
| `thread/tokenUsage/updated` | Attribute only `last` usage observed after `turn/started`. Omit unavailable values and never subtract or estimate. Replayed resume usage is ignored. |
| `turn/completed` | Finalize mapping. Standard finish reason is `stop`, or `tool_calls` when client dynamic calls remain pending. Internal activity does not change the finish reason. |
| `error` or JSON-RPC error | OpenAI-shaped error; an SSE stream emits one error event and then closes without `[DONE]`. Overload `-32001` maps to retryable HTTP 503 before headers. A response containing a malformed JSON-RPC `error` object fails closed. |
| approval requests | Use `auto_review` when effective policy allows; immediately answer unexpected requests with decline. Approval state is diagnostic only. |
| `serverRequest/resolved` | Remove/cancel matching pending dynamic call. Duplicate client results are rejected. |
| account read/login events | `account/read` detects auth. `account/login/start` with ChatGPT opens the returned URL when possible; one interactive-terminal fallback may print it, but logs/state never retain it. |

Unknown and explicitly diagnostic-only app-server events are retained only as bounded, redacted debug diagnostics and are not exposed over HTTP. This includes the pinned unstable `item/autoApprovalReview/*` notifications and `item/commandExecution/terminalInteraction`, whose payloads do not satisfy the public item-progress contract. Each diagnosed method is recorded once per app-server transport, and diagnostics are capped at a fixed number of distinct methods for that transport's lifetime.
`protocol/fixtures/exposed-events.json` is the authoritative manifest of notification and server-request types intentionally handled by the HTTP translation; diagnostic-only events are excluded. Each entry must have exactly one synthetic JSONL fixture. `protocol/fixtures/exposed-events.ts` is the generated-protocol-typed source for that JSONL corpus, including complete nested `Turn` values and server-request parameters. A contract test requires every runtime-handled notification to appear in this corpus.

## SSE mapping

The first chunk has `delta.role: "assistant"`. Text uses `delta.content`. Exposed reasoning uses the nonstandard direct `delta.reasoning` field. Calls use function-shaped `delta.tool_calls`; internal progress and terminal output use the nonstandard direct `delta.tool_results` field and repeat the matching call so each result is self-correlating. The final choice has an empty delta and `finish_reason` of `stop` or `tool_calls`. If requested and reported, usage follows in a chunk with `choices: []`. A successful stream ends with `data: [DONE]`. An error stream emits one OpenAI-shaped SSE error event and closes without `[DONE]`.

The nonstandard direct compatibility result shape is:

```json
{"tool_results":[{"id":"item","type":"function","function":{"name":"tool_name","arguments":"{}"},"result":{"status":"started|in_progress|completed|failed","content":"optional bounded value","error":{"message":"optional bounded error","code":"optional code"}}}]}
```

## Errors and continuation invariants

Errors use `{"error":{"message":"...","type":"invalid_request_error|conflict_error|server_error","param":"field or null","code":"stable_code"}}`. Maintained HTTP continuation tests pin continuation statuses, codes, and the absence of thread or turn work. A rejection does not invoke `turn/start` or `thread/start`; lookup may persist a lazy transition to expired.

Response IDs are `chatcmpl_codex_` plus at least 128 bits of URL-safe cryptographic randomness. The unreleased schema-version-0 store follows `schemas/response-mapping.schema.json`: it contains a wrapper version and flattened response records with thread bindings, lifecycle state, creation/expiry times, and optional dynamic-tool call IDs. The newest completed response ID is stored per thread; any older ID is superseded and branching is rejected. `thread/fork(lastTurnId)` remains unproven and is not a v1 feature.

Continuation requires exact model, reasoning effort, canonical tool set, canonical cwd, and effective-policy fingerprints. Effective policy includes sandbox, web-search mode, approval policy, and approval reviewer. The proxy reapplies matching settings on resume and turn start rather than relying on sticky thread state. A reasoning-effort change returns `continuation_reasoning_effort_mismatch`. Schema-version-0 records written before reasoning effort became binding data omit both `reasoningEffort` and `reasoningEffortBound`; they accept one ambiguous continuation, while every new record carries `reasoningEffortBound: true` and restores exact matching. This includes completed-thread continuation: changing the tool set cannot be represented by the pinned app-server protocol, so the proxy returns `continuation_tools_mismatch` instead of starting a replacement thread. A pending tool call is process-local, defaults to a five-minute deadline, and is registered before the originating HTTP response ends. Each request that selects the live suspension by response ID or matching tool-call IDs restarts that deadline before binding and transcript validation. Timeout answers the app-server request with failure and marks the mapping expired. One store instance remains authoritative for the server lifetime. Transport replacement and shutdown dispose the old coordinator generation, cancel its timers, reject suspended responders, expire pending mappings, reject callbacks until close, and close the old transport; buffered post-close frames are ignored and stale executions cannot record completed responses.

A tool-ending continuation is valid only against a pending-tool mapping. A ready mapping has no pending call to receive that result and returns HTTP 409 `tool_results_without_pending_call` without resuming or starting a turn.

## Live compatibility boundary

The opt-in Stage 07 live contract verifies high reasoning effort with exposed reasoning and role-history SSE, one client-defined dynamic-tool round trip, restart continuation, one explicit read-only/disabled-web policy tuple, bounded built-in tool observation, and continuation after that information. It does not claim that one live tuple validates every reasoning-effort, sandbox, or web-search value. Exact request mapping and denials remain deterministic offline coverage. Browser launch fallback, the actual pending-request lifetime, and `thread/fork` fidelity remain unproven; branching remains unsupported.
