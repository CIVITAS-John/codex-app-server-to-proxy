# codex-openai-proxy

`codex-openai-proxy` is an npm/TypeScript CLI under staged development that exposes a deliberately small, OpenAI-compatible Chat Completions API backed by a local `codex app-server` child process and ChatGPT login.

## Development CLI

Build and start the Stage 04 server:

```sh
npm install
npm start
```

The listener defaults to `127.0.0.1:8787`. The CLI resolves Codex from the supported npm package when available, with `--codex-path` or `PATH` as fallbacks, validates it, and owns one `codex app-server` child. `GET /health` reports proxy liveness. `GET /ready` remains HTTP 503 until app-server initialization and usable ChatGPT authentication complete, and becomes unavailable again during bounded crash recovery.

Fresh text-only Chat Completions are translated in both streaming and non-streaming modes. Prior system, developer, user, and assistant messages are injected as role-preserving Responses API history; the final user message starts the Codex turn. Standard assistant text remains usable by generic clients, while exposed reasoning and internal activity use `x_codex` extensions. Exact last-turn usage is returned when app-server reports it. Continuation, client tool-result round trips, and request policy selection remain unavailable until their later stages and are rejected rather than approximated.

On first use, an interactive CLI attempts to open the ChatGPT authorization URL without a shell. If that fails, it prints the URL once to the interactive terminal; structured logs contain only a redacted event. A non-interactive CLI uses the device-code flow. Shutdown closes pending transport requests and terminates app-server after the configured grace period.

Run `node dist/bin.js --help` for loopback host, port, root, Codex path, state directory, timeout, request limit, and log-level options. Logs are structured JSON written only to stderr.

## Live hello-world test

The opt-in smoke test starts a real app-server and proxy, then makes exactly one model call through `POST /v1/chat/completions`. It runs serially, captures at most 1,000 response characters, and always uses `gpt-5.4-mini`:

```sh
CODEX_PROXY_LIVE=1 npm run test:live:hello
```

Set `CODEX_PATH` if `codex` is not on `PATH`. The command uses the existing ChatGPT login when available; otherwise it starts the normal interactive or device-code login flow. The default `npm test` configuration excludes all `*.live.test.ts` files.

## Intended scope

The proxy will:

- serve `POST /v1/chat/completions` on loopback only;
- start and supervise `codex app-server` over stdio;
- guide the user through ChatGPT login on first start by opening a browser when possible and printing a URL/instructions as a fallback;
- stream assistant text, exposed reasoning, tool calls, tool results, and lifecycle information where the pinned app-server exposes them;
- support client-defined function tools across requests by keeping app-server calls pending for a short client round trip;
- reuse persisted Codex threads through an additive `previous_response_id` request field;
- allow per-request working directory and sandbox selection, plus each web-search mode app-server can enforce for that request;
- return prompt, completion, total, cached-input, and reasoning token usage when app-server provides them;
- ignore harmless unsupported Chat Completions fields and log a warning; and
- provide mocked tests plus a small opt-in live suite that uses only `gpt-5.4-mini`.

It will not initially provide the Responses API, embeddings, images, audio, remote network serving, a programmatic library API, thread-management endpoints, or broad compatibility with every Chat Completions field.

## Proposed CLI

The package name is `codex-openai-proxy` and its only public interface is a CLI:

```sh
npx codex-openai-proxy serve
```

Proposed defaults:

- listen address: `127.0.0.1`;
- port: `8787`;
- model: supplied by each request (live development tests are pinned to `gpt-5.4-mini`);
- Codex process: package-managed Codex executable when packaging permits, otherwise a discovered `codex` executable with an actionable installation error;
- root directory: the proxy's launch directory, configurable with `--root`;
- local proxy authentication: none;
- unsupported request fields: ignored with structured warnings.

The host will be validated as loopback. Values other than `127.0.0.1`, `::1`, or `localhost` will be rejected rather than silently exposed.

## Proposed HTTP contract

The primary endpoint is:

```text
POST /v1/chat/completions
Content-Type: application/json
```

Ordinary Chat Completions fields remain conventional, including `model`, `messages`, `tools`, `tool_choice`, `stream`, and `stream_options.include_usage`.

The minimum extension is additive:

