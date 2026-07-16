# codex-openai-proxy

`codex-openai-proxy` lets software written for the OpenAI Chat Completions API talk to Codex through a local HTTP endpoint. It runs `codex app-server`, uses your ChatGPT login, and keeps the listener on your machine.

The project is under active development. Text completions, streaming, function tools, usage metadata, thread continuation, and per-request Codex policy selection are implemented.

## Start the proxy

Node.js 20 or newer is required. Until the package is published, run it from this repository:

```sh
npm install
npm start
```

Once published, the CLI will also be available through:

```sh
npx codex-openai-proxy serve
```

The proxy listens at `http://127.0.0.1:8787` by default. On first use it starts the ChatGPT login flow. Interactive terminals open the authorization page when possible; non-interactive terminals use device-code login.

Check that the HTTP process is alive and that Codex is ready:

```sh
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/ready
```

`/health` reports proxy liveness. `/ready` returns HTTP 503 until app-server initialization and authentication finish, and while the proxy is recovering from an app-server failure.

## Use an OpenAI client

Point an OpenAI-compatible client at the local `/v1` base URL. The proxy does not require a local API key, although some client libraries require a non-empty placeholder value.

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "local",
});

const completion = await client.chat.completions.create({
  model: "gpt-5.4-mini",
  messages: [{ role: "user", content: "Summarize this project." }],
});

console.log(completion.choices[0].message.content);
```

The equivalent request with `curl` is:

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.4-mini",
    "messages": [{"role": "user", "content": "Summarize this project."}]
  }'
```

## OpenAI-compatible behavior

The proxy intentionally implements a focused subset of Chat Completions rather than every OpenAI API endpoint.

Standard behavior includes:

- `POST /v1/chat/completions` with text-only `system`, `developer`, `user`, `assistant`, and `tool` messages;
- streaming and non-streaming responses;
- Chat Completions SSE framing ending with `data: [DONE]`;
- assistant text in `choices[].message.content` or `choices[].delta.content`;
- client-defined function tools, `tool_calls`, and `finish_reason: "tool_calls"`;
- `stream_options.include_usage`; and
- OpenAI-shaped JSON errors.

The proxy ignores harmless unsupported top-level Chat Completions fields and writes one structured warning for the request. It rejects malformed, ambiguous, or unsafe input instead of approximating it.

This is not a general OpenAI API server. It does not provide the Responses API, embeddings, images, audio, model management, or remote network serving. Message content is currently text-only, and `tool_choice` currently supports only `"auto"` and `"none"`.

## Streaming

Set `stream: true` as with a standard Chat Completions request:

```sh
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.4-mini",
    "messages": [{"role": "user", "content": "Describe this repository."}],
    "stream": true,
    "stream_options": {"include_usage": true}
  }'
```

Standard clients can consume assistant text, client-defined function calls, the final finish reason, and the optional usage chunk without understanding Codex-specific data. Internal activity requires clients that tolerate the direct compatibility fields described below.

## Function tools

Function tools use the normal multi-request Chat Completions flow:

1. Send the function definitions in `tools`.
2. Receive an assistant response containing `tool_calls`.
3. Execute the requested functions in your client.
4. Send the assistant tool-call message followed by matching `role: "tool"` messages, repeating the same `tools` definition and the same `x_codex` policy settings from the original request.

By default, the proxy associates tool results with the one pending Codex turn through their `tool_call_id` values. Start it with `--implicit-tool-continuation false` if every tool-result request should instead supply the Codex continuation field described below. Either way, a tool-result request that omits or changes the original `x_codex` settings is rejected with `continuation_policy_mismatch` and leaves the pending call intact for a corrected retry.

Pending tool calls are held in memory for five minutes by default. They cannot survive a proxy restart; completed threads can.

## Codex extensions

Codex-specific behavior is additive. Clients that only need standard Chat Completions fields can ignore it.

### Continue a Codex thread

`previous_response_id` is an `x_codex` extension to the request contract, not a standard Chat Completions field. Pass the `id` from the newest completed response to continue its persisted Codex thread:

```json
{
  "model": "gpt-5.4-mini",
  "messages": [{ "role": "user", "content": "Now explain the test strategy." }],
  "previous_response_id": "chatcmpl_codex_..."
}
```

A continuation must use the same model and function-tool definitions as the original thread. The proxy rejects unknown, expired, superseded, busy, or incompatible response IDs and never silently starts a replacement thread. Only the newest response can be continued; branching from an older response is not supported.

### Receive Codex activity

