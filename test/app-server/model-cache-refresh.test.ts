import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { PINNED_CODEX_VERSION } from "../../src/app-server/app-server.js";
import { refreshModelCache } from "../../src/app-server/model-cache-refresh.js";
import { silentLogger } from "../support/logger.js";
import { withTempDir } from "../support/temp.js";

/** Synthetic cache with the metadata required by the pinned runtime. */
function cache(version: string, slug: string): string {
  return JSON.stringify({
    client_version: version,
    fetched_at: "fixture",
    models: [{ slug, use_responses_lite: true }],
  });
}

/** Refresh options whose injected fetch never starts a real app-server. */
function options(
  codexHome: string,
  fetchCatalog: (scratchHome: string) => Promise<void>,
) {
  return {
    codexHome,
    codexPath: "codex",
    root: codexHome,
    shutdownTimeoutMs: 1_000,
    log: silentLogger,
    fetchCatalog,
  };
}

test("startup refresh atomically replaces an old cache with current metadata", async () => {
  await withTempDir(async (directory) => {
    const home = join(directory, "home");
    await mkdir(home);
    const path = join(home, "models_cache.json");
    await writeFile(path, cache("0.154.0", "old-model"));
    await refreshModelCache(
      options(home, async (scratchHome) => {
        await writeFile(
          join(scratchHome, "models_cache.json"),
          cache(PINNED_CODEX_VERSION, "new-model"),
        );
      }),
    );
    const refreshed = JSON.parse(await readFile(path, "utf8")) as {
      client_version: string;
      models: Array<{ slug: string }>;
    };
    assert.equal(refreshed.client_version, PINNED_CODEX_VERSION);
    assert.equal(refreshed.models[0]?.slug, "new-model");
  }, "model-cache-refresh-success-");
});

test("failed or invalid refresh keeps the previous cache", async () => {
  await withTempDir(async (directory) => {
    const home = join(directory, "home");
    await mkdir(home);
    const path = join(home, "models_cache.json");
    const previous = cache("0.154.0", "old-model");
    await writeFile(path, previous);
    for (const fetchCatalog of [
      async () => undefined,
      async (scratchHome: string) => {
        await writeFile(
          join(scratchHome, "models_cache.json"),
          cache("0.154.0", "wrong-version"),
        );
      },
      async (scratchHome: string) => {
        await writeFile(
          join(scratchHome, "models_cache.json"),
          JSON.stringify({
            client_version: PINNED_CODEX_VERSION,
            models: [null],
          }),
        );
      },
      async () => {
        throw new Error("synthetic endpoint failure");
      },
    ]) {
      await assert.rejects(refreshModelCache(options(home, fetchCatalog)));
      assert.equal(await readFile(path, "utf8"), previous);
    }
  }, "model-cache-refresh-failure-");
});

test("refresh retains rotated credentials without overwriting a concurrent login", async () => {
  await withTempDir(async (directory) => {
    const home = join(directory, "home");
    await mkdir(home);
    const authPath = join(home, "auth.json");
    await writeFile(authPath, "original-auth");
    await refreshModelCache(
      options(home, async (scratchHome) => {
        await writeFile(join(scratchHome, "auth.json"), "rotated-auth");
        await writeFile(
          join(scratchHome, "models_cache.json"),
          cache(PINNED_CODEX_VERSION, "model"),
        );
      }),
    );
    assert.equal(await readFile(authPath, "utf8"), "rotated-auth");
    await assert.rejects(
      refreshModelCache(
        options(home, async (scratchHome) => {
          await writeFile(authPath, "concurrent-auth");
          await writeFile(join(scratchHome, "auth.json"), "stale-rotation");
          await writeFile(
            join(scratchHome, "models_cache.json"),
            cache(PINNED_CODEX_VERSION, "model"),
          );
        }),
      ),
      /Authentication changed/,
    );
    assert.equal(await readFile(authPath, "utf8"), "concurrent-auth");
  }, "model-cache-refresh-auth-");
});
