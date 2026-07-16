import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { redact } from "../../src/core/redact.js";
import { createLogger } from "../../src/core/logger.js";

test("redact masks the configured root before home so a nested root cannot leak", () => {
  const root = join(homedir(), "projects", "secret-client");
  const out = redact(`${root}/db.sqlite reached https://api.example.com`, root);
  assert.equal(out.includes("secret-client"), false);
  assert.match(out, /\[REDACTED_CWD\]\/db\.sqlite/);
  assert.match(out, /\[REDACTED_URL\]/);
});

test("redact skips trivially broad roots to avoid over-redaction", () => {
  const home = homedir();
  assert.equal(redact("/etc/hosts", "/").includes("[REDACTED_CWD]"), false);
  assert.equal(redact(`${home}/x`, home), "[REDACTED_HOME]/x");
});

test("redact masks configured paths outside the root and home", () => {
  const external = join("/tmp", "secret-client", "proxy-state");
  assert.equal(
    redact(`write failed at ${external}/continuations.json`, "/workspace", [
      external,
    ]),
    "write failed at [REDACTED_PATH]/continuations.json",
  );
});

test("logger failures keep a redacted summary and full debug detail", () => {
  const root = join(homedir(), "workspace");
  const info: Record<string, unknown>[] = [];
  const infoLog = createLogger("info", (entry) => info.push(entry), {
    root,
    sensitivePaths: [],
  });
  infoLog.failure(
    "widget_failed",
    { attempt: 1 },
    new Error(`boom at ${root}/file`),
  );
  // At the default info level only the error entry survives, and its message is
  // redacted so the configured root never appears.
  assert.equal(info.length, 1);
  assert.equal(info[0]!.event, "widget_failed");
  assert.equal(info[0]!.level, "error");
  assert.equal(info[0]!.attempt, 1);
  assert.equal(String(info[0]!.error).includes(root), false);
  assert.match(String(info[0]!.error), /\[REDACTED/);

  const external = join("/tmp", "secret-client", "proxy-state");
  const outside: Record<string, unknown>[] = [];
  const outsideLog = createLogger("info", (entry) => outside.push(entry), {
    root,
    sensitivePaths: [external],
  });
  outsideLog.failure(
    "widget_failed",
    {},
    new Error(`rename failed at ${external}/continuations.json`),
  );
  assert.equal(String(outside[0]!.error).includes(external), false);
  assert.match(String(outside[0]!.error), /\[REDACTED_PATH\]/);

  const debug: Record<string, unknown>[] = [];
  const debugLog = createLogger("debug", (entry) => debug.push(entry), {
    root,
    sensitivePaths: [],
  });
  debugLog.failure("widget_failed", {}, new Error(`boom at ${root}/file`));
  const detail = debug.find((entry) => entry.event === "widget_failed_detail");
  assert.ok(detail);
  assert.equal(String(detail!.error).includes(`${root}/file`), true);
});
