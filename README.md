# codex-openai-proxy

Use any OpenAI Chat Completions client with Codex. The proxy runs `codex app-server` locally, authenticates with your ChatGPT login, and serves a loopback-only OpenAI-compatible endpoint.

> Prerelease. Text completions, streaming, function tools, usage metadata, thread continuation, and per-request Codex policy selection are implemented.

## Quick start

Requires Node.js 20+.

```sh
npx --yes codex-openai-proxy@next serve --root /absolute/path/to/project
```

- `--root` is the narrowest directory tree Codex may work in (defaults to the launch directory).
- Child-agent spawning is disabled by default. Pass `--subagents true` to opt in for the whole proxy process.
- The proxy listens at `http://127.0.0.1:8787` and starts the ChatGPT login flow on first use.
- Or install globally: `npm install --global codex-openai-proxy@next`, then `codex-openai-proxy serve --root ...`.
- Run `codex-openai-proxy --help` for all server, timeout, logging, and state options.

Check status:

| Endpoint         | Meaning                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `GET /health`    | 200 while the proxy process is alive                                                           |
| `GET /ready`     | 200 once Codex is initialized and authenticated; 503 while starting, logging in, or recovering |
| `GET /v1/models` | Lists models visible through the active authenticated app-server                               |

## Authentication

The proxy signs in with a ChatGPT account — no API key is exchanged. The spawned Codex runs in a proxy-owned home (`~/.codex-openai-proxy/codex-home` by default; override with `--codex-home`), isolated from any `~/.codex` install. On every startup, the proxy compares that home's `auth.json` with the existing `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) and adopts the source only when it is missing locally or the source is strictly newer. This newest-wins rule propagates a Codex CLI token refresh without replacing credentials the proxy refreshed more recently. If the available credentials are unusable, the proxy attempts one logout and runs the normal login flow instead of exiting:

Choose the login flow with `--login <auto|device-code|browser>`:

- `auto` (default) preserves the existing behavior: a stderr TTY uses interactive browser login; non-interactive stderr uses device-code login.
- `browser` forces interactive browser login. Complete the login while `serve` remains running; if the browser cannot be launched, use the authorization URL printed to stderr.
- `device-code` forces headless login and prints a verification URL plus one-time device code to stderr. This is appropriate for containers, services, CI, and remote terminals.

Notes:

- Completions return `app_server_not_ready` and `/ready` returns 503 until login finishes.
- The login deadline is fixed at 5 minutes.
- `--sync-auth never` leaves the proxy's Codex home untouched, including when the source has newer credentials. The only other mode is the default, `always`.
- The proxy writes a recovered login back to the main Codex home only after startup proved a pulled credential unusable and fresh recovery login succeeded. It uses a best-effort strictly-newer guard and atomic replacement for an existing older `auth.json`; `never` does not write back, and the proxy never creates the target.
- ChatGPT refresh tokens are single-use. Sharing one login between the Codex CLI and proxy means either side can invalidate the other's stored refresh token. For heavy simultaneous use, choose `--sync-auth never` and complete a proxy-only login.
- Treat authorization URLs and device codes as credentials. Plaintext proxy logs may contain them, so keep log captures local and never paste them into issues without reviewing the full contents.
- The proxy's login lives in its Codex home; deleting `~/.codex-openai-proxy/codex-home` signs the proxy out without touching the Codex CLI's own `~/.codex` session.

### Temporary Responses Lite override

For the pinned Codex `0.153.4` runtime, proxy startup installs a temporary [model catalog override](https://developers.openai.com/codex/config-reference/#configtoml) in the selected Codex home. It copies `models_cache.json` to `models.no-responses-lite.json`, sets `use_responses_lite` to `false` on every model entry, and removes `tool_mode` from entries that originally used Responses Lite while advertising native parallel-tool support. This makes declared client functions direct Responses tools instead of serialized nested code-mode callbacks. The proxy adds a marked top-level `model_catalog_json` block to `config.toml` and never edits the refreshable cache directly.

If a new Codex home creates its first model cache during initialization, that bootstrap app-server remains private; the proxy installs the override and restarts app-server once before reporting ready. The generated catalog intentionally freezes the cached model metadata while this workaround is active, changes the affected models from code-mode-only to direct tool routing, and replaces any prior top-level `model_catalog_json` value in the selected Codex home. The opt-in live contract requires one model turn to issue two independent client tool calls in the same batch, directly checking the behavior this compatibility patch is intended to restore. Remove the patch when the pinned runtime can expose and batch those calls without it.

## Use an OpenAI client

Point any OpenAI-compatible client at `http://127.0.0.1:8787/v1`. No API key is required; use any placeholder if your library demands one.

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "local",
});

