import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
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
try {
  // Seed stable definition ordering and version metadata without touching the tree.
  cpSync(join(checkedInRoot, "generated"), join(temporaryRoot, "generated"), {
    recursive: true,
  });
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
