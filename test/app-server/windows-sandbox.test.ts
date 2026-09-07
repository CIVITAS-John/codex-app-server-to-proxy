import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveWindowsSandboxThreadConfig } from "../../src/app-server/windows-sandbox.js";
import { UNRESTRICTED_POLICY_REQUIREMENTS } from "../../src/core/policy.js";

/** Creates a request recorder returning one effective config/read response. */
function configReader(config: Record<string, unknown>): {
  calls: Array<{ method: string; params: unknown }>;
  request(method: string, params: unknown): Promise<unknown>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      return { config, origins: {}, layers: null };
    },
  };
}

test("Windows defaults an unconfigured effective backend to unelevated", async () => {
  const reader = configReader({ windows: null, features: {} });
  assert.deepEqual(
    await resolveWindowsSandboxThreadConfig(
      reader,
      "C:\\workspace",
      UNRESTRICTED_POLICY_REQUIREMENTS,
      "win32",
    ),
    { "windows.sandbox": "unelevated" },
  );
  assert.deepEqual(reader.calls, [
    {
      method: "config/read",
      params: { cwd: "C:\\workspace", includeLayers: false },
    },
  ]);
});

test("Windows preserves effective current and legacy sandbox selections", async () => {
  for (const config of [
    { windows: { sandbox: "elevated" } },
    { windows: { sandbox: "unelevated" } },
    { features: { experimental_windows_sandbox: true } },
    { features: { elevated_windows_sandbox: true } },
    { features: { enable_experimental_windows_sandbox: true } },
  ]) {
    const reader = configReader(config);
    assert.deepEqual(
      await resolveWindowsSandboxThreadConfig(
        reader,
        "C:\\workspace",
        UNRESTRICTED_POLICY_REQUIREMENTS,
        "win32",
      ),
      {},
    );
  }
});

test("managed Windows implementation restrictions remain authoritative", async () => {
  const reader = configReader({});
  assert.deepEqual(
    await resolveWindowsSandboxThreadConfig(
      reader,
      "C:\\workspace",
      {
        ...UNRESTRICTED_POLICY_REQUIREMENTS,
        allowedWindowsSandboxImplementations: ["elevated"],
      },
      "win32",
    ),
    {},
  );
  assert.equal(reader.calls.length, 0);
});

test("managed policy that permits unelevated still receives the safe default", async () => {
  for (const allowedWindowsSandboxImplementations of [
    ["unelevated"],
    ["elevated", "unelevated"],
  ] as const) {
    const reader = configReader({});
    assert.deepEqual(
      await resolveWindowsSandboxThreadConfig(
        reader,
        "C:\\workspace",
        {
          ...UNRESTRICTED_POLICY_REQUIREMENTS,
          allowedWindowsSandboxImplementations: [
            ...allowedWindowsSandboxImplementations,
          ],
        },
        "win32",
      ),
      { "windows.sandbox": "unelevated" },
    );
  }
});

test("non-Windows hosts neither inspect nor override Windows config", async () => {
  const reader = configReader({});
  assert.deepEqual(
    await resolveWindowsSandboxThreadConfig(
      reader,
      "/workspace",
      UNRESTRICTED_POLICY_REQUIREMENTS,
      "linux",
    ),
    {},
  );
  assert.equal(reader.calls.length, 0);
});

test("malformed effective Windows config fails closed", async () => {
  const reader = configReader({ windows: "unelevated" });
  await assert.rejects(
    resolveWindowsSandboxThreadConfig(
      reader,
      "C:\\workspace",
      UNRESTRICTED_POLICY_REQUIREMENTS,
      "win32",
    ),
    /malformed windows configuration/,
  );
});

test("unknown and unavailable effective config fail closed", async () => {
  const unsupported = configReader({ windows: { sandbox: "future" } });
  await assert.rejects(
    resolveWindowsSandboxThreadConfig(
      unsupported,
      "C:\\workspace",
      UNRESTRICTED_POLICY_REQUIREMENTS,
      "win32",
    ),
    /unsupported Windows sandbox implementation/,
  );

  const malformed = {
    request: async (): Promise<unknown> => ({ config: null }),
  };
  await assert.rejects(
    resolveWindowsSandboxThreadConfig(
      malformed,
      "C:\\workspace",
      UNRESTRICTED_POLICY_REQUIREMENTS,
      "win32",
    ),
    /config\/read returned a malformed response/,
  );

  const unavailable = {
    request: async (): Promise<unknown> => {
      throw new Error("config/read unavailable");
    },
  };
  await assert.rejects(
    resolveWindowsSandboxThreadConfig(
      unavailable,
      "C:\\workspace",
      UNRESTRICTED_POLICY_REQUIREMENTS,
      "win32",
    ),
    /config\/read unavailable/,
  );
});
