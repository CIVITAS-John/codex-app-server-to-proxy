import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, win32 } from "node:path";
import { test } from "vitest";
import {
  SANDBOX_MODES,
  WEB_SEARCH_MODES,
  PolicyError,
  UNRESTRICTED_POLICY_REQUIREMENTS,
  canonicalizeRoot,
  isPathWithinRoot,
  parsePolicyRequirements,
  policyBindingHash,
  policyBindingInput,
  resolveEffectivePolicy,
  sandboxPolicy,
  selectApprovalsReviewer,
  selectApprovalPolicy,
  validateRequestPolicy,
  type PolicyRequirements,
  type SandboxMode,
  type WebSearchMode,
} from "../../src/core/policy.js";
import { withTempDir } from "../support/temp.js";

/** Every sandbox exposed by the public x_codex extension. */
const sandboxes: SandboxMode[] = [...SANDBOX_MODES];

/** Every web-search mode enforceable by the pinned app-server. */
const webSearchModes: WebSearchMode[] = [...WEB_SEARCH_MODES];

/** Returns an unrestricted baseline with selected managed fields overridden. */
function requirements(
  overrides: Partial<PolicyRequirements> = {},
): PolicyRequirements {
  return { ...UNRESTRICTED_POLICY_REQUIREMENTS, ...overrides };
}

/** Asserts a rejected promise carries the expected safe policy error code. */
async function rejectsPolicy(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof PolicyError && error.code === code,
  );
}

test("x_codex validation accepts only cwd, all sandboxes, and all web modes", () => {
  assert.deepEqual(validateRequestPolicy(undefined), {});
  for (const sandbox of sandboxes)
    for (const web_search of webSearchModes)
      assert.deepEqual(
        validateRequestPolicy({ cwd: "/workspace", sandbox, web_search }),
        { cwd: "/workspace", sandbox, webSearch: web_search },
      );

  for (const invalid of [null, [], "policy", { unknown: true }])
    assert.throws(
      () => validateRequestPolicy(invalid),
      (error: unknown) =>
        error instanceof PolicyError && error.code === "invalid_x_codex",
    );
  assert.throws(
    () => validateRequestPolicy({ cwd: "" }),
    (error: unknown) =>
      error instanceof PolicyError && error.code === "invalid_cwd",
  );
  assert.throws(
    () => validateRequestPolicy({ sandbox: "permissive" }),
    (error: unknown) =>
      error instanceof PolicyError && error.code === "unsupported_sandbox",
  );
  assert.throws(
    () => validateRequestPolicy({ web_search: "fallback" }),
    (error: unknown) =>
      error instanceof PolicyError && error.code === "unsupported_web_search",
  );
});

test("the complete 3 by 4 policy matrix is mapped without fallback", async () => {
  await withTempDir(async (directory) => {
    const root = await canonicalizeRoot(directory);
    for (const sandbox of sandboxes) {
      for (const webSearch of webSearchModes) {
        const effective = await resolveEffectivePolicy(
          { sandbox, webSearch },
          root,
          UNRESTRICTED_POLICY_REQUIREMENTS,
        );
        assert.equal(effective.cwd, root);
        assert.equal(effective.sandbox, sandbox);
        assert.equal(effective.webSearch, webSearch);
        assert.equal(effective.approvalPolicy, "never");
        assert.equal(effective.approvalsReviewer, "auto_review");
        assert.deepEqual(effective.sandboxPolicy, sandboxPolicy(sandbox, root));
        assert.equal(
          (
            await resolveEffectivePolicy(
              { sandbox, webSearch },
              root,
              requirements({
                allowedSandboxModes: [sandbox],
                allowedWebSearchModes: [webSearch],
              }),
            )
          ).webSearch,
          webSearch,
        );
        await rejectsPolicy(
          resolveEffectivePolicy(
            { sandbox, webSearch },
            root,
            requirements({
              allowedSandboxModes: sandboxes.filter(
                (candidate) => candidate !== sandbox,
              ),
            }),
          ),
          "sandbox_not_allowed",
        );
        await rejectsPolicy(
          resolveEffectivePolicy(
            { sandbox, webSearch },
            root,
            requirements({
              allowedWebSearchModes: webSearchModes.filter(
                (candidate) => candidate !== webSearch,
              ),
            }),
          ),
          "web_search_not_allowed",
        );
      }
    }
  }, "proxy-policy-matrix-");
});