const completion = await client.chat.completions.create({
  model: "gpt-5.6-luna",
  messages: [{ role: "user", content: "Summarize this project." }],
});

console.log(completion.choices[0].message.content);
```

Or with `curl`:

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.6-luna",
    "messages": [{"role": "user", "content": "Summarize this project."}]
  }'
```

List models without starting a Codex thread or turn:

```sh
curl http://127.0.0.1:8787/v1/models
```

## What's supported

| Supported                                                                                                | Not supported                                           |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `POST /v1/chat/completions` with text-only messages (`system`, `developer`, `user`, `assistant`, `tool`) | Multimodal message content (images, audio)              |
| `GET /v1/models` for visible models                                                                      | Responses API, embeddings, images, audio, model changes |
| Streaming (SSE, ends with `data: [DONE]`) and non-streaming                                              |                                                         |
| `reasoning_effort` (`none` … `max`, forwarded to Codex)                                                  | `tool_choice` other than `"auto"` / `"none"`            |
| Client-defined function tools, `tool_calls`, `finish_reason: "tool_calls"`                               | More than one choice per response                       |
| Default-on streaming usage chunks (`stream_options.include_usage: false` opts out)                       | Remote (non-loopback) serving                           |
| OpenAI-shaped JSON errors                                                                                |                                                         |

Model retrieval, deletion, and mutation endpoints are not supported.

Harmless unsupported fields are ignored with one structured warning. Malformed or ambiguous input is rejected rather than approximated.

`GET /v1/models` queries the active authenticated pinned app-server, aggregates every upstream `model/list` page, and returns only visible models. Each `id` is the Codex model slug accepted by the proxy. It starts zero Codex threads or turns. When the temporary Responses Lite override is installed, the response reflects its frozen catalog; otherwise it reflects app-server's ordinary catalog. `created: 0` and `owned_by: "openai"` are synthetic compatibility placeholders because app-server does not provide those fields.

From a repository checkout, `npm run models:live` remains a hidden/full-metadata diagnostic rather than a public route. Add `-- --include-hidden` for hidden entries or `-- --json` for complete catalog metadata; it also starts zero model turns.

## Streaming

Set `stream: true` as usual:

```sh
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.6-luna",
    "reasoning_effort": "high",
    "messages": [{"role": "user", "content": "Describe this repository."}],
    "stream": true
  }'
```

Standard clients get assistant text, function calls, the finish reason, and a usage chunk when Codex reports exact counters. The streaming usage chunk is on by default; set `stream_options.include_usage` to `false` to omit it. This default deliberately differs from OpenAI's opt-in behavior. Codex reasoning and internal activity arrive in the nonstandard fields described under [Codex-specific extensions](#codex-specific-extensions).

The proxy primes a stream before committing HTTP 200. A turn that fails before any output is therefore an ordinary JSON HTTP error carrying its real status — 429 for a quota failure, 503 `server_overloaded` when the selected model is at capacity, 502 otherwise — instead of a committed 200 whose stream ends with no content. If output is already visible, the response remains HTTP 200 and ends with exactly one typed SSE error event, without `data: [DONE]`.

## Function tools

Function tools follow the normal multi-request Chat Completions flow:

1. Send your function definitions in `tools`.
2. Receive an assistant response with `tool_calls`.
3. Execute the functions in your client.
4. Send the assistant tool-call message plus matching `role: "tool"` messages — repeating the same `tools`, `reasoning_effort`, and `x_codex` settings as the original request.

Changing those settings between the call and its results no longer rejects the request: the proxy executes the supplied transcript on a fresh Codex thread with the requested settings (`x_codex.threadReused: false`), and the pending call record stays intact for a later matching request. Results that are missing, foreign, or duplicate against the live pending batch are still rejected before any work starts. When your client replays a full transcript across multiple tool rounds, only its terminal contiguous `role: "tool"` block is correlated against the pending batch; earlier completed tool exchanges stay historical context. When you continue a pending tool batch with an explicit `previous_response_id`, the `role: "tool"` result block may be followed by one or more consecutive user messages: the results and every user message reach the same continued turn in order, with the final user message as the turn's input. Missing, partial, foreign, duplicate, or altered results — and a user message splitting a parallel result block — still fail with typed errors before any work starts. Resending such a transcript with a new trailing user message and no `previous_response_id` starts a fresh thread, and each earlier tool call is replayed into it paired with the result that answered it. A call no `role: "tool"` message answered and a result no immediately preceding assistant batch requested are dropped, reported once per request as `unpaired_history_tool_items_dropped`. Observational Codex activity is also omitted because it belongs to the original thread, but is recognized rather than reported as unpaired client history. The proxy ends the Codex turn the moment it captures the tool calls, so the `tool_calls` response returns promptly with exact usage; your later tool results are delivered into the persisted thread when you continue, but are never echoed back in response `tool_calls` or `tool_results`. Pending tool calls are durable — they survive a proxy restart and expire only with the normal continuation retention — but a post-restart continuation with active tools runs on a fresh thread.