```json
{
  "model": "gpt-5.4-mini",
  "messages": [{ "role": "user", "content": "Inspect this project" }],
  "stream": true,
  "previous_response_id": "chatcmpl_codex_...",
  "x_codex": {
    "cwd": "/absolute/path/to/project",
    "sandbox": "workspace-write",
    "web_search": "live"
  }
}
```

`previous_response_id` is not a standard Chat Completions field. The proxy uses it to locate and resume the persisted Codex thread associated with an earlier response. Before accepting the request, the proxy verifies both its durable response mapping and the thread's current app-server state. An unknown, expired, superseded, busy, archived, deleted, policy-incompatible, or otherwise non-resumable continuation is rejected; the proxy never silently creates a replacement thread. A superseded reference (one that is no longer the newest response on its thread) is rejected rather than treated as a branch, because resuming would silently include the later turns. Clients may omit prior message history when continuing through this extension; only omission of `previous_response_id` creates a new thread.

Initial `x_codex` values are:

- `sandbox`: `read-only`, `workspace-write`, or `danger-full-access`;
- `cwd`: an existing directory that resolves to the configured root or one of its descendants;
- `web_search`: any enforceable value among `disabled`, `cached`, or `live`; unsupported values return an error.

Sandbox choice controls approval behavior. `danger-full-access` is never inferred. The request must select it explicitly, and the implementation must preserve any stricter machine or organization policy enforced by Codex.

## Streaming and tools

Streaming uses standard Chat Completions SSE framing:

```text
data: {"object":"chat.completion.chunk",...}

data: [DONE]
```

Standard clients receive assistant text in `choices[].delta.content`, function calls in `choices[].delta.tool_calls`, a final `finish_reason`, and usage in the final usage-bearing chunk when requested.

Additional Codex events that have no standard Chat Completions representation are carried under `choices[].delta.x_codex`. This may include exposed reasoning summaries/text, internal shell or file-operation progress, web-search activity, tool results, and approval state. Consumers that do not understand the extension can ignore it.

Client-defined tools follow the normal multi-request Chat Completions pattern:

1. Send `tools` with the user request.
2. Receive streamed `tool_calls` and a completion with `finish_reason: "tool_calls"`.
3. Send a new request with the returned assistant tool-call message, corresponding `role: "tool"` messages, and the prior response's `previous_response_id`.
4. The proxy delivers those results to the pending app-server dynamic-tool calls and continues the same Codex thread.

Pending dynamic calls are process-local in the first release. Their deadline is configurable and defaults to five minutes. Persisted, completed threads can resume after a proxy restart, but a tool call awaiting a client result cannot.

## Usage metadata

The proxy will populate standard Chat Completions usage fields:

```json
{
  "prompt_tokens": 120,
  "completion_tokens": 35,
  "total_tokens": 155,
  "prompt_tokens_details": { "cached_tokens": 80 },
  "completion_tokens_details": { "reasoning_tokens": 12 }
}
```

Fields unavailable from app-server are omitted rather than estimated.

## Development constraints

- Runtime baseline: Node.js 20+ on macOS, Linux, and Windows.
- Language: strict TypeScript.
- Public surface: CLI only.
- Unit and protocol tests use fixtures/mocks and make no paid model calls.
- Live tests are opt-in, narrowly scoped, and must use `gpt-5.4-mini` exclusively.
- Documentation and implementation must distinguish standard Chat Completions behavior from `x_codex` extensions.

## Design status

See the staged plan:

1. [Contract and spikes](plans/01-contract-and-spikes.md)
2. [Package and CLI foundation](plans/02-package-and-cli.md)
3. [App-server process and authentication](plans/03-app-server-and-auth.md)
4. [Chat Completions translation and streaming](plans/04-chat-streaming.md)
5. [Dynamic tools and thread reuse](plans/05-tools-and-threads.md)
6. [Sandbox, working directory, and web search](plans/06-policies.md)
7. [Quality, security, compatibility, and CI](plans/07-quality-and-ci.md)
8. [Packaging and release](plans/08-packaging-and-release.md)

## Source material

- [`docs/codex-app-server.md`](docs/codex-app-server.md) is the checked-in app-server protocol reference.
- OpenAI Chat Completions compatibility should be checked against the current official API reference during implementation.
