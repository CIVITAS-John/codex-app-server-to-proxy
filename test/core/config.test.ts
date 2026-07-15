import assert from "node:assert/strict";
import { test } from "vitest";
import {
  normalizeLoopbackHost,
  parseServeOptions,
} from "../../src/core/config.js";

test("loopback validation accepts only exact safe forms", () => {
  assert.equal(normalizeLoopbackHost("127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeLoopbackHost("::1"), "::1");
  assert.equal(normalizeLoopbackHost("LOCALHOST"), "127.0.0.1");
  for (const host of [
    "0.0.0.0",
    "::",
    "192.168.1.2",
    "example.test",
    "127.0.0.2",
    "::ffff:127.0.0.1",
    "[::1]",
    "localhost.",
  ]) {
    assert.throws(
      () => normalizeLoopbackHost(host),
      /Only 127\.0\.0\.1, ::1, and localhost/,
    );
  }
});

test("serve options have safe documented defaults and reject ambiguity", () => {
  const parsed = parseServeOptions([], "/tmp/project");
  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(parsed.port, 8787);
  assert.equal(parsed.root, "/tmp/project");
  assert.equal(parsed.toolTimeoutMs, 300_000);
  assert.equal(parsed.implicitToolContinuation, true);
  assert.equal(parsed.stateDir, "/tmp/project/.codex-openai-proxy");
  assert.throws(
    () => parseServeOptions(["--port", "80", "--port", "81"]),
    /Duplicate/,
  );
  assert.throws(() => parseServeOptions(["--unknown", "x"]), /Unknown/);
  assert.equal(
    parseServeOptions(["--implicit-tool-continuation", "false"])
      .implicitToolContinuation,
    false,
  );
  assert.throws(
    () => parseServeOptions(["--implicit-tool-continuation", "yes"]),
    /true or false/,
  );
});
