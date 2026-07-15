# codex-openai-proxy

`codex-openai-proxy` lets software written for the OpenAI Chat Completions API talk to Codex through a local HTTP endpoint. It runs `codex app-server`, uses your ChatGPT login, and keeps the listener on your machine.

The project is under active development. Text completions, streaming, function tools, usage metadata, and thread continuation are implemented. Per-request Codex policy selection is planned but not yet available.

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

Standard clients can consume assistant text, function calls, the final finish reason, and the optional usage chunk without understanding Codex-specific data.

## Function tools

Function tools use the normal multi-request Chat Completions flow:

1. Send the function definitions in `tools`.
2. Receive an assistant response containing `tool_calls`.
3. Execute the requested functions in your client.
4. Send the assistant tool-call message followed by matching `role: "tool"` messages, repeating the same `tools` definition.

By default, the proxy associates tool results with the one pending Codex turn through their `tool_call_id` values. Start it with `--implicit-tool-continuation false` if every tool-result request should instead supply the Codex continuation field described below.

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

Codex events without a standard Chat Completions representation appear under `x_codex`:

- streaming responses use `choices[].delta.x_codex`;
- non-streaming responses use `choices[].message.x_codex.events`.

These events can include exposed reasoning, command or file-operation progress, web-search activity, tool results, and other internal lifecycle events. They are `x_codex` extensions and are not portable Chat Completions fields.

### Select Codex policy

Per-request working directory, sandbox, and web-search selection are planned `x_codex` request extensions. The current build rejects non-empty request `x_codex` values rather than pretending to apply them. The CLI-wide `--root` option remains the effective working-directory boundary.

## Usage metadata

When app-server reports exact counts, the proxy returns standard `prompt_tokens`, `completion_tokens`, and `total_tokens`. It also returns cached-input and reasoning-token detail when available. Missing counts are omitted and are never estimated.

## Safety and local operation

The listener accepts only `127.0.0.1`, `::1`, or `localhost`; non-loopback hosts are rejected. There is no proxy bearer-token check, so any process running as your local user may be able to call it.

The launch directory is the default root for Codex work. Set a narrower boundary when needed:

```sh
npx codex-openai-proxy serve --root /absolute/path/to/project
```

The proxy writes structured JSON logs to stderr. Run `npx codex-openai-proxy --help` for all server, timeout, capacity, logging, state, and Codex executable options.

## Project documentation

- [Repository guide](docs/development.md) explains the source layout, development commands, tests, and generated protocol files.
- [Implementation plan](plans/README.md) tracks product decisions, completed stages, and remaining work.
- [App-server protocol reference](docs/codex-app-server.md) is the checked-in upstream protocol reference used during implementation.
