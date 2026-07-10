# Vercel AI SDK provider for Codex app-server

This repository is the design workspace for a Vercel AI SDK language-model provider backed by `codex app-server`.

The provider will launch and communicate with the local Codex app-server over stdio JSONL, expose Codex as an AI SDK model, and translate its thread/turn/item protocol into AI SDK streaming parts.

## Scope

The first release supports only:

- first-use sign-in with ChatGPT;
- streamed text, reasoning, and tool-call parts;
- Vercel AI SDK dynamic tools bridged to Codex dynamic tools;
- opt-in sandbox and web-search modes, disabled unless explicitly enabled;
- token usage and Codex metadata;
- aggressive reuse of Codex threads, including across tool steps belonging to one AI SDK streaming request.

Everything else in the app-server protocol is out of scope until these paths are reliable. In particular, the first release does not expose Codex approvals, MCP/apps, file/image generation, realtime/audio, thread management UI, or arbitrary app-server RPCs.

## Intended API

The exact names will be validated against the installed AI SDK version during implementation, but the target ergonomics are:

```ts
import { streamText, tool } from 'ai';
import { createCodex } from '@ai-sdk/codex-app-server';
import { z } from 'zod';

const codex = createCodex({
  cwd: process.cwd(),
  sandbox: false,
  webSearch: false,
});

const result = streamText({
  model: codex('gpt-5.1-codex'),
  prompt: 'Check the deployment and explain what you find.',
  tools: {
    deploymentStatus: tool({
      description: 'Read the current deployment status',
      inputSchema: z.object({ deploymentId: z.string() }),
      execute: async ({ deploymentId }) => lookupDeployment(deploymentId),
    }),
  },
  providerOptions: {
    codex: {
      sandbox: 'workspace-write',
      webSearch: true,
    },
  },
});
```

On first use, the provider checks `account/read`. If OpenAI authentication is required and no account is present, it starts the managed ChatGPT browser login, opens or reports the returned authorization URL, waits for `account/login/completed`, and then continues the original request. Codex owns token persistence and refresh.

## Architecture

The implementation is intentionally small and layered:

1. **Process and RPC transport** owns one long-lived `codex app-server` child process, performs `initialize`/`initialized`, correlates bidirectional JSON-RPC messages, handles cancellation, and fails all pending work if the process exits.
2. **Authentication gate** runs once per process/account state and coalesces concurrent first-use login attempts.
3. **Thread coordinator** starts or resumes threads and serializes turns per thread. A thread ID is propagated through provider metadata and reused for all compatible steps of one AI SDK request.
4. **Protocol adapter** converts AI SDK prompts and tools to `turn/start` and Codex dynamic-tool declarations, then maps app-server notifications back to AI SDK stream parts.
5. **Policy adapter** maps the two explicit feature switches to Codex sandbox and web-search configuration without silently widening access.

The app-server is stateful and bidirectional. It should not be spawned once per token stream, and its stdout must never be treated as an ordinary subprocess log stream.

## Streaming contract

The adapter consumes the canonical app-server lifecycle:

- `item/agentMessage/delta` becomes AI SDK text parts;
- `item/reasoning/summaryTextDelta` (and supported raw reasoning deltas) becomes reasoning parts;
- `item/tool/call` and `dynamicToolCall` lifecycle events become tool-call parts and tool execution/result handling;
- `thread/tokenUsage/updated` is accumulated and attached to the AI SDK finish event;
- `turn/completed` closes the stream with a mapped finish reason or error.

Ordering is preserved per app-server connection. Each logical item is keyed by its Codex `itemId`/`callId`, so interleaved text, reasoning, and tool activity can be reconstructed safely.

## Thread strategy

Threads are the unit of conversation state; turns are the unit of execution.

- A new independent AI SDK request starts a Codex thread unless the caller supplies resumable Codex metadata.
- Tool-related AI SDK steps reuse the originating thread instead of replaying the complete prompt into a fresh thread.
- Only one turn runs on a thread at a time. Concurrent continuations are queued or rejected deterministically.
- Aborts call `turn/interrupt`, wait for terminal `turn/completed`, and leave the thread eligible for an explicit later resume.
- Thread IDs are exposed as provider metadata, not hidden in global prompt hashes.

Codex dynamic tools expect a response while the same turn is active, whereas the AI SDK provider lifecycle may execute tools between model steps. Resolving that contract without deadlock is the first implementation spike and release gate; see the staged plan.

## Security defaults

- Sandbox access is off/read-only unless the caller explicitly enables a supported mode.
- Web search is off unless explicitly enabled.
- Sandbox and web-search options are validated independently.
- The provider never upgrades permissions in response to a model request.
- ChatGPT credentials remain managed by Codex and are never returned through provider metadata or logs.

## Planning

The implementation sequence, acceptance criteria, and open protocol decisions are in [plans/codex-vercel-provider.md](plans/codex-vercel-provider.md).

The local app-server reference is in [docs/codex-app-server.md](docs/codex-app-server.md).

## Status

Design only. No provider package has been implemented yet.
