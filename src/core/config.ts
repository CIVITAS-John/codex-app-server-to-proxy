import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Default maximum accepted HTTP request-body size. */
export const DEFAULT_BODY_LIMIT = 1024 * 1024;

/** Fully validated configuration for the proxy server. */
export interface ServeOptions {
  host: "127.0.0.1" | "::1";
  port: number;
  root: string;
  codexPath: string;
  toolTimeoutMs: number;
  implicitToolContinuation: boolean;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
  bodyLimitBytes: number;
  maxRequests: number;
  logLevel: LogLevel;
  stateDir: string;
}

/** Supported structured-log severity levels. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Normalizes accepted host spellings to validated loopback addresses. */
export function normalizeLoopbackHost(value: string): ServeOptions["host"] {
  const host = value.trim().toLowerCase();
  if (host === "127.0.0.1") return "127.0.0.1";
  if (host === "::1") return "::1";
  if (host === "localhost") return "127.0.0.1";
  throw new Error(
    `Invalid --host ${JSON.stringify(value)}. Only 127.0.0.1, ::1, and localhost are allowed.`,
  );
}

/** Parses a bounded integer CLI option. */
function integer(
  name: string,
  value: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

/** Parses a positive duration CLI option into milliseconds. */
function duration(name: string, value: string): number {
  const match = /^(\d+)(ms|s|m)?$/.exec(value);
  if (!match)
    throw new Error(`${name} must be a duration such as 500ms, 30s, or 5m.`);
  const amount = Number(match[1]);
  const multiplier = match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
  const result = amount * multiplier;
  if (!Number.isSafeInteger(result) || result < 1)
    throw new Error(`${name} must be positive.`);
  return result;
}

/** Parses an explicit true-or-false CLI option. */
function boolean(name: string, value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

/** Per-root state directory under the user's home, kept outside the root. */
function defaultStateDir(root: string): string {
  const namespace = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(homedir(), ".codex-openai-proxy", namespace);
}

/** Parses and validates all options for the serve command. */
export function parseServeOptions(
  args: readonly string[],
  cwd = process.cwd(),
): ServeOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined || !token.startsWith("--"))
      throw new Error(`Unexpected argument: ${token}`);
    const equals = token.indexOf("=");
    const name = equals < 0 ? token : token.slice(0, equals);
    const next = equals < 0 ? args[index + 1] : token.slice(equals + 1);
    if (next === undefined || (equals < 0 && next.startsWith("--")))
      throw new Error(`Missing value for ${name}.`);
    if (values.has(name)) throw new Error(`Duplicate option: ${name}.`);
    values.set(name, next);
    if (equals < 0) index += 1;
  }
  const known = new Set([
    "--host",
    "--port",
    "--root",
    "--codex-path",
    "--tool-timeout",
    "--implicit-tool-continuation",
    "--request-timeout",
    "--shutdown-timeout",
    "--body-limit",
    "--max-requests",
    "--log-level",
    "--state-dir",
  ]);
  for (const name of values.keys())
    if (!known.has(name)) throw new Error(`Unknown option: ${name}.`);

  const root = resolve(cwd, values.get("--root") ?? ".");
  const stateValue = values.get("--state-dir");
  // The default state directory lives outside the root so a writable-sandbox
  // request (whose writable set is the root) can never reach the proxy's own
  // continuation store. It is namespaced by root so distinct projects stay
  // isolated. An explicit --state-dir is honored verbatim; placing one inside
  // the root re-opens that exposure under `workspace-write`.
  const stateDir =
    stateValue === undefined
      ? defaultStateDir(root)
      : isAbsolute(stateValue)
        ? stateValue
        : resolve(root, stateValue);
  const logLevel = values.get("--log-level") ?? "info";
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new Error("--log-level must be debug, info, warn, or error.");
  }
  return {
    host: normalizeLoopbackHost(values.get("--host") ?? "127.0.0.1"),
    port: integer("--port", values.get("--port") ?? "8787", 0, 65_535),
    root,
    codexPath: values.get("--codex-path") ?? "codex",
    toolTimeoutMs: duration(
      "--tool-timeout",
      values.get("--tool-timeout") ?? "5m",
    ),
    implicitToolContinuation: boolean(
      "--implicit-tool-continuation",
      values.get("--implicit-tool-continuation") ?? "true",
    ),
    requestTimeoutMs: duration(
      "--request-timeout",
      values.get("--request-timeout") ?? "30s",
    ),
    shutdownTimeoutMs: duration(
      "--shutdown-timeout",
      values.get("--shutdown-timeout") ?? "10s",
    ),
    bodyLimitBytes: integer(
      "--body-limit",
      values.get("--body-limit") ?? String(DEFAULT_BODY_LIMIT),
      1,
      100 * 1024 * 1024,
    ),
    maxRequests: integer(
      "--max-requests",
      values.get("--max-requests") ?? "100",
      1,
      10_000,
    ),
    logLevel: logLevel as LogLevel,
    stateDir,
  };
}
