import { readFile } from "node:fs/promises";

/** Polls a condition until it holds or the deadline elapses. */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  describe: () => string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Reads a file, treating an absent or unreadable path as empty. */
async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    // The producer may not have created the file yet.
    return "";
  }
}

/** Waits until captured CLI diagnostics contain the expected text. */
export async function waitForText(
  read: () => string,
  expected: string,
  timeoutMs = 10_000,
): Promise<void> {
  await waitFor(
    () => read().includes(expected),
    () => `${expected}: ${read()}`,
    timeoutMs,
  );
}

/** Waits until a fake child writes its startup marker file. */
export async function waitForFile(
  path: string,
  timeoutMs = 10_000,
): Promise<void> {
  await waitFor(
    async () => {
      try {
        await readFile(path, "utf8");
        return true;
      } catch {
        return false;
      }
    },
    () => `startup marker ${path}`,
    timeoutMs,
  );
}

/** Waits until a captured text file contains the expected text. */
export async function waitForFileText(
  path: string,
  expected: string,
  timeoutMs = 10_000,
): Promise<void> {
  await waitFor(
    async () => (await readOptional(path)).includes(expected),
    () => `${expected} in ${path}`,
    timeoutMs,
  );
}