## Codex-specific extensions

These are additive but nonstandard. Strict Chat Completions clients should ignore or strip them.

### Continue a Codex thread

Pass a completed response's `id` as top-level `previous_response_id` to prefer continuing its persisted Codex thread. `previous_response_id` is a nonstandard request extension; send your complete intended transcript with every request:

```json
{
  "model": "gpt-5.6-luna",
  "messages": [{ "role": "user", "content": "Now explain the test strategy." }],
  "previous_response_id": "chatcmpl_codex_..."
}
```

- Send the complete transcript you intend the model to see. Native continuation still uses only the new user message as turn input, but when the requested continuation is unavailable the proxy executes exactly the supplied transcript on a new Codex thread — it cannot recover earlier text you omitted.
- Native reuse requires the same model, `reasoning_effort`, tools, and `x_codex` settings as the original. A changed setting instead executes the supplied transcript on a fresh thread with the requested settings.
- Admission is synchronous and bounded: unknown, expired, superseded, or locally contended selectors and changed settings execute the supplied transcript on a new thread, reported by `x_codex.threadReused: false`. Failures app-server itself reports — a remotely active or non-resumable thread, or a resume or start failure — remain typed errors; the proxy never runs a second execution.
- A fallback transcript must be completely paired — every assistant tool call answered by its immediately following `role: "tool"` results, and no orphan results — or the request fails with a typed 400 before any work starts.
- A pending tool batch continued with an explicit `previous_response_id` may end its `role: "tool"` result block with one or more consecutive user messages: the suffix users are delivered after the injected result pairs, and the last one becomes the turn input on the same thread (`x_codex.threadReused: true`).
- Completed threads survive a proxy restart. A post-restart continuation with active client tools executes on a fresh thread because the resumed thread cannot expose new tool batches; tool-free restart continuation remains native.

### Receive Codex activity

Responses can include two nonstandard fields on the assistant delta/message:

| Field          | Contents                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `reasoning`    | Codex's reasoning summary (string)                                                                                 |
| `tool_results` | Status/results of Codex's internal activity (commands, file changes, MCP calls, web searches, collaboration calls) |

Successful responses also include response-level
`x_codex.instructionSources`, an array of the environment-native instruction-file
paths app-server reports as loaded for the Codex thread. Aggregate responses
include it once; streaming responses include it on the first chunk. An empty
array means app-server reported no loaded instruction files. Treat these paths
as sensitive plaintext. The same response-level object includes
`x_codex.threadReused`: `true` means the request successfully resumed an
existing Codex thread, while `false` means it started a new thread. For streams,
this field likewise appears only on the first chunk.

Reasoning deltas stream as they arrive. If app-server supplies reasoning only in
the completed item, the proxy emits that final text without repeating any
prefix already streamed for the same item.

Internal activity also appears as function-shaped entries in `tool_calls`. These are **observational** — Codex already executed them. Do not execute them, and do not send tool results for them; they never cause `finish_reason: "tool_calls"`. Only your own client-defined functions suspend the turn and require `role: "tool"` follow-ups.

For collaboration calls, `tool_results[].result.content` can include sanitized `receiverThreadIds` and `agentsStates` entries containing only child status and message fields. Sender thread IDs and provider-native payloads are not exposed.

For `webSearch`, app-server may emit an incomplete start item. The proxy withholds that placeholder and uses the completed item's `query` and `action` as the observational call input. Search results, when app-server supplies them, are exposed as `tool_results[].result.content`; the action metadata is not misclassified as output.

If your client replays a prior assistant message verbatim in a fresh request, the proxy strips these observational fields automatically. Assistant messages may also carry `reasoning_content`, the field OpenAI-compatible clients such as the Vercel AI SDK write instead of `reasoning`; it is accepted and stripped the same way. Either field is response-only — sending it on a non-assistant message, or as anything other than a string, is rejected.

### Select Codex policy

Per-request Codex controls live under a nonstandard top-level `x_codex` object:

