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

For the pinned Codex `0.155.1` runtime, proxy startup installs a temporary [model catalog override](https://developers.openai.com/codex/config-reference/#configtoml) in the selected Codex home. It copies `models_cache.json` to `models.no-responses-lite.json`, sets `use_responses_lite` to `false` on every model entry, and removes `tool_mode` from entries that originally used Responses Lite. Codex 0.155.1 no longer exposes the former `supports_parallel_tool_calls` catalog field, so conversion does not depend on it. This makes declared client functions direct Responses tools instead of serialized nested code-mode callbacks. The proxy adds a marked top-level `model_catalog_json` block to `config.toml`; the Responses Lite transformation never modifies the source cache.

On each new proxy process, a private app-server with a fresh temporary Codex home requests the current model catalog without starting a model turn. It uses the selected home's ordinary Codex settings but omits the static catalog override for this fetch. The proxy accepts its cache only when the pinned Codex version and a nonempty model list are present, atomically replaces the selected home's cache, rebuilds the override, and restarts app-server before reporting ready. If refresh fails, startup keeps the previous cache and logs a warning; a home without any usable override cannot become ready. The generated catalog remains fixed for that proxy process, changes affected models from code-mode-only to direct tool routing, and replaces any prior top-level `model_catalog_json` value in the selected Codex home. The opt-in live contract supplies explicit system instructions and requires one model turn to issue two independent client tool calls in the same batch. Parallel calls are permitted by the override; the model still chooses which calls to emit. Remove the patch when the pinned runtime can expose and batch those calls without it.

## Instruction configuration

For each fresh Chat Completions request, the proxy sets Codex's `baseInstructions` to the client `system` messages, joined in transcript order with a blank line between them. With no system messages, it sends an empty string. This replaces Codex's default base prompt and any configured `model_instructions_file` for that thread. Codex's runtime instructions, tool definitions, project instructions, and managed policy still apply.

Personal Codex configuration does not propagate through authentication sync: the proxy copies only `auth.json` and sets the child's `CODEX_HOME` to its separate proxy home. Keep `--codex-home` separate from your personal Codex home to preserve this isolation. Configuration placed in the proxy home, trusted project `.codex/config.toml` settings, and instruction files loaded from the request's working directory can still affect proxy requests. This is home isolation, not isolation from project instructions or managed policy.

System messages are excluded from `thread/inject_items` because they are supplied through `baseInstructions`; the pinned runtime filters literal system history out of model requests. Client `developer` messages remain developer history, and other history keeps its content and order. Codex represents its base instructions as developer instructions upstream, so the proxy does not guarantee separate system-over-developer priority. System messages anywhere in a fresh transcript contribute to the thread-wide base instructions.

Native thread reuse retains the original base instructions and history rather than reapplying earlier transcript messages. This also applies after a restart and when a continuation contains only new user input. Changing a system message in a continuation transcript does not update that thread's instructions. Threads created by older proxy versions retain their earlier instruction behavior. To change instructions or adopt the corrected mapping, send the intended transcript as a fresh request without `previous_response_id` or an implicitly continued pending tool-result batch.

The dedicated [system-prompt live test](test/contract/system-prompt.live.test.ts) checks that a system-only nonce wins over conflicting user input in both aggregate and SSE output, using `gpt-6-luna` with at most two upstream model responses:

```sh
npm run test:live -- test/contract/system-prompt.live.test.ts
```

The live budget guard lets a root final answer without tool work finish naturally at the limit, preserving `finish_reason: "stop"`. It interrupts responses that can require more work and rejects further root turns before dispatch.

## Use an OpenAI client

Point any OpenAI-compatible client at `http://127.0.0.1:8787/v1`. No API key is required; use any placeholder if your library demands one.

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "local",
});

const completion = await client.chat.completions.create({
  model: "gpt-6-luna",
  messages: [{ role: "user", content: "Summarize this project." }],
});

