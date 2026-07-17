import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { HttpError, writeError, writeJson } from "./errors.js";
import type { ServeOptions } from "../core/config.js";
import type { Logger } from "../core/logger.js";
import type { JsonRpcTransport } from "../app-server/json-rpc.js";
import {
  UNRESTRICTED_POLICY_REQUIREMENTS,
  type PolicyRequirements,
} from "../core/policy.js";
import { handleChatCompletion } from "./chat.js";
import {
  ContinuationCoordinator,
  ResponseStore,
} from "../continuation/state.js";

/** Controls the proxy HTTP listener and readiness state. */
export interface ProxyServer {
  server: Server;
  listen(): Promise<{ address: string; port: number }>;
  close(): Promise<void>;
  setReady(ready: boolean): void;
  // Requirements are mandatory whenever a live transport is installed so managed
  // enforcement can never be silently disabled by an omitted argument; clearing
  // the transport takes no requirements.
  setTransport(
    transport: JsonRpcTransport,
    requirements: PolicyRequirements,
  ): void;
  setTransport(transport: undefined): void;
}

/** Creates a loopback proxy with bounded concurrency and request lifetimes. */
export function createProxyServer(
  options: ServeOptions,
  log: Logger,
): ProxyServer {
  let ready = false;
  let transport: JsonRpcTransport | undefined;
  let requirements = UNRESTRICTED_POLICY_REQUIREMENTS;
  let continuations: ContinuationCoordinator | undefined;
  const continuationStore = new ResponseStore(options.stateDir);
  let active = 0;
  const controllers = new Set<AbortController>();
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const started = Date.now();
    const requestId = randomUUID();
    response.setHeader("x-request-id", requestId);
    // Parse the request target once; routing and every log line reuse it.
    let url: URL | undefined;
    try {
      url = new URL(request.url ?? "/", "http://loopback.invalid");
    } catch {
      url = undefined;
    }
    const logRequest = (status: number): void => {
      log("info", "http_request", {
        request_id: requestId,
        method: request.method,
        path: url?.pathname ?? "[invalid-path]",
        status,
        duration_ms: Date.now() - started,
      });
    };
    const authorityError = validateRequestAuthority(request);
    if (authorityError) {
      writeError(response, authorityError);
      logRequest(authorityError.status);
      return;
    }
    // Reject before allocating per-request resources when capacity is full.
    if (active >= options.maxRequests) {
      const overloaded = new HttpError(
        429,
        "The proxy is handling too many requests.",
        "rate_limit_error",
        "overloaded",
      );
      writeError(response, overloaded);
      logRequest(overloaded.status);
      return;
    }
    active += 1;
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(
      () => controller.abort(new Error("request timeout")),
      options.requestTimeoutMs,
    );
    timer.unref();
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      request.off("aborted", abortRequest);
      clearTimeout(timer);
      controllers.delete(controller);
      active -= 1;
      logRequest(response.statusCode);
    };
    const abortRequest = (): void => {
      controller.abort(new Error("client disconnected"));
      finish();
    };
    request.once("aborted", abortRequest);
    response.once("finish", finish);
    response.once("close", () => {
      if (!response.writableFinished) abortRequest();
    });
    void route(
      request,
      response,
      ready,
      options.bodyLimitBytes,
      controller.signal,
      transport,
      continuations,
      options.root,
      requirements,
      options.implicitToolContinuation,
      log,
      requestId,
      url,
    ).catch((cause: unknown) => {
      const error =
        cause instanceof HttpError
          ? cause
          : controller.signal.aborted
            ? new HttpError(
                408,
                "The request timed out.",
                "invalid_request_error",
                "request_timeout",
              )
            : new HttpError(
                500,
                "An internal error occurred.",
                "server_error",
                "internal_error",
              );
      if (!(cause instanceof HttpError))
        log.failure("request_failed", { request_id: requestId }, cause);
      writeError(response, error);
    });
  });
  server.requestTimeout = options.requestTimeoutMs;
  server.headersTimeout = Math.min(options.requestTimeoutMs, 60_000);
  server.keepAliveTimeout = 5_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  return {
    server,
    setReady(value) {
      ready = value;
    },
    setTransport(
      value: JsonRpcTransport | undefined,
      nextRequirements?: PolicyRequirements,
    ) {
      // Update requirements before the same-transport short-circuit so a refresh
      // of managed policy against an unchanged transport still takes effect.
      requirements = nextRequirements ?? UNRESTRICTED_POLICY_REQUIREMENTS;
      if (transport === value) return;
      continuations?.dispose();
      if (transport && transport !== value)
        transport.close(new Error("app-server transport replaced"));
      transport = value;
      continuations = value
        ? new ContinuationCoordinator(
            continuationStore,
            value,
            options.toolTimeoutMs,
          )
        : undefined;
    },
    listen: () =>
      new Promise((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once("error", onError);
        server.listen(
          { host: options.host, port: options.port, exclusive: true },
          () => {
            server.off("error", onError);
            const address = server.address();
            if (address === null || typeof address === "string")
              return reject(
                new Error("Listener did not return a TCP address."),
              );
            resolve({ address: address.address, port: address.port });
          },
        );
      }),
    close: () =>
      new Promise((resolve, reject) => {
        continuations?.dispose();
        transport?.close(new Error("proxy shutting down"));
        continuations = undefined;
        transport = undefined;
        controllers.forEach((controller) =>
          controller.abort(new Error("server shutting down")),
        );
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
        const force = setTimeout(() => {
          sockets.forEach((socket) => socket.destroy());
          server.closeAllConnections();
        }, options.shutdownTimeoutMs);
        force.unref();
      }),
  };
}

