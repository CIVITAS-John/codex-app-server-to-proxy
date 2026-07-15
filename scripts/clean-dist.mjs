import { rm } from "node:fs/promises";

// Remove all prior compiler output so renamed modules cannot leak into packages.
await rm(new URL("../dist/", import.meta.url), { force: true, recursive: true });
