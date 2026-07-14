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

/** Writes a non-cacheable JSON response unless it has already ended. */
export function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  if (response.writableEnded) return;
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
