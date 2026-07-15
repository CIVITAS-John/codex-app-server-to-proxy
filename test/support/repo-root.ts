import { fileURLToPath } from "node:url";

/** Absolute URL for the repository root, independent of the importing test's depth. */
export const repoRootUrl = new URL("../../", import.meta.url);

/** Absolute filesystem path for the repository root. */
export const repoRootPath = fileURLToPath(repoRootUrl);