test("safe defaults are explicit and command network stays disabled", async () => {
  await withTempDir(async (directory) => {
    const root = await canonicalizeRoot(directory);
    const effective = await resolveEffectivePolicy(
      {},
      root,
      UNRESTRICTED_POLICY_REQUIREMENTS,
    );
    assert.deepEqual(effective, {
      cwd: root,
      sandbox: "read-only",
      webSearch: "disabled",
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    assert.deepEqual(sandboxPolicy("workspace-write", root), {
      type: "workspaceWrite",
      writableRoots: [root],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    assert.deepEqual(sandboxPolicy("danger-full-access", root), {
      type: "dangerFullAccess",
    });
  }, "proxy-policy-defaults-");
});

test("a request without cwd returns the root verbatim without re-canonicalizing", async () => {
  await withTempDir(async (directory) => {
    const real = join(directory, "real");
    const link = join(directory, "link");
    await mkdir(real);
    await symlink(real, link, "dir");
    // `link` is a non-canonical root whose realpath is the sibling `real`. The
    // previous build re-canonicalized the root on every request and rejected it
    // as cwd_outside_root; a request naming no cwd must now return the root as
    // given, doing no per-request filesystem work.
    const effective = await resolveEffectivePolicy({}, link, requirements());
    assert.equal(effective.cwd, link);
  }, "proxy-policy-rootpass-");
});

test("managed sandbox and web-search denials fail rather than approximate", async () => {
  await withTempDir(async (directory) => {
    const root = await canonicalizeRoot(directory);
    const managed = requirements({
      allowedSandboxModes: ["read-only"],
      allowedWebSearchModes: ["disabled", "indexed"],
    });
    await rejectsPolicy(
      resolveEffectivePolicy({ sandbox: "workspace-write" }, root, managed),
      "sandbox_not_allowed",
    );
    await rejectsPolicy(
      resolveEffectivePolicy({ webSearch: "live" }, root, managed),
      "web_search_not_allowed",
    );
    assert.equal(
      (await resolveEffectivePolicy({ webSearch: "indexed" }, root, managed))
        .webSearch,
      "indexed",
    );
  }, "proxy-policy-managed-");
});

test("approval selection prefers strict usable policies and auto review", async () => {
  assert.equal(selectApprovalPolicy(requirements()), "never");
  assert.equal(
    selectApprovalPolicy(
      requirements({ allowedApprovalPolicies: ["untrusted", "on-request"] }),
    ),
    "on-request",
  );
  assert.equal(
    selectApprovalPolicy(
      requirements({ allowedApprovalPolicies: ["untrusted"] }),
    ),
    "untrusted",
  );
  assert.throws(
    () => selectApprovalPolicy(requirements({ allowedApprovalPolicies: [] })),
    /no supported non-interactive approval policy/,
  );
  assert.equal(selectApprovalsReviewer(requirements()), "auto_review");
  assert.equal(
    selectApprovalsReviewer(
      requirements({ allowedApprovalsReviewers: ["guardian_subagent"] }),
    ),
    "guardian_subagent",
  );
  assert.equal(
    selectApprovalsReviewer(
      requirements({ allowedApprovalsReviewers: ["user"] }),
    ),
    "user",
  );
  assert.throws(
    () =>
      selectApprovalsReviewer(requirements({ allowedApprovalsReviewers: [] })),
    /no supported approval reviewer/,
  );

  await withTempDir(async (directory) => {
    const root = await canonicalizeRoot(directory);
    const userReviewed = await resolveEffectivePolicy(
      {},
      root,
      requirements({ allowedApprovalsReviewers: ["user"] }),
    );
    assert.equal(userReviewed.approvalsReviewer, "user");
  }, "proxy-policy-reviewer-");
});

test("root and cwd canonicalization enforce the real root boundary", async () => {
  await withTempDir(async (directory) => {
    const rootPath = join(directory, "root");
    const childPath = join(rootPath, "child");
    const siblingPath = join(directory, "sibling");
    const prefixPath = join(directory, "root-lookalike");
    const filePath = join(rootPath, "file.txt");
    const escapeLink = join(rootPath, "escape");
    await Promise.all([
      mkdir(childPath, { recursive: true }),
      mkdir(siblingPath),
      mkdir(prefixPath),
    ]);
    await writeFile(filePath, "not a directory", "utf8");
    await symlink(siblingPath, escapeLink, "dir");
    const root = await canonicalizeRoot(rootPath);
    assert.equal(root, await realpath(rootPath));
    assert.equal(
      (await resolveEffectivePolicy({ cwd: root }, root, requirements())).cwd,
      root,
    );
    assert.equal(
      (await resolveEffectivePolicy({ cwd: childPath }, root, requirements()))
        .cwd,
      await realpath(childPath),
    );
    for (const outside of [siblingPath, prefixPath, escapeLink])
      await rejectsPolicy(
        resolveEffectivePolicy({ cwd: outside }, root, requirements()),
        "cwd_outside_root",
      );
    for (const invalid of ["relative/path", join(root, "missing"), filePath])
      await rejectsPolicy(
        resolveEffectivePolicy({ cwd: invalid }, root, requirements()),
        "invalid_cwd",
      );
    await assert.rejects(canonicalizeRoot("relative/root"), /absolute/);
    await assert.rejects(canonicalizeRoot(filePath), /readable directory/);
  }, "proxy-policy-paths-");
});

test.skipIf(process.platform === "win32")(
  "platform-specific Windows paths are not mistaken for POSIX absolute paths",
  async () => {
    await withTempDir(async (directory) => {
      const root = await canonicalizeRoot(directory);
      await rejectsPolicy(
        resolveEffectivePolicy({ cwd: "C:\\workspace" }, root, requirements()),
        "invalid_cwd",
      );
    }, "proxy-policy-platform-");
  },
);

test("Windows path semantics contain same-drive and UNC descendants", () => {
  assert.equal(
    isPathWithinRoot("C:\\Workspace", "c:\\workspace\\child", win32),
    true,
  );
  assert.equal(
    isPathWithinRoot("C:\\Workspace", "C:\\Workspace-lookalike", win32),
    false,
  );
  assert.equal(
    isPathWithinRoot("C:\\Workspace", "D:\\Workspace", win32),
    false,
  );
  assert.equal(
    isPathWithinRoot(
      "\\\\server\\share\\root",
      "\\\\server\\share\\root\\child",
      win32,
    ),
    true,
  );
  assert.equal(
    isPathWithinRoot(
      "\\\\server\\share\\root",
      "\\\\other\\share\\root",
      win32,
    ),
    false,
  );
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an unreadable cwd is rejected when the platform enforces its mode bits",
  async () => {
    await withTempDir(async (directory) => {
      const denied = join(directory, "denied");
      try {
        await mkdir(denied);
        await chmod(denied, 0o000);
        await assert.rejects(access(denied, constants.R_OK | constants.X_OK));
        const root = await canonicalizeRoot(directory);
        await rejectsPolicy(
          resolveEffectivePolicy({ cwd: denied }, root, requirements()),
          "invalid_cwd",
        );
      } finally {
        // Restore access so the shared temporary-directory cleanup can recurse.
        await chmod(denied, 0o700).catch(() => undefined);
      }
    }, "proxy-policy-permission-");
  },
);

test("requirements parsing treats null as unrestricted and rejects malformed data", () => {
  assert.deepEqual(
    parsePolicyRequirements({ requirements: null }),
    UNRESTRICTED_POLICY_REQUIREMENTS,
  );
  assert.deepEqual(
    parsePolicyRequirements({
      requirements: {
        allowedApprovalPolicies: [
          {
            granular: {
              sandbox_approval: true,
              rules: false,
              mcp_elicitations: true,
            },
          },
        ],
      },
    }),
    {
      allowedApprovalPolicies: [],
      allowedApprovalsReviewers: null,
      allowedSandboxModes: null,
      allowedWebSearchModes: null,
    },
  );
  assert.deepEqual(
    parsePolicyRequirements({
      requirements: {
        allowedApprovalPolicies: [
          {
            granular: {
              sandbox_approval: true,
              rules: true,
              skill_approval: true,
              request_permissions: true,
              mcp_elicitations: true,
            },
          },
          "on-request",
        ],
        allowedApprovalsReviewers: ["auto_review"],
        allowedSandboxModes: ["read-only"],
        allowedWebSearchModes: ["disabled", "indexed"],
      },
    }),
    {
      allowedApprovalPolicies: ["on-request"],
      allowedApprovalsReviewers: ["auto_review"],
      allowedSandboxModes: ["read-only"],
      allowedWebSearchModes: ["disabled", "indexed"],
    },
  );
  for (const malformed of [
    null,
    {},
    { requirements: [] },
    {
      requirements: {
        allowedApprovalPolicies: null,
        allowedApprovalsReviewers: null,
        allowedSandboxModes: ["unknown"],
        allowedWebSearchModes: null,
      },
    },
  ])
    assert.throws(() => parsePolicyRequirements(malformed), /malformed/);
});

test("binding material is stable and includes every effective policy choice", async () => {
  await withTempDir(async (directory) => {
    const root = await canonicalizeRoot(directory);
    const baseline = await resolveEffectivePolicy({}, root, requirements());
    assert.deepEqual(policyBindingInput(baseline), {
      cwd: root,
      sandbox: "read-only",
      webSearch: "disabled",
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
    });
    assert.equal(policyBindingHash(baseline), policyBindingHash(baseline));
    const variants = [
      { ...baseline, cwd: join(root, "other") },
      { ...baseline, sandbox: "workspace-write" as const },
      { ...baseline, webSearch: "cached" as const },
      { ...baseline, approvalPolicy: "on-request" as const },
      { ...baseline, approvalsReviewer: undefined },
    ];
    for (const variant of variants)
      assert.notEqual(policyBindingHash(variant), policyBindingHash(baseline));
  }, "proxy-policy-binding-");
});
