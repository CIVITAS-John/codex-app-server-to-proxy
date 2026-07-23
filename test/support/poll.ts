import { readFile } from "node:fs/promises";

/** Waits until captured CLI diagnostics contain the expected text. */
export async function waitForText(
  read: () => string,
  expected: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!read().includes(expected)) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${expected}: ${read()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Waits until a fake child writes its startup marker file. */
export async function waitForFile(
  path: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for startup marker ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** Waits until a captured text file contains the expected text. */
export async function waitForFileText(
  path: string,
  expected: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let contents = "";
    try {
      contents = await readFile(path, "utf8");
    } catch {
      // The producer may not have created the capture file yet.
    }
    if (contents.includes(expected)) return;
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${expected} in ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
