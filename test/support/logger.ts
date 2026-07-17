import { createLogger } from "../../src/core/logger.js";

/** Shared logger that suppresses expected diagnostics in tests. */
export const silentLogger = createLogger("error", () => {});
