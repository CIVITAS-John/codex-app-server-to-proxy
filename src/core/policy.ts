import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { createHash } from "node:crypto";

/** Sandbox modes exposed by the x_codex request extension. */
export type SandboxMode =
  "read-only" | "workspace-write" | "danger-full-access";

/** Per-request web-search modes supported by the pinned app-server. */
export type WebSearchMode = "disabled" | "cached" | "indexed" | "live";

/** Non-interactive approval policies that the proxy can safely own. */
export type ApprovalPolicy = "never" | "on-request" | "untrusted";

/** Approval reviewers accepted by the pinned app-server protocol. */
export type ApprovalsReviewer = "auto_review" | "guardian_subagent" | "user";

/** Relevant managed requirements read from app-server at startup. */
export interface PolicyRequirements {
  allowedApprovalPolicies: ApprovalPolicy[] | null;
  allowedApprovalsReviewers: ApprovalsReviewer[] | null;
  allowedSandboxModes: SandboxMode[] | null;
  allowedWebSearchModes: WebSearchMode[] | null;
}

/** The validated request-side x_codex policy extension. */
export interface RequestPolicy {
  cwd?: string | undefined;
  sandbox?: SandboxMode | undefined;
  webSearch?: WebSearchMode | undefined;
}

/** JSON-safe policy material persisted as the continuation binding. */
export interface PolicyBindingInput {
  cwd: string;
  sandbox: SandboxMode;
  webSearch: WebSearchMode;
  approvalPolicy: ApprovalPolicy;
  approvalsReviewer: ApprovalsReviewer | null;
}

/** Full app-server sandbox policy applied explicitly to every turn. */
export type EffectiveSandboxPolicy =
  | { type: "readOnly"; networkAccess: false }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: false;
      excludeTmpdirEnvVar: false;
      excludeSlashTmp: false;
    }
  | { type: "dangerFullAccess" };

/** Canonical effective settings bound to a response and Codex thread. */
export interface EffectivePolicy {
  cwd: string;
  sandbox: SandboxMode;
  webSearch: WebSearchMode;
  approvalPolicy: ApprovalPolicy;
  approvalsReviewer?: ApprovalsReviewer | undefined;
  sandboxPolicy: EffectiveSandboxPolicy;
}

