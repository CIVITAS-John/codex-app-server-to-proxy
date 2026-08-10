import assert from "node:assert/strict";
import { test } from "vitest";
import {
  serverOverloadedError,
  toolCorrelationErrorForStatus,
} from "../../src/http/errors.js";

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

test("only the overloaded turn error maps to a retryable 503", () => {
  const overloaded = serverOverloadedError(
    { codexErrorInfo: "serverOverloaded" },
    "Selected model is at capacity. Please try a different model.",
  );

  assert.equal(overloaded?.status, 503);
  assert.equal(overloaded?.type, "server_error");
  assert.equal(overloaded?.code, "server_overloaded");
  assert.equal(
    overloaded?.message,
    "Selected model is at capacity. Please try a different model.",
  );

  for (const codexErrorInfo of [
    "usageLimitExceeded",
    "internalServerError",
    null,
    undefined,
  ])
    assert.equal(
      serverOverloadedError({ codexErrorInfo }, "other failure"),
      undefined,
    );
  assert.equal(serverOverloadedError(undefined, "no error"), undefined);
});
