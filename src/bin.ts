#!/usr/bin/env node
import { run } from "./cli/cli.js";

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: "error",
      event: "startup_failed",
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
}
