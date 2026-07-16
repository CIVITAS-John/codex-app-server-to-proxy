import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/** Generated paths that must be reproducible from the pinned package. */
const checkedPaths = [
  "generated/typescript",
  "generated/json-schema",
  "VERSION.json",
];

/** Returns a stable path-to-content digest map for files below the supplied paths. */
function snapshot(root, paths) {
  const result = new Map();
  const visit = (path) => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
      return;
    }
    result.set(
      relative(root, path),
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    );
  };
  for (const path of paths) visit(join(root, path));
  return result;
}

/** Produces a concise list of added, removed, or changed generated files. */
function changedFiles(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
}

/** Reviewed protocol tree used as the comparison baseline. */
const checkedInRoot = "protocol";
/** Isolated seeded output root removed regardless of generator success. */
const temporaryRoot = mkdtempSync(join(tmpdir(), "codex-protocol-check-"));
/** Prior state the generator reads back: seeding only these keeps the copy cheap. */
const seededSchemas = [
  "generated/json-schema/codex_app_server_protocol.schemas.json",
  "generated/json-schema/codex_app_server_protocol.v2.schemas.json",
];
try {
  // Seed only what generate-protocol.mjs consumes as prior state: the combined
  // json-schema files (for stable definition ordering) and VERSION.json (for
  // generatedAt). A definition reordering or a still-valid generatedAt edit is
  // reproduced verbatim and therefore not flagged here; genuine added, removed,
  // or changed generated artifacts still are.
  mkdirSync(join(temporaryRoot, "generated", "json-schema"), {
    recursive: true,
  });
  for (const path of seededSchemas)
    cpSync(join(checkedInRoot, path), join(temporaryRoot, path));
  cpSync(
    join(checkedInRoot, "VERSION.json"),
    join(temporaryRoot, "VERSION.json"),
  );
  execFileSync(process.execPath, ["scripts/generate-protocol.mjs"], {
    stdio: "inherit",
    env: { ...process.env, CODEX_PROTOCOL_OUTPUT_ROOT: temporaryRoot },
  });
  const changes = changedFiles(
    snapshot(checkedInRoot, checkedPaths),
    snapshot(temporaryRoot, checkedPaths),
  );
  if (changes.length > 0) {
    throw new Error(
      `Pinned protocol regeneration changed checked-in artifacts:\n${changes.join("\n")}`,
    );
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
