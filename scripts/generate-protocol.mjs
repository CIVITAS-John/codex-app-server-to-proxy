import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const projectPackage = JSON.parse(readFileSync("package.json", "utf8"));
const pinnedVersion = projectPackage.dependencies?.["@openai/codex"];
if (typeof pinnedVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pinnedVersion)) {
  throw new Error("package.json must pin @openai/codex to one exact version");
}
let priorVersionMetadata = {};
try {
  priorVersionMetadata = JSON.parse(
    readFileSync("protocol/VERSION.json", "utf8"),
  );
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const codexPackagePath = require.resolve("@openai/codex/package.json");
const codexPackage = require(codexPackagePath);
if (codexPackage.version !== pinnedVersion) {
  throw new Error(
    `Installed @openai/codex ${codexPackage.version} does not match the ${pinnedVersion} package.json pin`,
  );
}
const codexBin =
  typeof codexPackage.bin === "string"
    ? codexPackage.bin
    : codexPackage.bin?.codex;
if (typeof codexBin !== "string") {
  throw new Error("@openai/codex does not declare a codex binary");
}
const codexPath = resolve(dirname(codexPackagePath), codexBin);
const generatedAt =
  priorVersionMetadata.codexVersion === pinnedVersion &&
  /^\d{4}-\d{2}-\d{2}$/.test(priorVersionMetadata.generatedAt)
    ? priorVersionMetadata.generatedAt
    : new Date().toISOString().slice(0, 10);
const combinedSchemaPaths = [
  "protocol/generated/json-schema/codex_app_server_protocol.schemas.json",
  "protocol/generated/json-schema/codex_app_server_protocol.v2.schemas.json",
];
const priorDefinitionOrders = new Map(
  combinedSchemaPaths.map((path) => {
    try {
      const schema = JSON.parse(readFileSync(path, "utf8"));
      return [path, Object.keys(schema.definitions ?? {})];
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return [path, []];
    }
  }),
);

for (const [kind, output] of [
  ["generate-ts", "protocol/generated/typescript"],
  ["generate-json-schema", "protocol/generated/json-schema"],
]) {
  // Recreate each tree so removed upstream types cannot survive regeneration.
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  execFileSync(
    process.execPath,
    [codexPath, "app-server", kind, "--experimental", "--out", output],
    { stdio: "inherit" },
  );
}

for (const path of combinedSchemaPaths) {
  const schema = JSON.parse(readFileSync(path, "utf8"));
  const definitions = schema.definitions ?? {};
  const priorOrder = priorDefinitionOrders.get(path) ?? [];
  const retained = priorOrder.filter((name) => name in definitions);
  const additions = Object.keys(definitions)
    .filter((name) => !priorOrder.includes(name))
    .sort();
  // Preserve reviewed definition order and sort only newly introduced names;
  // upstream emits this map in a nondeterministic order between identical runs.
  schema.definitions = Object.fromEntries(
    [...retained, ...additions].map((name) => [name, definitions[name]]),
  );
  writeFileSync(path, `${JSON.stringify(schema, null, 2)}\n`);
}

writeFileSync(
  "protocol/VERSION.json",
  `${JSON.stringify(
    {
      codexPackage: "@openai/codex",
      codexVersion: pinnedVersion,
      versionSource: "package.json dependencies.@openai/codex",
      generatedAt,
      experimental: true,
      typescriptCommand:
        "@openai/codex app-server generate-ts --experimental --out protocol/generated/typescript",
      jsonSchemaCommand:
        "@openai/codex app-server generate-json-schema --experimental --out protocol/generated/json-schema",
      executableSource:
        "The exact @openai/codex runtime dependency owns the executable used for generation and default startup; --codex-path overrides must report the same version.",
    },
    null,
    2,
  )}\n`,
);
