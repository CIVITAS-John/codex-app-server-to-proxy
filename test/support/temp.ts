import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs a callback in an isolated temporary directory and always removes it. */
export async function withTempDir<Result>(
  run: (directory: string) => Result | Promise<Result>,
  diagnosticPrefix = "codex-proxy-test-",
): Promise<Result> {
  const directory = await mkdtemp(join(tmpdir(), diagnosticPrefix));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