console.log(completion.choices[0].message.content);
```

Or with `curl`:

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-6-luna",
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
    "model": "gpt-6-luna",
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
4. Send the assistant tool-call message plus matching `role: "tool"` messages — repeating the same `tools`, `reasoning_effort`, and policy controls as the original request.

When a continuation is compatible, the proxy resumes the stored thread and injects the matching tool results. If call IDs, names, arguments, or results do not match the pending batch, or results are sent to a ready mapping, the proxy starts a fresh thread and reconstructs context from the submitted transcript. Equivalent JSON arguments can still be incompatible when their exact strings differ. Duplicate assistant call IDs or duplicate result IDs within the selected batch remain invalid. The source checkpoint stays available for a later matching request. With no submitted results, an explicit selector starts a fresh thread and leaves the pending batch intact. An explicit pending continuation can include consecutive user messages after its tool-result block; those messages are included in order and the final user message becomes the new turn input. A user message within a parallel result block makes that batch incompatible, so execution falls back to a fresh thread. Fresh execution uses the final user message as turn input, or empty input when there is none; system messages become base instructions. Complete historical tool call/result pairs are injected, while unanswered calls and orphan results are dropped with one `unpaired_history_tool_items_dropped` warning per request. Thus omitted earlier conversation history cannot be recovered on fallback. The response shape is unchanged and reports `x_codex.threadReused: false` for fresh execution. The proxy ends the Codex turn when it captures tool calls, then waits through the usage collection window before returning `tool_calls`; results are not echoed back in response `tool_calls` or `tool_results`. Pending tool calls survive a proxy restart and expire with the normal continuation retention; a post-restart continuation with active tools runs on a fresh thread.

When app-server dispatches tool callbacks after their raw response has completed, the proxy retains that completion and waits for one second without another callback before capturing the batch. This avoids a request timeout caused by waiting for an already-consumed completion. The HTTP request deadline still applies; a missing raw completion is never replaced by a timer.

## Codex-specific extensions

These are additive but nonstandard. Strict Chat Completions clients should ignore or strip them.

### Continue a Codex thread

Pass a completed response's `id` as top-level `previous_response_id` to prefer continuing its persisted Codex thread. `previous_response_id` is a nonstandard request extension; send your complete intended transcript with every request:

```json
{
  "model": "gpt-6-luna",
  "messages": [{ "role": "user", "content": "Now explain the test strategy." }],
  "previous_response_id": "chatcmpl_codex_..."
}
```

- Send the complete transcript you intend the model to see. Native continuation uses only new user input on the existing thread. Fresh fallback reconstructs context only from the submitted transcript, so earlier conversation omitted from it is lost.
- Native reuse requires the same model, `reasoning_effort`, working directory, declared tools, and effective policy, plus compatible pending results. Changed thread-binding values or incompatible results execute on a fresh thread with the requested settings. The same applies when a ready mapping receives tool results.
- Before reuse, the proxy reads and resumes the mapped thread. Busy or non-resumable status, a different returned thread ID, or an app-server RPC error response selects fresh execution. Malformed response envelopes, cancellation, transport failure, local policy/configuration errors, persistence failures, and failures after result injection or turn start remain errors; the proxy does not retry those operations with a replacement execution.
- Fallback uses ordinary fresh-request mapping: system messages become base instructions, complete historical tool pairs are injected, and unanswered calls or orphan results are dropped with one `unpaired_history_tool_items_dropped` warning. The final user message is turn input; if absent, input is empty. The response shape is unchanged and fresh execution reports `x_codex.threadReused: false`.
- A compatible pending tool batch continued with an explicit `previous_response_id` may end its `role: "tool"` result block with one or more consecutive user messages: the suffix users are delivered after the injected result pairs, and the last one becomes the turn input. If reuse is incompatible, the same transcript is mapped onto a fresh thread.
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
Child lifecycle notifications appear as `subAgentActivity` in the same nonstandard activity fields, with `kind` and `agentThreadId` in function arguments and result content. Agent paths are omitted; app-server may report a child start this way instead of a `spawnAgent` call.

For `webSearch`, app-server may emit an incomplete start item. The proxy withholds that placeholder and uses the completed item's `query` and `action` as the observational call input. Search results, when app-server supplies them, are exposed as `tool_results[].result.content`; the action metadata is not misclassified as output.

If your client replays a prior assistant message verbatim in a fresh request, the proxy strips these observational fields automatically. Assistant messages may also carry `reasoning_content`, the field OpenAI-compatible clients such as the Vercel AI SDK write instead of `reasoning`; it is accepted and stripped the same way. Either field is response-only — sending it on a non-assistant message, or as anything other than a string, is rejected.

### Select Codex policy

Per-request Codex controls live under a nonstandard top-level `x_codex` object:

```json
{
  "model": "gpt-6-luna",
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

The opt-in `gpt-6-luna` live child-agent contract explicitly instructs one spawn, then verifies the child completion and nonce handoff. It runs in a separate app-server process with subagents enabled and shares the core contract's 32-response ceiling.

The JSON Schema ships with the package at `protocol/schemas/x-codex.schema.json`.

> **Project trust:** starting a new thread with `workspace-write` and a `cwd` can cause Codex to mark that project as trusted in your `config.toml`. Keep `--root` as narrow as possible.

## Usage metadata

When Codex reports exact usage for the turn, responses include standard `prompt_tokens`, `completion_tokens`, and `total_tokens`, plus cached-input and reasoning-token detail when available. When no complete record exists, `usage` is omitted — never estimated.

Exact raw completion counters provide a fallback when thread usage updates are missing, including after a tool-turn interrupt. The proxy sums distinct upstream response IDs; later attributable thread usage replaces that sum. The two sources are never added together. Missing reasoning remains absent; a reported zero remains zero.

After app-server reports the thread idle, the proxy collects usage updates for five full seconds, even if earlier counts exist. This delays aggregate responses and streaming terminal frames so late reasoning counts can replace earlier usage. Request aborts, transport failure, and a ten-second terminal collection limit can end the wait sooner; updates after the response ends cannot amend it.

Streaming emits usage once, in a `choices: []` chunk **before** the `finish_reason` chunk, followed by `[DONE]`. This deliberately changes the previous finish-then-usage ordering so clients that stop at `finish_reason` already have the counts. Read usage by its field rather than assuming it is the last chunk. `stream_options.include_usage: false` still omits it.

One response can span several Codex model requests, for example when internal tools run before the answer. Usage subtracts the stored cumulative boundary from the latest complete total, preserving reasoning from earlier requests. A response ending in `finish_reason: "tool_calls"` interrupts its Codex turn, collects late updates, and stores the reported boundary for the continuation. Complete raw fallback counts advance the starting boundary by the reported amounts to prevent double counting. If no usage arrives, the response omits it and retains its starting boundary so a later continuation can account for the unreported work.

`usage_unreported` warnings distinguish `missing: "all"` from `missing: "reasoning"` and identify the selected `usage_source`. At `--log-level debug`, usage notification, tool-interrupt, idle, and collection-completion events include elapsed times and structural metadata for diagnosing ordering. These diagnostics omit provider payloads and token values.

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

A request contending with a Codex thread that is active locally or that app-server reports active executes on a fresh thread. If app-server crashes, the proxy retries with bounded backoff while `/ready` returns 503.
The request deadline aborts downstream work and closes any response that is still open, including a stream blocked by a client that stopped reading; its concurrency slot is then released.

## Troubleshooting

| Symptom                           | What to do                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/ready` returns 503              | Login or startup hasn't finished — follow [Authentication](#authentication) and check the stderr logs for `app_server_ready` or `startup_failed` |
| Browser login never appears       | `--login auto` selects device-code when stderr is not a TTY. Run in a foreground terminal, or restart with `--login browser` to force the flow.  |
| Need to sign in without a browser | Start with `--login device-code` and keep stderr visible to copy the verification URL and one-time code.                                         |
| Address already in use            | Choose another loopback `--port`                                                                                                                 |
| `--codex-path` override rejected  | The override must report exactly `codex-cli 0.155.1` (the version bundled with this package); remove the flag to use the bundled executable      |
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

- [Documentation index](docs/README.md) — architecture, continuation, compatibility, development, security, and protocol topics
- [Release checklist](RELEASE.md) — candidate gates and publication procedure
