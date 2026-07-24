# codex-openai-proxy

Use any OpenAI Chat Completions client with Codex. The proxy runs `codex app-server` locally, authenticates with your ChatGPT login, and serves a loopback-only OpenAI-compatible endpoint.

> Prerelease. Text completions, streaming, function tools, usage metadata, thread continuation, and per-request Codex policy selection are implemented.

## Quick start

Requires Node.js 20+.

```sh
npx --yes codex-openai-proxy@next serve --root /absolute/path/to/project
```

- `--root` is the narrowest directory tree Codex may work in (defaults to the launch directory).
- The proxy listens at `http://127.0.0.1:8787` and starts the ChatGPT login flow on first use.
- Or install globally: `npm install --global codex-openai-proxy@next`, then `codex-openai-proxy serve --root ...`.
- Run `codex-openai-proxy --help` for all server, timeout, logging, and state options.

Check status:

| Endpoint      | Meaning                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `GET /health` | 200 while the proxy process is alive                                                           |
| `GET /ready`  | 200 once Codex is initialized and authenticated; 503 while starting, logging in, or recovering |

## Authentication

The proxy signs in with a ChatGPT account — no API key is exchanged. The spawned Codex runs in a proxy-owned home (`~/.codex-openai-proxy/codex-home` by default; override with `--codex-home`), isolated from any `~/.codex` install. If that home has no login yet, startup copies the existing `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) into it, so a machine where the Codex CLI is already signed in needs no interaction; the copy is never overwritten afterwards. Only without any existing login does the proxy start one:

- **Interactive terminal** — the proxy opens the browser authorization page. Complete the login and leave `serve` running. If the browser can't be launched, the URL is printed to the terminal.
- **Non-interactive (containers, services, CI)** — the proxy prints a verification URL and one-time device code to stderr. Keep stderr visible until login completes.

Notes:

- Completions return `app_server_not_ready` and `/ready` returns 503 until login finishes.
- The default login deadline is 5 minutes; raise it with e.g. `--tool-timeout 10m`.
- Treat printed authorization URLs and device codes as credentials — don't paste them into issues or logs.
- The proxy's login lives in its Codex home; deleting `~/.codex-openai-proxy/codex-home` signs the proxy out without touching the Codex CLI's own `~/.codex` session.

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

## What's supported

| Supported                                                                                                | Not supported                                              |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `POST /v1/chat/completions` with text-only messages (`system`, `developer`, `user`, `assistant`, `tool`) | Multimodal message content (images, audio)                 |
| Streaming (SSE, ends with `data: [DONE]`) and non-streaming                                              | Responses API, embeddings, images, audio, model management |
| `reasoning_effort` (`none` … `max`, forwarded to Codex)                                                  | `tool_choice` other than `"auto"` / `"none"`               |
| Client-defined function tools, `tool_calls`, `finish_reason: "tool_calls"`                               | More than one choice per response                          |
| `stream_options.include_usage`                                                                           | Remote (non-loopback) serving                              |
| OpenAI-shaped JSON errors                                                                                |                                                            |

Harmless unsupported fields are ignored with one structured warning. Malformed or ambiguous input is rejected rather than approximated.

The proxy does not expose `GET /v1/models`. From a repository checkout, run `npm run models:live` to read the authenticated live Codex catalog with zero model calls. Add `-- --include-hidden` for hidden entries or `-- --json` for complete catalog metadata.

## Streaming

Set `stream: true` as usual:

```sh
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.6-luna",
    "reasoning_effort": "high",
    "messages": [{"role": "user", "content": "Describe this repository."}],
    "stream": true,
    "stream_options": {"include_usage": true}
  }'