/** Routes the intentionally small public HTTP surface. */
async function route(
  request: IncomingMessage,
  response: ServerResponse,
  ready: boolean,
  bodyLimit: number,
  signal: AbortSignal,
  transport: JsonRpcTransport | undefined,
  continuations: ContinuationCoordinator | undefined,
  root: string,
  requirements: PolicyRequirements,
  implicitToolContinuation: boolean,
  log: Logger,
  requestId: string,
  url: URL | undefined,
): Promise<void> {
  if (request.method === "GET" && url?.pathname === "/health") {
    writeJson(response, 200, { status: "ok" });
    return;
  }
  if (request.method === "GET" && url?.pathname === "/ready") {
    writeJson(response, ready ? 200 : 503, {
      status: ready ? "ready" : "not_ready",
    });
    return;
  }
  if (request.method === "POST" && url?.pathname === "/v1/chat/completions") {
    const contentType = request.headers["content-type"]
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json")
      throw new HttpError(
        415,
        "Content-Type must be application/json.",
        "invalid_request_error",
        "unsupported_media_type",
      );
    const body = await readJsonBody(request, bodyLimit, signal);
    if (!ready)
      throw new HttpError(
        503,
        "The app-server is not ready.",
        "server_error",
        "app_server_not_ready",
      );
    if (!transport || !continuations)
      throw new HttpError(
        503,
        "The app-server transport is unavailable.",
        "server_error",
        "app_server_not_ready",
      );
    await handleChatCompletion(body, response, {
      rpc: transport,
      log,
      requestId,
      signal,
      continuations,
      root,
      requirements,
      implicitToolContinuation,
    });
    return;
  }
  throw new HttpError(
    404,
    "The requested route was not found.",
    "not_found_error",
    "route_not_found",
  );
}

/** Rejects hostile authorities and every browser-originated request. */
function validateRequestAuthority(
  request: IncomingMessage,
): HttpError | undefined {
  if (!isAllowedHost(request.headers.host))
    return new HttpError(
      403,
      "The Host header must identify a loopback address.",
      "invalid_request_error",
      "invalid_host_header",
      "host",
    );
  // The proxy has no browser authentication surface. Rejecting Origin entirely
  // keeps cross-origin and browser form traffic fail-closed, while ordinary CLI
  // and server-side HTTP clients (which omit Origin) remain compatible.
  if (request.headers.origin !== undefined)
    return new HttpError(
      403,
      "Browser-originated requests are not accepted.",
      "invalid_request_error",
      "invalid_origin_header",
      "origin",
    );
  return undefined;
}

/** Accepts only explicit loopback HTTP authorities with an optional valid port. */
function isAllowedHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]+))?$/i.exec(host);
  if (!match) return false;
  if (match[2] === undefined) return true;
  const port = Number(match[2]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/** Creates the stable error returned when a request body exceeds its limit. */
function bodyTooLargeError(): HttpError {
  return new HttpError(
    413,
    "Request body is too large.",
    "invalid_request_error",
    "body_too_large",
  );
}

/** Reads and parses a size-limited, abortable JSON request body. */
async function readJsonBody(
  request: IncomingMessage,
  limit: number,
  signal: AbortSignal,
): Promise<unknown> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw bodyTooLargeError();
  const chunks = await new Promise<Buffer[]>((resolve, reject) => {
    const result: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown): void => {
      cleanup();
      request.pause();
      reject(error);
    };
    const onData = (raw: Buffer): void => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.length;
      if (size > limit) {
        fail(bodyTooLargeError());
        return;
      }
      result.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(result);
    };
    const onError = (): void =>
      fail(
        new HttpError(
          400,
          "The request body could not be read.",
          "invalid_request_error",
          "invalid_body",
        ),
      );
    const onAbort = (): void => fail(signal.reason);
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(
      400,
      "The request body is not valid JSON.",
      "invalid_request_error",
      "invalid_json",
    );
  }
}
