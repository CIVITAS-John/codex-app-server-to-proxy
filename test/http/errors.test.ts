import assert from "node:assert/strict";
import { test } from "vitest";
import { toolCorrelationErrorForStatus } from "../../src/http/errors.js";

test("HTTP statuses map to stable OpenAI error types", () => {
  for (const [status, type] of [
    [400, "invalid_request_error"],
    [404, "invalid_request_error"],
    [409, "conflict_error"],
    [410, "invalid_request_error"],
    [500, "server_error"],
  ] as const) {
    const error = toolCorrelationErrorForStatus(
      status,
      "Correlation failed.",
      "tool_lookup_failed",
      "tool_call_id",
    );

    assert.equal(error.status, status);
    assert.equal(error.message, "Correlation failed.");
    assert.equal(error.type, type);
    assert.equal(error.code, "tool_lookup_failed");
    assert.equal(error.param, "tool_call_id");
  }
});
