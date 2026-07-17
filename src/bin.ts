#!/usr/bin/env node
import { run } from "./cli/cli.js";
import { writeStartupError } from "./core/logger.js";

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  writeStartupError(error);
  process.exitCode = 1;
}
