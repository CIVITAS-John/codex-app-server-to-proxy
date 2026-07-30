import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import {
  installResponsesLiteOverride,
  RESPONSES_LITE_OVERRIDE_CATALOG_FILENAME,
} from "../../src/app-server/responses-lite-override.js";
import { silentLogger } from "../support/logger.js";
import { withTempDir } from "../support/temp.js";

test("Responses Lite override clones every model and preserves other config", async () => {
  await withTempDir(async (directory) => {
    const cachePath = join(directory, "models_cache.json");
    const overridePath = join(
      directory,
      RESPONSES_LITE_OVERRIDE_CATALOG_FILENAME,
    );
    const configPath = join(directory, "config.toml");
    const source = `${JSON.stringify(
      {
        fetched_at: "fixture",
        models: [
          { slug: "gpt-5.6-sol", use_responses_lite: true, priority: 1 },
          { slug: "gpt-5.4", priority: 2 },
        ],
      },
      null,
      2,
    )}\n`;
    await writeFile(cachePath, source, "utf8");
    await writeFile(
      configPath,
      [
        'model_catalog_json = "C:\\\\old-catalog.json"',
        'model = "gpt-5.6-luna"',
        "",
        '[projects."C:\\\\workspace"]',
        'trust_level = "trusted"',
        "",
      ].join("\n"),
      "utf8",
    );

    const first = await installResponsesLiteOverride(directory, silentLogger);
    assert.deepEqual(first, {
      status: "applied",
      changed: true,
      modelCount: 2,
    });
    assert.equal(await readFile(cachePath, "utf8"), source);

    const override = JSON.parse(await readFile(overridePath, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(override.fetched_at, "fixture");
    assert.deepEqual(
      (override.models as Array<Record<string, unknown>>).map((model) => ({
        slug: model.slug,
        use_responses_lite: model.use_responses_lite,
      })),
      [
        { slug: "gpt-5.6-sol", use_responses_lite: false },
        { slug: "gpt-5.4", use_responses_lite: false },
      ],
    );

    const config = await readFile(configPath, "utf8");
    assert.equal(
      config.match(/^[\t ]*model_catalog_json[\t ]*=/gmu)?.length,
      1,
    );
    assert.ok(
      config.includes(`model_catalog_json = ${JSON.stringify(overridePath)}`),
    );
    assert.equal(config.includes("old-catalog"), false);
    assert.ok(config.includes('model = "gpt-5.6-luna"'));
    assert.ok(config.includes('[projects."C:\\\\workspace"]'));
    assert.ok(config.includes('trust_level = "trusted"'));

    const second = await installResponsesLiteOverride(directory, silentLogger);
    assert.deepEqual(second, {
      status: "applied",
      changed: false,
      modelCount: 2,
    });
    if (process.platform !== "win32") {
      assert.equal((await stat(overridePath)).mode & 0o777, 0o600);
      assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    }
  }, "responses-lite-override-test-");
});

test("Responses Lite override waits without creating config when cache is absent", async () => {
  await withTempDir(async (directory) => {
    assert.deepEqual(
      await installResponsesLiteOverride(directory, silentLogger),
      { status: "missing-cache" },
    );
    await assert.rejects(
      readFile(join(directory, "config.toml"), "utf8"),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  }, "responses-lite-missing-cache-test-");
});

test("Responses Lite override rejects malformed or empty model catalogs", async () => {
  await withTempDir(async (directory) => {
    const cachePath = join(directory, "models_cache.json");
    for (const [source, expected] of [
      ["{", /not valid JSON/u],
      [JSON.stringify({}), /no models array/u],
      [JSON.stringify({ models: [] }), /contains no models/u],
      [JSON.stringify({ models: [null] }), /model 0 is not an object/u],
    ] as const) {
      await writeFile(cachePath, source, "utf8");
      await assert.rejects(
        installResponsesLiteOverride(directory, silentLogger),
        expected,
      );
    }
  }, "responses-lite-invalid-cache-test-");
});