```json
{
  "model": "gpt-5.6-luna",
  "messages": [{ "role": "user", "content": "Review this project." }],
  "x_codex": {
    "cwd": "/absolute/path/to/project",
    "sandbox": "workspace-write",
    "web_search": "disabled"
  }
}
```

| Field        | Values                                                           | Default                 | Notes                                                                             |
| ------------ | ---------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| `cwd`        | absolute path                                                    | the configured `--root` | Must be the root or a descendant; symlink escapes and relative paths are rejected |
| `sandbox`    | `disabled`, `read-only`, `workspace-write`, `danger-full-access` | `disabled`              | `disabled` removes the built-in shell and local file access; client tools remain  |
| `web_search` | `disabled`, `cached`, `indexed`, `live`                          | `disabled`              | Applied per Codex thread                                                          |

The `disabled` sandbox provides no built-in shell or local filesystem reads or writes through an execution environment. The proxy realizes it as Codex's native `read-only` sandbox plus `environments: []`, so managed policy requirements must allow `read-only` for a request to use `disabled`. Client-provided tools and hosted web search, when explicitly enabled, remain separate capabilities.

On native Windows, the proxy defaults an unconfigured sandbox backend to `windows.sandbox = "unelevated"`, which does not require administrator setup. Explicit Windows sandbox settings and managed requirements take precedence. This backend selection is separate from `x_codex.sandbox`: requests must still opt into `read-only` or `workspace-write` for built-in filesystem access. The unelevated backend uses a restricted token and provides weaker isolation than the elevated backend; operators who have configured elevated sandboxing retain it. The isolated live-test Codex home uses the same default.

Multi-agent availability is app-server process configuration, not a Chat Completions request policy. The proxy starts app-server with subagents disabled unless the operator passes `--subagents true`; the startup log records the effective value as `subagents_enabled`. The proxy exposes no per-request `x_codex` multi-agent field, so enabling `read-only`, `workspace-write`, or web search does not itself enable child spawning.

The JSON Schema ships with the package at `protocol/schemas/x-codex.schema.json`.

> **Project trust:** starting a new thread with `workspace-write` and a `cwd` can cause Codex to mark that project as trusted in your `config.toml`. Keep `--root` as narrow as possible.

## Usage metadata

When Codex reports exact usage for the turn, responses include standard `prompt_tokens`, `completion_tokens`, and `total_tokens`, plus cached-input and reasoning-token detail when available. When no complete record exists, `usage` is omitted — never estimated.

One response can span several Codex model requests, for example when internal tools run before the answer. Usage covers every request the response reported, not only the last one, so reasoning tokens still account for reasoning summaries streamed earlier in the same response. The continuation mapping retains the exact cumulative total at each response boundary. A response that ends in `finish_reason: "tool_calls"` ends its Codex turn immediately, which flushes that turn's exact usage, so it reports the work up to the call and the continuation counts from there. Those tokens are never dropped, never estimated, and never counted twice — this includes reasoning tokens on a tool call that is the final desired result and is never continued.

## Quota errors

Only app-server `codexErrorInfo: "usageLimitExceeded"` becomes HTTP 429 with `error.type: "rate_limit_error"`, normally `error.code: "usage_limit_exceeded"`. This is error enrichment, not a public quota endpoint or proactive admission check, and it is distinct from response-token usage.

For each such failed request, the proxy makes at most one memoized, abortable `account/rateLimits/read`. When it finds a trustworthy future reset, nonstandard `error.x_codex.reset_at` is Unix seconds; an uncommitted response also has the matching integer-seconds `Retry-After` header. A failed or malformed lookup omits both reset values but preserves the typed 429. Client cancellation remains cancellation.

Explicit workspace credit exhaustion always uses `insufficient_credits` with no reset. An explicit workspace usage cap uses `workspace_usage_limit_exceeded` only without a trustworthy individual spend-control reset; when `spendControlReached` and a valid future `individualLimit` reset exist, it remains `usage_limit_exceeded` with reset metadata. Vox Agents treats both workspace codes as non-retryable. The reset is the latest future exhausted primary or secondary window from `rateLimitsByLimitId.codex`, falling back to `rateLimits`; `individualLimit` participates only when `spendControlReached`. The proxy uses stale-percent data only for `rate_limit_reached` and never infers a workspace reset from rolling windows. It never sleeps, queues, consumes reset credit, retries, or replays a request.

## Capacity errors

