import type { JsonRpcTransport } from "./json-rpc.js";
import { record } from "../core/canonical.js";
import type {
  PolicyRequirements,
  WindowsSandboxImplementation,
} from "../core/policy.js";

/** Thread config supplied by the proxy in addition to request policy fields. */
export interface ThreadConfigOverrides {
  "windows.sandbox"?: WindowsSandboxImplementation;
}

/** Resolves proxy-owned thread config for one canonical working directory. */
export type ThreadConfigResolver = (
  cwd: string,
  signal?: AbortSignal,
) => Promise<ThreadConfigOverrides>;

/** Minimal request surface needed to inspect effective Codex configuration. */
interface ConfigReader {
  request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

/** Legacy feature keys that already select a Windows sandbox implementation. */
const LEGACY_WINDOWS_SANDBOX_FEATURES = [
  "experimental_windows_sandbox",
  "elevated_windows_sandbox",
  "enable_experimental_windows_sandbox",
] as const;

/** Reports whether effective config already selects a Windows sandbox backend. */
function hasConfiguredWindowsSandbox(config: Record<string, unknown>): boolean {
  const windowsValue = config.windows;
  if (windowsValue !== undefined && windowsValue !== null) {
    const windows = record(windowsValue);
    if (!windows)
      throw new Error("config/read returned malformed windows configuration.");
    const sandbox = windows.sandbox;
    if (sandbox !== undefined && sandbox !== null) {
      if (sandbox !== "elevated" && sandbox !== "unelevated")
        throw new Error(
          "config/read returned an unsupported Windows sandbox implementation.",
        );
      return true;
    }
  }

  const featuresValue = config.features;
  if (featuresValue === undefined || featuresValue === null) return false;
  const features = record(featuresValue);
  if (!features)
    throw new Error("config/read returned malformed feature configuration.");
  return LEGACY_WINDOWS_SANDBOX_FEATURES.some(
    (feature) => features[feature] === true,
  );
}

/**
 * Selects unelevated sandboxing on native Windows only when neither effective
 * config nor managed requirements already determine the implementation.
 */
export async function resolveWindowsSandboxThreadConfig(
  reader: ConfigReader,
  cwd: string,
  requirements: PolicyRequirements,
  platform: NodeJS.Platform = process.platform,
  signal?: AbortSignal,
): Promise<ThreadConfigOverrides> {
  if (platform !== "win32") return {};
  const allowed = requirements.allowedWindowsSandboxImplementations;
  // A managed allowlist remains authoritative; Codex applies its own allowed
  // fallback when unelevated is prohibited.
  if (allowed !== null && !allowed.includes("unelevated")) return {};

  const response = record(
    await reader.request("config/read", { cwd, includeLayers: false }, signal),
  );
  const config = record(response?.config);
  if (!config) throw new Error("config/read returned a malformed response.");
  return hasConfiguredWindowsSandbox(config)
    ? {}
    : { "windows.sandbox": "unelevated" };
}

/** Creates the real app-server resolver used by proxy HTTP requests. */
export function createThreadConfigResolver(
  rpc: JsonRpcTransport,
  requirements: PolicyRequirements,
): ThreadConfigResolver {
  return async (cwd, signal) =>
    await resolveWindowsSandboxThreadConfig(
      rpc,
      cwd,
      requirements,
      process.platform,
      signal,
    );
}
