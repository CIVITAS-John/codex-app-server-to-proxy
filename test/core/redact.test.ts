import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { redact } from "../../src/core/redact.js";
import { createLogger, logFailure } from "../../src/core/logger.js";

test("redact masks the configured root before home so a nested root cannot leak", () => {
  const root = join(homedir(), "projects", "secret-client");
  const out = redact(
    `${root}/db.sqlite reached https://api.example.com`,
    root,
  );
  assert.equal(out.includes("secret-client"), false);
  assert.match(out, /\[REDACTED_CWD\]\/db\.sqlite/);
  assert.match(out, /\[REDACTED_URL\]/);
});

test("redact skips trivially broad roots to avoid over-redaction", () => {
  const home = homedir();
  assert.equal(redact("/etc/hosts", "/").includes("[REDACTED_CWD]"), false);
  assert.equal(redact(`${home}/x`, home), "[REDACTED_HOME]/x");
});

test("logFailure keeps a redacted summary at error and full detail at debug", () => {
  const root = join(homedir(), "workspace");
  const info: Record<string, unknown>[] = [];
  logFailure(
    createLogger("info", (entry) => info.push(entry)),
    "widget_failed",
    { attempt: 1 },
    new Error(`boom at ${root}/file`),
    root,
  );
  // At the default info level only the error entry survives, and its message is
  // redacted so the configured root never appears.
  assert.equal(info.length, 1);
  assert.equal(info[0]!.event, "widget_failed");
  assert.equal(info[0]!.level, "error");
  assert.equal(info[0]!.attempt, 1);
  assert.equal(String(info[0]!.error).includes(root), false);
  assert.match(String(info[0]!.error), /\[REDACTED/);

  const debug: Record<string, unknown>[] = [];
  logFailure(
    createLogger("debug", (entry) => debug.push(entry)),
    "widget_failed",
    {},
    new Error(`boom at ${root}/file`),
    root,
  );
  const detail = debug.find((entry) => entry.event === "widget_failed_detail");
  assert.ok(detail);
  assert.equal(String(detail!.error).includes(`${root}/file`), true);
});