App-server `codexErrorInfo: "serverOverloaded"` — the failure behind Codex's "Selected model is at capacity. Please try a different model." — becomes HTTP 503 with `error.type: "server_error"` and `error.code: "server_overloaded"`, carrying the Codex message unchanged. It is an upstream condition rather than your account's quota, so it triggers no rate-limit lookup and never carries `Retry-After` or `reset_at`. Every other unclassified turn failure remains 502 `app_server_error`. The proxy does not retry a capacity failure for you; treat 503 as retryable, ideally with another model.

## Safety and limits

- The listener accepts loopback only (`127.0.0.1`, `::1`, `localhost`); non-loopback `Host` authorities and any request with an `Origin` header are rejected.
- There is no local bearer-token check, so any process running as your user can call the proxy. See the [security model](https://github.com/CIVITAS-John/codex-app-server-to-proxy/blob/main/docs/security.md).
- Structured JSON logs go to stderr in plaintext and are not redacted. Any level may contain filesystem paths, login URLs, tokens, prompts, child stderr, or tool details; treat every log capture as sensitive.
- Successful `/health` and `/ready` probes — including the 503 returned before startup finishes — are logged at debug so a polling health checker stays out of default-level output. Rejected or failed requests to those paths are still logged at info.

Default limits (all configurable via CLI flags):

| Limit                            | Default                                     |
| -------------------------------- | ------------------------------------------- |
| JSON body size                   | 1 MiB                                       |
| Concurrent HTTP requests         | 100 (excess rejected with 429 `overloaded`) |
| Request deadline                 | 30 s                                        |
| Login / startup deadline (fixed) | 5 min                                       |

A request contending with a locally active Codex thread executes on a fresh thread; 409 `thread_busy` remains for a thread app-server itself reports active. If app-server crashes, the proxy retries with bounded backoff while `/ready` returns 503.
The request deadline aborts downstream work and closes any response that is still open, including a stream blocked by a client that stopped reading; its concurrency slot is then released.

## Troubleshooting

| Symptom                           | What to do                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/ready` returns 503              | Login or startup hasn't finished — follow [Authentication](#authentication) and check the stderr logs for `app_server_ready` or `startup_failed` |
| Browser login never appears       | `--login auto` selects device-code when stderr is not a TTY. Run in a foreground terminal, or restart with `--login browser` to force the flow.  |
| Need to sign in without a browser | Start with `--login device-code` and keep stderr visible to copy the verification URL and one-time code.                                         |
| Address already in use            | Choose another loopback `--port`                                                                                                                 |
| `--codex-path` override rejected  | The override must report exactly `codex-cli 0.153.4` (the version bundled with this package); remove the flag to use the bundled executable      |
| Policy request denied             | Managed requirements disallow the value; the proxy never silently weakens policy                                                                 |

For deeper diagnosis, temporarily add `--log-level debug`. All log levels are sensitive; debug adds more diagnostic detail.

## Uninstall and cleanup

```sh
npm uninstall --global codex-openai-proxy
# Or, from a project that installed it locally:
npm uninstall codex-openai-proxy
```

- Continuation state lives under `~/.codex-openai-proxy` (one namespace per `--root`), or your custom `--state-dir`. The proxy's Codex home — including its ChatGPT login and Codex caches — lives at `~/.codex-openai-proxy/codex-home`, or your custom `--codex-home`. Uninstalling deletes neither.
- The temporary `models.no-responses-lite.json` catalog and its marked `config.toml` block also remain in the selected Codex home after uninstall. Remove both together only while every proxy using that home is stopped.
- Stop every proxy using a root before deleting its namespace. Deleting state invalidates its `previous_response_id` values but does not touch Codex's threads; deleting `codex-home` also signs the proxy out (the next startup re-seeds from `~/.codex` when a login exists there unless `--sync-auth never` is set). A recovered login can update an existing older Codex CLI `auth.json` under the guarded conditions in [Authentication](#authentication).

## Documentation

- [Development guide](https://github.com/CIVITAS-John/codex-app-server-to-proxy/blob/main/docs/development.md) — source layout, commands, tests, and verification modes
- [Upstream Codex updates](https://github.com/CIVITAS-John/codex-app-server-to-proxy/blob/main/docs/development.md#updating-upstream-codex) — automated update checks and agent-guided compatibility repairs
- [Security model](https://github.com/CIVITAS-John/codex-app-server-to-proxy/blob/main/docs/security.md) — threat model and audit boundary
- [Implementation plan](https://github.com/CIVITAS-John/codex-app-server-to-proxy/blob/main/plans/README.md) — decisions and remaining work
- [App-server protocol reference](https://github.com/CIVITAS-John/codex-app-server-to-proxy/blob/main/docs/codex-app-server.md)
