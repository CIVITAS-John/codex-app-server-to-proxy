import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalizeRoot, isPathWithinRoot } from "./policy.js";

/** Default maximum accepted HTTP request-body size. */
export const DEFAULT_BODY_LIMIT = 1024 * 1024;

/**
 * Deadline for app-server spawn and, on first run, the interactive login.
 * Previously tunable as `--tool-timeout`, which no longer exists: dynamic
 * tool calls end their turn immediately, so no tool deadline remains and the
 * former flag's secondary role gets this fixed default instead.
 */
export const DEFAULT_STARTUP_TIMEOUT_MS = 5 * 60_000;

/** User-facing description of the instance state default. */
export const DEFAULT_STATE_DIR_DESCRIPTION =
  "~/.codex-openai-proxy/<root-hash>/<ipv4|ipv6>-<bound-port>/state";

/** User-facing description of the isolated Codex home default. */
export const DEFAULT_CODEX_HOME_DESCRIPTION =
  "~/.codex-openai-proxy/<root-hash>/<ipv4|ipv6>-<bound-port>/codex-home";

/** Fully validated configuration for the proxy server. */
export interface ServeOptions {
  host: "127.0.0.1" | "::1";
  port: number;
  root: string;
  codexPath: string;
  subagentsEnabled: boolean;
  implicitToolContinuation: boolean;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
  bodyLimitBytes: number;
  maxRequests: number;
  logLevel: LogLevel;
  syncAuth: SyncAuthMode;
  loginMode: LoginMode;
  stateDir: string;
  codexHome: string;
}

/** Validated CLI options whose directories are finalized after binding. */
export interface ParsedServeOptions extends Omit<
  ServeOptions,
  "stateDir" | "codexHome"
> {
  stateDir?: string | undefined;
  codexHome?: string | undefined;
}

/** Brand reserved for options produced by `prepareServeOptions`. */
declare const prepared: unique symbol;

/**
 * Parsed options with a canonical root and absolute explicit directories. Only
 * `prepareServeOptions` mints this type, so binding code cannot derive a
 * default instance directory from an unresolved root.
 */
export type PreparedServeOptions = ParsedServeOptions & {
  readonly [prepared]: true;
};

/** Supported structured-log severity levels. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/** A supported structured-log severity level. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Supported credential synchronization modes. */
export const SYNC_AUTH_MODES = ["always", "never"] as const;

/** A supported credential synchronization mode. */
export type SyncAuthMode = (typeof SYNC_AUTH_MODES)[number];

/** Supported app-server login modes. */
export const LOGIN_MODES = ["auto", "device-code", "browser"] as const;

/** A supported app-server login mode. */
export type LoginMode = (typeof LOGIN_MODES)[number];

/** Selects whether app-server login should attempt interactive browser launch. */
export function isInteractiveLogin(
  mode: LoginMode,
  stderrIsTty: boolean,
): boolean {
  if (mode === "auto") return stderrIsTty;
  return mode === "browser";
}

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

/**
 * Parses a bounded duration CLI option into milliseconds. Options that treat
 * zero as "do not wait" opt in through `minimumMs`; every other option keeps
 * the positive-duration requirement.
 */
function duration(
  name: string,
  value: string,
  {
    minimumMs = 1,
    maximumMs = MAX_TIMER_DELAY_MS,
  }: { minimumMs?: number; maximumMs?: number } = {},
): number {
  const match = /^(\d+)(ms|s|m)?$/.exec(value);
  if (!match)
    throw new Error(`${name} must be a duration such as 500ms, 30s, or 5m.`);
  const amount = Number(match[1]);
  const multiplier = match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
  const result = amount * multiplier;
  if (!Number.isSafeInteger(result) || result < minimumMs || result > maximumMs)
    throw new Error(
      `${name} must be between ${minimumMs}ms and ${maximumMs}ms.`,
    );
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
        : allowed.length === 2
          ? `${allowed[0]} or ${last}`
          : `${allowed.slice(0, -1).join(", ")}, or ${last}`;
    throw new Error(`${name} must be ${choices}.`);
  }
  return selected;
}

/** Builds the per-root namespace that holds every bound instance directory. */
function defaultNamespaceDir(root: string): string {
  const namespace = createHash("sha256")
    .update(root)
    .digest("hex")
    .slice(0, 16);
  return join(realpathSync(homedir()), ".codex-openai-proxy", namespace);
}

/**
 * Canonicalizes the root and resolves explicit paths without touching state.
 * Default directories differ only by their port-specific leaf, so a default
 * that would fall inside the root is rejected here, before the port is bound.
 */
export async function prepareServeOptions(
  parsed: ParsedServeOptions,
): Promise<PreparedServeOptions> {
  const canonicalRoot = await canonicalizeRoot(parsed.root);
  const namespaceInsideRoot =
    (parsed.stateDir === undefined || parsed.codexHome === undefined) &&
    isPathWithinRoot(canonicalRoot, defaultNamespaceDir(canonicalRoot));
  if (namespaceInsideRoot && parsed.stateDir === undefined)
    throw new Error(
      "The default --state-dir falls inside --root; set --state-dir to a directory outside the root.",
    );
  if (namespaceInsideRoot && parsed.codexHome === undefined)
    throw new Error(
      "The default --codex-home falls inside --root; set --codex-home to a directory outside the root.",
    );
  return {
    ...parsed,
    root: canonicalRoot,
    ...(parsed.stateDir === undefined
      ? {}
      : { stateDir: resolve(canonicalRoot, parsed.stateDir) }),
    ...(parsed.codexHome === undefined
      ? {}
      : { codexHome: resolve(canonicalRoot, parsed.codexHome) }),
  } as PreparedServeOptions;
}

/** Derives default directories only after the listener owns its actual port. */
export function finalizeServeOptions(
  options: PreparedServeOptions,
  port: number,
): ServeOptions {
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("The bound port must be between 1 and 65535.");
  const instanceDir = (): string =>
    join(
      defaultNamespaceDir(options.root),
      `${options.host === "::1" ? "ipv6" : "ipv4"}-${port}`,
    );
  return {
    ...options,
    port,
    stateDir: options.stateDir ?? join(instanceDir(), "state"),
    codexHome: options.codexHome ?? join(instanceDir(), "codex-home"),
  };
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
    "--subagents",
    "--implicit-tool-continuation",
    "--request-timeout",
    "--shutdown-timeout",
    "--body-limit",
    "--max-requests",
    "--log-level",
    "--sync-auth",
    "--login",
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
  const syncAuth = oneOf(
    "--sync-auth",
    values.get("--sync-auth") ?? "always",
    SYNC_AUTH_MODES,
  );
  const loginMode = oneOf(
    "--login",
    values.get("--login") ?? "auto",
    LOGIN_MODES,
  );
  return {
    host: normalizeLoopbackHost(values.get("--host") ?? "127.0.0.1"),
    port: integer("--port", values.get("--port") ?? "8787", 0, 65_535),
    root,
    codexPath: values.get("--codex-path") ?? "codex",
    subagentsEnabled: boolean(
      "--subagents",
      values.get("--subagents") ?? "false",
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
    syncAuth,
    loginMode,
    ...(stateValue === undefined ? {} : { stateDir: stateValue }),
    ...(codexHomeValue === undefined ? {} : { codexHome: codexHomeValue }),
  };
}
