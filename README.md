# codex-openai-proxy

`codex-openai-proxy` is a planned npm/TypeScript CLI that exposes a deliberately small, OpenAI-compatible Chat Completions API backed by a local `codex app-server` child process and ChatGPT login.

This repository is currently in the design stage. The implementation plan starts at [plans/README.md](plans/README.md).

## Intended scope

The proxy will:

- serve `POST /v1/chat/completions` on loopback only;
- start and supervise `codex app-server` over stdio;
- guide the user through ChatGPT login on first start by opening a browser when possible and printing a URL/instructions as a fallback;
- stream assistant text, exposed reasoning, tool calls, tool results, and lifecycle information;
- support client-defined function tools, returning `tool_calls` and accepting results in a later request as `role: "tool"` messages;
- reuse persisted Codex threads through an additive `previous_response_id` request field;
- allow per-request working directory, sandbox mode, and web-search mode selection;
- return prompt, completion, total, cached-input, and reasoning token usage when app-server provides them;
- ignore harmless unsupported Chat Completions fields and log a warning; and
- provide mocked tests plus a small opt-in live suite that uses only `gpt-5.4-nano`.

It will not initially provide the Responses API, embeddings, images, audio, remote network serving, a programmatic library API, thread-management endpoints, or broad compatibility with every Chat Completions field.

## Proposed CLI

The package name is `codex-openai-proxy` and its only public interface is a CLI:

```sh
npx codex-openai-proxy serve
```

Proposed defaults:

- listen address: `127.0.0.1`;
- port: `8787`;
- model: supplied by each request (live development tests are pinned to `gpt-5.4-nano`);
- Codex process: package-managed Codex executable when packaging permits, otherwise a discovered `codex` executable with an actionable installation error;
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
  "model": "gpt-5.4-nano",
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
- `cwd`: an existing absolute directory, allowed to be outside the proxy's launch directory;
- `web_search`: `disabled`, `cached`, or `live`.

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

Pending dynamic calls are process-local in the first release. Persisted, completed threads can resume after a proxy restart, but a tool call awaiting a client result cannot.

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
- Live tests are opt-in, narrowly scoped, and must use `gpt-5.4-nano` exclusively.
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