The proxy sends Codex activity directly on the assistant delta/message. Text uses the standard `content` shape and calls use the standard `tool_calls` shape. Exposed reasoning uses `reasoning` (never `reasoning_summary`) and results use `tool_results`; these two direct compatibility fields are **not standard Chat Completions fields**. Streaming order is SSE chunk order; non-streaming responses aggregate those fields while preserving text that appeared before a call.

Internal app-server commands, file changes, MCP calls, web searches, collaboration calls, and other supported tool-like items are represented as function-shaped calls. A progress or terminal result repeats the matching call in `tool_calls` and places its bounded status/content in `tool_results`, making each result chunk self-correlating. These calls are observational and are already executed by app-server; clients must not execute them. They do not cause `finish_reason: "tool_calls"`.

Client-defined dynamic functions still suspend with `finish_reason: "tool_calls"` and require the normal follow-up `role: "tool"` messages. The continuation response begins with the accepted calls and `tool_results` together, then streams later reasoning, text, or internal activity from the same turn. `tool_results` and `reasoning` are nonstandard direct compatibility fields, not `x_codex` response extensions; clients requiring strict standard Chat Completions response objects must ignore or strip them. Request-side `previous_response_id` and policy settings remain explicitly documented `x_codex` extensions where applicable.

### Select Codex policy

Working-directory, sandbox, and web-search controls are nonstandard `x_codex` request extensions:

```json
{
  "model": "gpt-5.4-mini",
  "messages": [{ "role": "user", "content": "Review this project." }],
  "x_codex": {
    "cwd": "/absolute/path/to/project",
    "sandbox": "workspace-write",
    "web_search": "disabled"
  }
}
```

`cwd` must be an existing absolute directory whose resolved path is the configured root or one of its descendants. Symlink escapes, sibling directories, relative paths, files, and nonexistent paths are rejected. Omit it to use the root.

`sandbox` accepts `read-only`, `workspace-write`, or `danger-full-access` and defaults to `read-only`. Full access is never selected implicitly and cannot bypass managed app-server requirements. `web_search` accepts `disabled`, `cached`, `indexed`, or `live` and defaults to `disabled`. The proxy applies web-search configuration per Codex thread and never edits shared Codex configuration to simulate a request setting.

Approval policy is proxy-owned and non-interactive. The proxy prefers `never`, selects `auto_review` when managed policy permits it, and immediately declines any unexpected approval request with the method's supported response. Organization or machine requirements are loaded from app-server and disallowed selections fail instead of falling back.

Continuations must repeat the same effective `x_codex` settings. A change is rejected with `continuation_cwd_mismatch` or `continuation_policy_mismatch` before the thread is resumed.

> **Project trust side effect:** Starting a new thread with `workspace-write` and a `cwd` can cause app-server to mark that project as trusted in the user's `config.toml`. Set `--root` to the narrowest appropriate boundary; the proxy will not cause app-server to trust a directory outside it.

> **State directory placement:** Under `workspace-write` the Codex agent can write anywhere in the effective `cwd`. The proxy therefore derives its continuation store from the canonical root and keeps it outside that root by default (under `~/.codex-openai-proxy`, namespaced per root). Startup fails if a broad root would contain the default store. Relative `--state-dir` values are resolved against the canonical root. Pointing `--state-dir` back inside the root explicitly lets a writable-sandbox turn modify the store, so keep it outside the root.

## Usage metadata

When app-server reports exact counts, the proxy returns standard `prompt_tokens`, `completion_tokens`, and `total_tokens`. It also returns cached-input and reasoning-token detail when available. Missing counts are omitted and are never estimated.

## Safety and local operation

The listener accepts only `127.0.0.1`, `::1`, or `localhost`; non-loopback hosts are rejected. There is no proxy bearer-token check, so any process running as your local user may be able to call it.

The launch directory is the default root for Codex work. Set a narrower boundary when needed:

```sh
npx codex-openai-proxy serve --root /absolute/path/to/project
```

The proxy writes structured JSON logs to stderr. Default logs omit working directories and command details. `--log-level debug` is the opt-in diagnostic mode and may reveal the configured root or redacted app-server diagnostic context, so capture it carefully. Run `npx codex-openai-proxy --help` for all server, timeout, capacity, logging, state, and Codex executable options.

## Project documentation

- [Repository guide](docs/development.md) explains the source layout, development commands, tests, and generated protocol files.
- [Implementation plan](plans/README.md) tracks product decisions, completed stages, and remaining work.
- [App-server protocol reference](docs/codex-app-server.md) is the checked-in upstream protocol reference used during implementation.
