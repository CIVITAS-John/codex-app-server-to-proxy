import type { JsonRpcTransport } from "../../src/app-server/json-rpc.js";
import {
  parseServeOptions,
  resolveServeOptions,
  type ServeOptions,
} from "../../src/core/config.js";
import type { Logger } from "../../src/core/logger.js";
import {
  UNRESTRICTED_POLICY_REQUIREMENTS,
  type PolicyRequirements,
} from "../../src/core/policy.js";
import { createProxyServer, type ProxyServer } from "../../src/http/server.js";
import { silentLogger } from "./logger.js";

/** Explicit settings for a ready proxy backed by a caller-supplied transport. */
export interface StartProxyWithTransportOptions {
  root: string;
  stateDir: string;
  requestTimeoutMs?: number | undefined;
  shutdownTimeoutMs?: number | undefined;
  toolTimeoutMs?: number | undefined;
  log?: Logger | undefined;
  requirements?: PolicyRequirements | undefined;
}

/** Running ready proxy and the fully resolved options used to create it. */
export interface StartedProxyWithTransport {
  origin: string;
  proxy: ProxyServer;
  options: ServeOptions;
}

/** Adds one optional millisecond-duration argument to a CLI argument list. */
function addDurationArgument(
  args: string[],
  name: string,
  durationMs: number | undefined,
): void {
  if (durationMs !== undefined) args.push(name, `${durationMs}ms`);
}

/** Starts an ephemeral ready proxy over a caller-supplied app-server transport. */
export async function startProxyWithTransport(
  rpc: JsonRpcTransport,
  settings: StartProxyWithTransportOptions,
): Promise<StartedProxyWithTransport> {
  const args = [
    "--port",
    "0",
    "--root",
    settings.root,
    "--state-dir",
    settings.stateDir,
  ];
  addDurationArgument(args, "--request-timeout", settings.requestTimeoutMs);
  addDurationArgument(args, "--shutdown-timeout", settings.shutdownTimeoutMs);
  addDurationArgument(args, "--tool-timeout", settings.toolTimeoutMs);
  const options = await resolveServeOptions(parseServeOptions(args));
  const proxy = createProxyServer(options, settings.log ?? silentLogger);
  proxy.setTransport(
    rpc,
    settings.requirements ?? UNRESTRICTED_POLICY_REQUIREMENTS,
  );
  proxy.setReady(true);
  const address = await proxy.listen();
  const host = address.address.includes(":")
    ? `[${address.address}]`
    : address.address;
  return {
    origin: `http://${host}:${address.port}`,
    proxy,
    options,
  };
}

/** Posts one JSON request to the proxy's Chat Completions endpoint. */
export function postChatCompletion(
  origin: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Extracts the stable OpenAI-shaped error code from an HTTP response. */
export async function responseErrorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}
