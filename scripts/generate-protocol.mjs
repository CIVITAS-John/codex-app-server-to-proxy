import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

for (const [kind, output] of [
  ["generate-ts", "protocol/generated/typescript"],
  ["generate-json-schema", "protocol/generated/json-schema"],
]) {
  mkdirSync(output, { recursive: true });
  execFileSync("codex", ["app-server", kind, "--experimental", "--out", output], {
    stdio: "inherit",
  });
}
