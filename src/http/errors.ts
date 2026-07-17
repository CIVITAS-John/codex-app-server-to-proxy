import type { ServerResponse } from "node:http";

/** OpenAI-compatible error categories emitted by the proxy. */
export type ErrorType =
  | "invalid_request_error"
  | "conflict_error"
  | "not_found_error"
  | "rate_limit_error"
  | "server_error";

/** Carries an HTTP status and OpenAI-shaped error metadata. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type: ErrorType,
    readonly code: string,
    readonly param: string | null = null,
  ) {
    super(message);
  }
}

/** Builds a tool-correlation error using its narrow status-to-type policy. */
export function toolCorrelationErrorForStatus(
  status: number,
  message: string,
  code: string,
  param: string | null,
): HttpError {
  const type: ErrorType =
    status >= 500
      ? "server_error"
      : status === 409
        ? "conflict_error"
        : "invalid_request_error";
  return new HttpError(status, message, type, code, param);
}

/** Writes a non-cacheable JSON response unless it has already ended. */
export function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  if (response.writableEnded) return;
  // A streaming route may fail after its status and content type are committed.
  if (response.headersSent) {
    response.end();
    return;
  }
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

/** Serializes an HttpError in the OpenAI error envelope. */
export function writeError(response: ServerResponse, error: HttpError): void {
  writeJson(response, error.status, {
    error: {
      message: error.message,
      type: error.type,
      param: error.param,
      code: error.code,
    },
  });
}
