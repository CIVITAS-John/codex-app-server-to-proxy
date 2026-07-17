import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { bindingHash, record } from "./canonical.js";

/** Sandbox modes exposed by the x_codex request extension. */
export const SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

/** A sandbox mode exposed by the x_codex request extension. */
export type SandboxMode = (typeof SANDBOX_MODES)[number];

/** Per-request web-search modes supported by the pinned app-server. */
export const WEB_SEARCH_MODES = [
  "disabled",
  "cached",
  "indexed",
  "live",
] as const;

/** A per-request web-search mode supported by the pinned app-server. */
export type WebSearchMode = (typeof WEB_SEARCH_MODES)[number];

/** Non-interactive approval policies in the proxy's preference order. */
const APPROVAL_POLICY_ORDER = ["never", "on-request", "untrusted"] as const;

/** A non-interactive approval policy that the proxy can safely own. */
export type ApprovalPolicy = (typeof APPROVAL_POLICY_ORDER)[number];

/** Approval reviewers in the proxy's preference order. */
const APPROVAL_REVIEWER_ORDER = [
  "auto_review",
  "guardian_subagent",
  "user",
] as const;

/** An approval reviewer accepted by the pinned app-server protocol. */
export type ApprovalsReviewer = (typeof APPROVAL_REVIEWER_ORDER)[number];

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
    return await canonicalDirectory(path);
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
  const sandbox = validateEnumField(
    extension.sandbox,
    SANDBOX_MODES,
    "unsupported_sandbox",
    "x_codex.sandbox",
    "x_codex.sandbox is not supported.",
  );
  const webSearch = validateEnumField(
    extension.web_search,
    WEB_SEARCH_MODES,
    "unsupported_web_search",
    "x_codex.web_search",
    "x_codex.web_search is not supported.",
  );
  return {
    ...(typeof extension.cwd === "string" ? { cwd: extension.cwd } : {}),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(webSearch === undefined ? {} : { webSearch }),
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
      APPROVAL_POLICY_ORDER,
      "allowedApprovalPolicies",
      true,
    ),
    allowedApprovalsReviewers: stringAllowlist(
      requirements.allowedApprovalsReviewers,
      APPROVAL_REVIEWER_ORDER,
      "allowedApprovalsReviewers",
    ),
    allowedSandboxModes: stringAllowlist(
      requirements.allowedSandboxModes,
      SANDBOX_MODES,
      "allowedSandboxModes",
    ),
    allowedWebSearchModes: stringAllowlist(
      requirements.allowedWebSearchModes,
      WEB_SEARCH_MODES,
      "allowedWebSearchModes",
    ),
  };
}

/** Resolves request selections against the canonical root and managed policy. */
export async function resolveEffectivePolicy(
  request: RequestPolicy,
  root: string,
  requirements: PolicyRequirements,
): Promise<EffectivePolicy> {
  // `root` is already canonical (the CLI resolves it once via canonicalizeRoot),
  // so a request that names no cwd needs no per-request filesystem walk. Only a
  // client-supplied cwd is canonicalized and bounded here.
  const cwd =
    request.cwd === undefined
      ? root
      : await canonicalizeRequestCwd(request.cwd, root);
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
  return firstAllowed(
    APPROVAL_REVIEWER_ORDER,
    requirements.allowedApprovalsReviewers,
    "approval_reviewer_not_allowed",
    "x_codex",
    "Managed requirements allow no supported approval reviewer.",
  );
}

/**
 * Chooses the strictest usable non-interactive approval policy, preferring the
 * least-interactive option app-server allows (`never`, then `on-request`, then
 * `untrusted`) so the proxy never depends on an interactive approver.
 */
export function selectApprovalPolicy(
  requirements: PolicyRequirements,
): ApprovalPolicy {
  return firstAllowed(
    APPROVAL_POLICY_ORDER,
    requirements.allowedApprovalPolicies,
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
  return bindingHash(policyBindingInput(policy));
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
    canonical = await canonicalDirectory(requested);
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

/** Resolves a readable directory while preserving filesystem check ordering. */
async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  await access(canonical, constants.R_OK | constants.X_OK);
  if (!(await stat(canonical)).isDirectory()) throw new Error("not directory");
  return canonical;
}

/** Returns the first managed-allowed value in the proxy's preference order. */
function firstAllowed<T extends string>(
  order: readonly T[],
  allowed: readonly T[] | null,
  code: string,
  param: string,
  message: string,
): T {
  for (const candidate of order)
    if (allowed === null || allowed.includes(candidate)) return candidate;
  throw new PolicyError(code, param, message);
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
function stringAllowlist<T extends string>(
  value: unknown,
  supported: readonly T[],
  name: string,
  allowGranular = false,
): T[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value))
    throw new Error(`configRequirements/read returned malformed ${name}.`);
  const result: T[] = [];
  for (const entry of value) {
    if (allowGranular && isGranularApproval(entry)) continue;
    if (typeof entry !== "string" || !includesString(supported, entry))
      throw new Error(`configRequirements/read returned malformed ${name}.`);
    result.push(entry);
  }
  return result;
}

/** Validates an optional request string against a supported enum tuple. */
function validateEnumField<T extends string>(
  value: unknown,
  allowed: readonly T[],
  code: string,
  param: string,
  message: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !includesString(allowed, value))
    throw new PolicyError(code, param, message);
  return value;
}

/** Narrows a string after membership checking without weakening tuple types. */
function includesString<T extends string>(
  values: readonly T[],
  value: string,
): value is T {
  return values.some((candidate) => candidate === value);
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
