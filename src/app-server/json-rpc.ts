import { EventEmitter } from "node:events";
import type { Writable, Readable } from "node:stream";
import { createInterface } from "node:readline";
import { record } from "../core/canonical.js";
import { listenForAbort } from "../core/abort.js";

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
      let disposeAbort = (): void => undefined;
      const abort = (abortedSignal: AbortSignal): void => {
        if (!this.#pending.delete(id)) return;
        reject(abortedSignal.reason ?? new Error("request cancelled"));
      };
      const pending: Pending = {
        resolve: (value) => {
          disposeAbort();
          resolve(value);
        },
        reject: (reason) => {
          disposeAbort();
          reject(reason);
        },
      };
      this.#pending.set(id, pending);
      disposeAbort = listenForAbort(signal, abort);
      if (!this.#pending.has(id)) return;
      try {
        this.#write({ id, method, params });
      } catch (error) {
        if (this.#pending.delete(id)) pending.reject(error);
      }
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
    // Buffered frames may arrive after close; logical closure is authoritative.
    if (this.#closed) return;
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.emit("malformed", line);
      this.close(new Error("app-server emitted malformed JSON"));
      return;
    }
    const message = record(value);
    if (!message) {
      this.emit("malformed", line);
      return;
    }
    if (
      (typeof message.id === "number" || typeof message.id === "string") &&
      ("result" in message || "error" in message)
    ) {
      const pending =
        typeof message.id === "number"
          ? this.#pending.get(message.id)
          : undefined;
      if (!pending) return;
      this.#pending.delete(message.id as number);
      const error = record(message.error);
      if (error && typeof error.code === "number")
        pending.reject(
          new RpcError(error.code, String(error.message ?? "JSON-RPC error")),
        );
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") {
      this.emit("malformed", line);
      return;
    }
    if (typeof message.id === "number" || typeof message.id === "string")
      this.emit("request", {
        id: message.id,
        method: message.method,
        params: message.params,
      } satisfies ServerRequest);
    else this.emit("notification", message.method, message.params);
  }
}
