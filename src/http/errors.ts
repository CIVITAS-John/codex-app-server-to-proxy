import type { ServerResponse } from "node:http";

/** OpenAI-compatible error categories emitted by the proxy. */
export type ErrorType =
  | "invalid_request_error"
  | "conflict_error"
  | "not_found_error"
  | "rate_limit_error"
  | "server_error";

/** Narrow nonstandard metadata that can be attached to an OpenAI error. */
export interface ErrorExtensions {
  xCodex?: { resetAt: number };
  responseHeaders?: { retryAfter: string };
}

/** Carries an HTTP status and OpenAI-shaped error metadata. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type: ErrorType,
    readonly code: string,
    readonly param: string | null = null,
    readonly extensions: ErrorExtensions = {},
  ) {
    super(message);
  }
}

/** Builds the OpenAI-compatible error envelope shared by JSON and SSE output. */
export function errorEnvelope(
  message: string,
  type: ErrorType,
  code: string,
  param: string | null,
  extensions: ErrorExtensions = {},
): Record<string, unknown> {
  return {
    error: {
      message,
      type,
      param,
      code,
      ...(extensions.xCodex
        ? { x_codex: { reset_at: extensions.xCodex.resetAt } }
        : {}),
    },
  };
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
  responseHeaders: ErrorExtensions["responseHeaders"] | undefined = undefined,
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
    // Only this closed, internally-created header shape is accepted. Error
    // payloads must never become a path for app-server data to set HTTP headers.
    ...(responseHeaders ? { "retry-after": responseHeaders.retryAfter } : {}),
  });
  response.end(body);
}

/** Serializes an HttpError in the OpenAI error envelope. */
export function writeError(response: ServerResponse, error: HttpError): void {
  const responseHeaders = safeErrorHeaders(error.extensions.responseHeaders);
  writeJson(
    response,
    error.status,
    errorEnvelope(
      error.message,
      error.type,
      error.code,
      error.param,
      error.extensions,
    ),
    responseHeaders,
  );
}

/** Retains only the decimal Retry-After value created by quota translation. */
function safeErrorHeaders(
  headers: ErrorExtensions["responseHeaders"] | undefined,
): ErrorExtensions["responseHeaders"] | undefined {
  return headers && /^\d+$/.test(headers.retryAfter) ? headers : undefined;
}
