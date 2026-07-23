import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalizeRoot, isPathWithinRoot } from "./policy.js";

/** Default maximum accepted HTTP request-body size. */
export const DEFAULT_BODY_LIMIT = 1024 * 1024;

/** User-facing description of the root-namespaced state default. */
export const DEFAULT_STATE_DIR_DESCRIPTION =
  "per-root under ~/.codex-openai-proxy";

/** User-facing description of the isolated Codex home default. */
export const DEFAULT_CODEX_HOME_DESCRIPTION =
  "~/.codex-openai-proxy/codex-home";

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
  codexHome: string;
}

/** Syntactically valid CLI options awaiting canonical root finalization. */
export interface ParsedServeOptions extends Omit<
  ServeOptions,
  "stateDir" | "codexHome"
> {
  stateDir?: string | undefined;
  codexHome?: string | undefined;
}

/** Supported structured-log severity levels. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/** A supported structured-log severity level. */
export type LogLevel = (typeof LOG_LEVELS)[number];

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

/** Highest delay Node timers schedule without overflowing to immediate firing. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** Parses a positive duration CLI option into milliseconds. */
function duration(name: string, value: string): number {
  const match = /^(\d+)(ms|s|m)?$/.exec(value);
  if (!match)
    throw new Error(`${name} must be a duration such as 500ms, 30s, or 5m.`);
  const amount = Number(match[1]);
  const multiplier = match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
  const result = amount * multiplier;
  if (
    !Number.isSafeInteger(result) ||
    result < 1 ||
    result > MAX_TIMER_DELAY_MS
  )
    throw new Error(`${name} must be between 1ms and ${MAX_TIMER_DELAY_MS}ms.`);
  return result;
}

/** Parses an explicit true-or-false CLI option. */
function boolean(name: string, value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

/** Validates a CLI string against a fixed list and returns its member type. */
function oneOf<T extends string>(
  name: string,
  value: string,
  allowed: readonly T[],
): T {
  const selected = allowed.find((candidate) => candidate === value);
  if (selected === undefined) {
    const last = allowed.at(-1);
    const choices =
      allowed.length < 2
        ? (last ?? "a supported value")
        : `${allowed.slice(0, -1).join(", ")}, or ${last}`;
    throw new Error(`${name} must be ${choices}.`);
  }
  return selected;
}

/** Builds the default per-root state directory from a canonical root. */
function defaultStateDir(root: string): string {
  const namespace = createHash("sha256")
    .update(root)
    .digest("hex")
    .slice(0, 16);
  return join(realpathSync(homedir()), ".codex-openai-proxy", namespace);
}

/** Builds the default proxy-owned Codex home shared across roots. */
// Isolating CODEX_HOME keeps the pinned app-server's on-disk caches (for
// example models_cache.json) from clashing with differently-versioned Codex
// installs that share ~/.codex, at the cost of a proxy-scoped ChatGPT login.
function defaultCodexHome(): string {
  return join(realpathSync(homedir()), ".codex-openai-proxy", "codex-home");
}

/** Canonicalizes the root and derives every root-dependent serve option. */
export async function resolveServeOptions(
  parsed: ParsedServeOptions,
): Promise<ServeOptions> {
  const canonicalRoot = await canonicalizeRoot(parsed.root);
  const usesDefaultStateDir = parsed.stateDir === undefined;
  const stateDir =
    parsed.stateDir === undefined
      ? defaultStateDir(canonicalRoot)
      : isAbsolute(parsed.stateDir)
        ? parsed.stateDir
        : resolve(canonicalRoot, parsed.stateDir);
  if (usesDefaultStateDir && isPathWithinRoot(canonicalRoot, stateDir))
    throw new Error(
      "The default --state-dir falls inside --root; set --state-dir to a directory outside the root.",
    );
  const usesDefaultCodexHome = parsed.codexHome === undefined;
  const codexHome =
    parsed.codexHome === undefined
      ? defaultCodexHome()
      : isAbsolute(parsed.codexHome)
        ? parsed.codexHome
        : resolve(canonicalRoot, parsed.codexHome);
  if (usesDefaultCodexHome && isPathWithinRoot(canonicalRoot, codexHome))
    throw new Error(
      "The default --codex-home falls inside --root; set --codex-home to a directory outside the root.",
    );
  return { ...parsed, root: canonicalRoot, stateDir, codexHome };
}

/** Parses and validates CLI syntax without accessing the filesystem. */
export function parseServeOptions(
  args: readonly string[],
  cwd = process.cwd(),
): ParsedServeOptions {
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
    "--codex-home",
  ]);
  for (const name of values.keys())
    if (!known.has(name)) throw new Error(`Unknown option: ${name}.`);

  const root = resolve(cwd, values.get("--root") ?? ".");
  const stateValue = values.get("--state-dir");
  const codexHomeValue = values.get("--codex-home");
  const logLevel = oneOf(
    "--log-level",
    values.get("--log-level") ?? "info",
    LOG_LEVELS,
  );
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
    logLevel,
    ...(stateValue === undefined ? {} : { stateDir: stateValue }),
    ...(codexHomeValue === undefined ? {} : { codexHome: codexHomeValue }),
  };
}