```

Standard clients get assistant text, function calls, the finish reason, and the optional usage chunk. Codex reasoning and internal activity arrive in the nonstandard fields described under [Codex-specific extensions](#codex-specific-extensions).

## Function tools

Function tools follow the normal multi-request Chat Completions flow:

1. Send your function definitions in `tools`.
2. Receive an assistant response with `tool_calls`.
3. Execute the functions in your client.
4. Send the assistant tool-call message plus matching `role: "tool"` messages — repeating the same `tools`, `reasoning_effort`, and `x_codex` settings as the original request.

Changing those settings between the call and its results is rejected (`continuation_reasoning_effort_mismatch` / `continuation_policy_mismatch`); the pending call stays intact so you can retry corrected. Pending tool calls are held in memory for 5 minutes, with the deadline restarted whenever an incoming request selects the pending response by `previous_response_id` or matching tool-call IDs. They do not survive a proxy restart.

## Codex-specific extensions

These are additive but nonstandard. Strict Chat Completions clients should ignore or strip them.

### Continue a Codex thread

Pass the `id` of the newest completed response as top-level `previous_response_id` to continue its persisted Codex thread:

```json
{
  "model": "gpt-5.6-luna",
  "messages": [{ "role": "user", "content": "Now explain the test strategy." }],
  "previous_response_id": "chatcmpl_codex_..."
}
```

- Send only the new user message — the persisted thread already has the earlier turns.
- A continuation must use the same model, `reasoning_effort`, tools, and `x_codex` settings as the original.
- Only the newest response can be continued; unknown, expired, superseded, or busy IDs are rejected — the proxy never silently starts a new thread.
- Completed threads survive a proxy restart.

### Receive Codex activity

Responses can include two nonstandard fields on the assistant delta/message:

| Field          | Contents                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------- |
| `reasoning`    | Codex's reasoning summary (string)                                                            |
| `tool_results` | Status/results of Codex's internal activity (commands, file changes, MCP calls, web searches) |

Reasoning deltas stream as they arrive. If app-server supplies reasoning only in
the completed item, the proxy emits that final text without repeating any
prefix already streamed for the same item.

Internal activity also appears as function-shaped entries in `tool_calls`. These are **observational** — Codex already executed them. Do not execute them, and do not send tool results for them; they never cause `finish_reason: "tool_calls"`. Only your own client-defined functions suspend the turn and require `role: "tool"` follow-ups.

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

The JSON Schema ships with the package at `protocol/schemas/x-codex.schema.json`.

> **Project trust:** starting a new thread with `workspace-write` and a `cwd` can cause Codex to mark that project as trusted in your `config.toml`. Keep `--root` as narrow as possible.

## Usage metadata

When Codex reports exact usage for the turn, responses include standard `prompt_tokens`, `completion_tokens`, and `total_tokens`, plus cached-input and reasoning-token detail when available. When no complete record exists, `usage` is omitted — never estimated.

## Safety and limits

- The listener accepts loopback only (`127.0.0.1`, `::1`, `localhost`); non-loopback `Host` authorities and any request with an `Origin` header are rejected.
- There is no local bearer-token check, so any process running as your user can call the proxy. See the [security model](https://github.com/CIVITAS-John/codex-app-server-to-proxy/blob/main/docs/security.md).
- Structured JSON logs go to stderr. Default logs omit paths and command details; `--log-level debug` may reveal them, so review debug output before sharing.

Default limits (all configurable via CLI flags):

| Limit                                       | Default                                     |
| ------------------------------------------- | ------------------------------------------- |
| JSON body size                              | 1 MiB                                       |
| Concurrent HTTP requests                    | 100 (excess rejected with 429 `overloaded`) |
| Request deadline                            | 30 s                                        |
| Suspended tool-call deadline                | 5 min                                       |
| Login / startup deadline (`--tool-timeout`) | 5 min                                       |

A second request for an active Codex thread returns 409 `thread_busy`. If app-server crashes, the proxy retries with bounded backoff while `/ready` returns 503.
The request deadline aborts downstream work and closes any response that is still open, including a stream blocked by a client that stopped reading; its concurrency slot is then released.

## Troubleshooting

| Symptom                          | What to do                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/ready` returns 503             | Login or startup hasn't finished — follow [Authentication](#authentication) and check the stderr logs for `app_server_ready` or `startup_failed` |
| Browser login never appears      | Non-terminal stderr selects device-code login; run `serve` in a foreground terminal without redirecting stderr                                   |
| Address already in use           | Choose another loopback `--port`                                                                                                                 |
| `--codex-path` override rejected | The override must report exactly `codex-cli 0.145.0` (the version bundled with this package); remove the flag to use the bundled executable      |
| Policy request denied            | Managed requirements disallow the value; the proxy never silently weakens policy                                                                 |

For deeper diagnosis, temporarily add `--log-level debug` — but treat its output as sensitive.

## Uninstall and cleanup

```sh
npm uninstall --global codex-openai-proxy
# Or, from a project that installed it locally:
npm uninstall codex-openai-proxy
```

- Continuation state lives under `~/.codex-openai-proxy` (one namespace per `--root`), or your custom `--state-dir`. The proxy's Codex home — including its ChatGPT login and Codex caches — lives at `~/.codex-openai-proxy/codex-home`, or your custom `--codex-home`. Uninstalling deletes neither.
- Stop every proxy using a root before deleting its namespace. Deleting state invalidates its `previous_response_id` values but does not touch Codex's threads; deleting `codex-home` also signs the proxy out (the next startup re-seeds from `~/.codex` when a login exists there), while the Codex CLI's own `~/.codex` login is never affected.

## Documentation

- [Development guide](https://github.com/CIVITAS-John/codex-app-server-to-proxy/blob/main/docs/development.md) — source layout, commands, tests, and verification modes
- [Security model](https://github.com/CIVITAS-John/codex-app-server-to-proxy/blob/main/docs/security.md) — threat model and audit boundary
- [Implementation plan](https://github.com/CIVITAS-John/codex-app-server-to-proxy/blob/main/plans/README.md) — decisions and remaining work
- [App-server protocol reference](https://github.com/CIVITAS-John/codex-app-server-to-proxy/blob/main/docs/codex-app-server.md)