/** A request-policy failure safe to expose without filesystem details. */
export class PolicyError extends Error {
  constructor(
    public readonly code: string,
    public readonly param: string,
    message: string,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

/** Requirements used when app-server reports no managed restrictions. */
export const UNRESTRICTED_POLICY_REQUIREMENTS: PolicyRequirements = {
  allowedApprovalPolicies: null,
  allowedApprovalsReviewers: null,
  allowedSandboxModes: null,
  allowedWebSearchModes: null,
};

/** Minimal path semantics needed for cross-platform containment checks. */
export interface PathSemantics {
  isAbsolute(path: string): boolean;
  relative(from: string, to: string): string;
  sep: string;
}

/** Checks canonical path containment using host or supplied platform semantics. */
export function isPathWithinRoot(
  root: string,
  candidate: string,
  paths: PathSemantics = { isAbsolute, relative, sep },
): boolean {
  const fromRoot = paths.relative(root, candidate);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${paths.sep}`) &&
      !paths.isAbsolute(fromRoot))
  );
}

/** Resolves and verifies the configured working-directory root. */
export async function canonicalizeRoot(path: string): Promise<string> {
  if (!isAbsolute(path))
    throw new Error("--root must name an absolute readable directory.");
  try {
    const canonical = await realpath(path);
    await access(canonical, constants.R_OK | constants.X_OK);
    if (!(await stat(canonical)).isDirectory())
      throw new Error("not directory");
    return canonical;
  } catch {
    throw new Error("--root must name a readable directory.");
  }
}

/** Validates the complete public x_codex extension without ignoring fields. */
export function validateRequestPolicy(value: unknown): RequestPolicy {
  if (value === undefined) return {};
  const extension = record(value);
  if (!extension)
    throw new PolicyError(
      "invalid_x_codex",
      "x_codex",
      "x_codex must be an object.",
    );
  const allowed = new Set(["cwd", "sandbox", "web_search"]);
  if (Object.keys(extension).some((key) => !allowed.has(key)))
    throw new PolicyError(
      "invalid_x_codex",
      "x_codex",
      "x_codex contains unsupported fields.",
    );
  if (
    extension.cwd !== undefined &&
    (typeof extension.cwd !== "string" || extension.cwd.length === 0)
  )
    throw new PolicyError(
      "invalid_cwd",
      "x_codex.cwd",
      "x_codex.cwd must be a non-empty string.",
    );
  const sandboxes: readonly string[] = [
    "read-only",
    "workspace-write",
    "danger-full-access",
  ];
  if (
    extension.sandbox !== undefined &&
    (typeof extension.sandbox !== "string" ||
      !sandboxes.includes(extension.sandbox))
  )
    throw new PolicyError(
      "unsupported_sandbox",
      "x_codex.sandbox",
      "x_codex.sandbox is not supported.",
    );
  const webSearchModes: readonly string[] = [
    "disabled",
    "cached",
    "indexed",
    "live",
  ];
  if (
    extension.web_search !== undefined &&
    (typeof extension.web_search !== "string" ||
      !webSearchModes.includes(extension.web_search))
  )
    throw new PolicyError(
      "unsupported_web_search",
      "x_codex.web_search",
      "x_codex.web_search is not supported.",
    );
  return {
    ...(typeof extension.cwd === "string" ? { cwd: extension.cwd } : {}),
    ...(typeof extension.sandbox === "string"
      ? { sandbox: extension.sandbox as SandboxMode }
      : {}),
    ...(typeof extension.web_search === "string"
      ? { webSearch: extension.web_search as WebSearchMode }
      : {}),
  };
}

/** Parses the relevant portion of configRequirements/read strictly. */
export function parsePolicyRequirements(value: unknown): PolicyRequirements {
  const response = record(value);
  if (!response || !("requirements" in response))
    throw new Error("configRequirements/read returned a malformed response.");
  if (response.requirements === null) return UNRESTRICTED_POLICY_REQUIREMENTS;
  const requirements = record(response.requirements);
  if (!requirements)
    throw new Error("configRequirements/read returned malformed requirements.");
  return {
    allowedApprovalPolicies: stringAllowlist(
      requirements.allowedApprovalPolicies,
      ["never", "on-request", "untrusted"],
      "allowedApprovalPolicies",
      true,
    ) as ApprovalPolicy[] | null,
    allowedApprovalsReviewers: stringAllowlist(
      requirements.allowedApprovalsReviewers,
      ["user", "auto_review", "guardian_subagent"],
      "allowedApprovalsReviewers",
    ) as ApprovalsReviewer[] | null,
    allowedSandboxModes: stringAllowlist(
      requirements.allowedSandboxModes,
      ["read-only", "workspace-write", "danger-full-access"],
      "allowedSandboxModes",
    ) as SandboxMode[] | null,
    allowedWebSearchModes: stringAllowlist(
      requirements.allowedWebSearchModes,
      ["disabled", "cached", "indexed", "live"],
      "allowedWebSearchModes",
    ) as WebSearchMode[] | null,
  };
}

/** Resolves request selections against the canonical root and managed policy. */
export async function resolveEffectivePolicy(
  request: RequestPolicy,
  root: string,
  requirements: PolicyRequirements,
): Promise<EffectivePolicy> {
  const cwd = await canonicalizeRequestCwd(request.cwd ?? root, root);
  const sandbox = request.sandbox ?? "read-only";
  const webSearch = request.webSearch ?? "disabled";
  requireAllowed(
    sandbox,
    requirements.allowedSandboxModes,
    "x_codex.sandbox",
    "sandbox_not_allowed",
  );
  requireAllowed(
    webSearch,
    requirements.allowedWebSearchModes,
    "x_codex.web_search",
    "web_search_not_allowed",
  );
  const approvalPolicy = selectApprovalPolicy(requirements);
  const approvalsReviewer = selectApprovalsReviewer(requirements);
  return {
    cwd,
    sandbox,
    webSearch,
    approvalPolicy,
    approvalsReviewer,
    sandboxPolicy: sandboxPolicy(sandbox, cwd),
  };
}

/** Selects a managed-allowed reviewer, preferring non-interactive review. */
export function selectApprovalsReviewer(
  requirements: PolicyRequirements,
): ApprovalsReviewer {
  const allowed = requirements.allowedApprovalsReviewers;
  for (const candidate of ["auto_review", "guardian_subagent", "user"] as const)
    if (allowed === null || allowed.includes(candidate)) return candidate;
  throw new PolicyError(
    "approval_reviewer_not_allowed",
    "x_codex",
    "Managed requirements allow no supported approval reviewer.",
  );
}

/** Chooses the strictest proxy-supported non-interactive approval policy. */
export function selectApprovalPolicy(
  requirements: PolicyRequirements,
): ApprovalPolicy {
  const allowed = requirements.allowedApprovalPolicies;
  for (const candidate of ["never", "on-request", "untrusted"] as const)
    if (allowed === null || allowed.includes(candidate)) return candidate;
  throw new PolicyError(
    "approval_policy_not_allowed",
    "x_codex",
    "Managed requirements allow no supported non-interactive approval policy.",
  );
}

/** Builds the exact app-server sandbox policy for a canonical cwd. */
export function sandboxPolicy(
  sandbox: SandboxMode,
  cwd: string,
): EffectiveSandboxPolicy {
  if (sandbox === "read-only")
    return { type: "readOnly", networkAccess: false };
  if (sandbox === "workspace-write")
    return {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  return { type: "dangerFullAccess" };
}

/** Returns the canonical effective fields whose meaning must not change. */
export function policyBindingInput(
  policy: EffectivePolicy,
): PolicyBindingInput {
  return {
    cwd: policy.cwd,
    sandbox: policy.sandbox,
    webSearch: policy.webSearch,
    approvalPolicy: policy.approvalPolicy,
    approvalsReviewer: policy.approvalsReviewer ?? null,
  };
}

/** Computes a stable continuation hash for canonical effective settings. */
export function policyBindingHash(policy: EffectivePolicy): string {
  return createHash("sha256")
    .update(canonicalJson(policyBindingInput(policy)))
    .digest("hex");
}

/** Resolves a requested cwd and enforces canonical root containment. */
async function canonicalizeRequestCwd(
  requested: string,
  root: string,
): Promise<string> {
  if (!isAbsolute(requested))
    throw new PolicyError(
      "invalid_cwd",
      "x_codex.cwd",
      "x_codex.cwd must be an absolute path to a readable directory.",
    );
  let canonical: string;
  try {
    canonical = await realpath(requested);
    await access(canonical, constants.R_OK | constants.X_OK);
    if (!(await stat(canonical)).isDirectory())
      throw new Error("not directory");
  } catch {
    throw new PolicyError(
      "invalid_cwd",
      "x_codex.cwd",
      "x_codex.cwd must be an absolute path to a readable directory.",
    );
  }
  if (!isPathWithinRoot(root, canonical))
    throw new PolicyError(
      "cwd_outside_root",
      "x_codex.cwd",
      "x_codex.cwd must resolve within the configured root.",
    );
  return canonical;
}

/** Rejects a managed-disallowed request selection without approximation. */
function requireAllowed<T extends string>(
  value: T,
  allowed: readonly T[] | null,
  param: string,
  code: string,
): void {
  if (allowed !== null && !allowed.includes(value))
    throw new PolicyError(
      code,
      param,
      "The requested setting is disallowed by managed policy.",
    );
}

/** Parses a nullable managed string allowlist and rejects malformed entries. */
function stringAllowlist(
  value: unknown,
  supported: readonly string[],
  name: string,
  allowGranular = false,
): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value))
    throw new Error(`configRequirements/read returned malformed ${name}.`);
  const result: string[] = [];
  for (const entry of value) {
    if (allowGranular && isGranularApproval(entry)) continue;
    if (typeof entry !== "string" || !supported.includes(entry))
      throw new Error(`configRequirements/read returned malformed ${name}.`);
    result.push(entry);
  }
  return result;
}

/** Recognizes the generated granular approval-policy shape for safe omission. */
function isGranularApproval(value: unknown): boolean {
  const outer = record(value);
  const granular = record(outer?.granular);
  if (
    !outer ||
    !granular ||
    Object.keys(outer).some((key) => key !== "granular")
  )
    return false;
  const required = ["sandbox_approval", "rules", "mcp_elicitations"];
  const optional = ["skill_approval", "request_permissions"];
  const accepted = [...required, ...optional];
  return (
    Object.keys(granular).every((key) => accepted.includes(key)) &&
    required.every((key) => typeof granular[key] === "boolean") &&
    optional.every(
      (key) =>
        granular[key] === undefined || typeof granular[key] === "boolean",
    )
  );
}

/** Canonicalizes JSON-compatible values with sorted object keys. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Narrows a JSON-like value to a non-array object. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
