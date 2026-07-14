import { EventEmitter } from "node:events";
import type { Writable, Readable } from "node:stream";
import { createInterface } from "node:readline";

/** JSON-RPC error object accepted by respondError. */
export interface RpcErrorData {
  code: number;
  message: string;
  data?: unknown;
}

/** Represents an error response received over JSON-RPC. */
export class RpcError extends Error {
  constructor(
    public readonly rpcCode: number,
    message: string,
    public readonly rpcData?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Completion callbacks for an in-flight client request. */
type Pending = {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
};

/** Request initiated by app-server toward the proxy. */
export interface ServerRequest {
  id: string | number;
  method: string;
  params: unknown;
}

/** Exchanges newline-delimited JSON-RPC messages with app-server. */
export class JsonRpcTransport extends EventEmitter {
  readonly #pending = new Map<number, Pending>();
  readonly #output: Writable;
  readonly #maxPending: number;
  #nextId = 1;
  #closed = false;

  constructor(input: Readable, output: Writable, maxPending = 256) {
    super();
    this.#output = output;
    this.#maxPending = maxPending;
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => this.#receive(line));
    lines.on("close", () =>
      this.close(new Error("app-server transport closed")),
    );
    input.on("error", (error) => this.close(error));
    output.on("error", (error) => this.close(error));
  }

  request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#closed)
      return Promise.reject(new Error("app-server transport is closed"));
    if (signal?.aborted)
      return Promise.reject(signal.reason ?? new Error("request cancelled"));
    if (this.#pending.size >= this.#maxPending)
      return Promise.reject(
        new RpcError(-32001, "app-server request queue is full"),
      );
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        if (!this.#pending.delete(id)) return;
        reject(signal?.reason ?? new Error("request cancelled"));
      };
      const pending: Pending = {
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (reason) => {
          signal?.removeEventListener("abort", abort);
          reject(reason);
        },
      };
      this.#pending.set(id, pending);
      signal?.addEventListener("abort", abort, { once: true });
      this.#write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.#write(params === undefined ? { method } : { method, params });
  }

  respond(id: string | number, result: unknown): void {
    this.#write({ id, result });
  }

  respondError(id: string | number, error: RpcErrorData): void {
    this.#write({ id, error });
  }

  close(reason: Error = new Error("app-server transport closed")): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(reason);
    this.#pending.clear();
    this.emit("close", reason);
  }

  #write(message: object): void {
    if (this.#closed) throw new Error("app-server transport is closed");
    this.#output.write(`${JSON.stringify(message)}\n`);
  }

  #receive(line: string): void {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.emit("malformed", line);
      this.close(new Error("app-server emitted malformed JSON"));
      return;
    }
    if (!isRecord(value)) {
      this.emit("malformed", line);
      return;
    }
    if (
      (typeof value.id === "number" || typeof value.id === "string") &&
      ("result" in value || "error" in value)
    ) {
      const pending =
        typeof value.id === "number" ? this.#pending.get(value.id) : undefined;
      if (!pending) return;
      this.#pending.delete(value.id as number);
      if (isRecord(value.error) && typeof value.error.code === "number")
        pending.reject(
          new RpcError(
            value.error.code,
            String(value.error.message ?? "JSON-RPC error"),
            value.error.data,
          ),
        );
      else pending.resolve(value.result);
      return;
    }
    if (typeof value.method !== "string") {
      this.emit("malformed", line);
      return;
    }
    if (typeof value.id === "number" || typeof value.id === "string")
      this.emit("request", {
        id: value.id,
        method: value.method,
        params: value.params,
      } satisfies ServerRequest);
    else this.emit("notification", value.method, value.params);
  }
}

/** Narrows parsed JSON values to non-array objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
