import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { once } from "node:events";
import { test } from "vitest";
import { JsonRpcTransport, RpcError } from "../../src/app-server/json-rpc.js";

test("transport correlates interleaved notifications and responses without jsonrpc", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new JsonRpcTransport(input, output);
  const notification = once(rpc, "notification");
  const request = rpc.request("account/read", {});
  const [wire] = await once(output, "data");
  const id = (JSON.parse(String(wire)) as { id: number }).id;
  input.write(
    `${JSON.stringify({ method: "notice", params: { value: 1 } })}\n`,
  );
  input.write(`${JSON.stringify({ id, result: { ok: true } })}\n`);
  assert.deepEqual(await notification, ["notice", { value: 1 }]);
  assert.deepEqual(await request, { ok: true });
});

test("transport rejects overload errors and malformed output", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new JsonRpcTransport(input, output);
  const request = rpc.request("turn/start", {});
  const [wire] = await once(output, "data");
  const id = (JSON.parse(String(wire)) as { id: number }).id;
  input.write(
    `${JSON.stringify({ id, error: { code: -32001, message: "busy" } })}\n`,
  );
  await assert.rejects(
    request,
    (error: unknown) => error instanceof RpcError && error.rpcCode === -32001,
  );
  const malformed = once(rpc, "malformed");
  input.write("not-json\n");
  await malformed;
  await assert.rejects(rpc.request("later", {}), /closed/);
});

test("transport immediately exposes server requests and supports cancellation", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new JsonRpcTransport(input, output);
  const serverRequest = once(rpc, "request");
  input.write(
    `${JSON.stringify({ id: "server-1", method: "item/tool/requestUserInput", params: {} })}\n`,
  );
  assert.equal((await serverRequest)[0].method, "item/tool/requestUserInput");
  const controller = new AbortController();
  const pending = rpc.request("slow", {}, controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
});

test("transport suppresses buffered server requests after logical close", async () => {
  const input = new PassThrough();
  const rpc = new JsonRpcTransport(input, new PassThrough());
  let requests = 0;
  rpc.on("request", () => {
    requests += 1;
  });

  rpc.close();
  input.write(
    `${JSON.stringify({ id: 7, method: "item/tool/call", params: {} })}\n`,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(requests, 0);
});

test("a synchronous output write failure removes its pending request", async () => {
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  output.write = (): boolean => {
    throw new Error("synchronous write failure");
  };
  const rpc = new JsonRpcTransport(new PassThrough(), output, 1);

  await assert.rejects(rpc.request("first", {}), /synchronous write failure/);
  await assert.rejects(rpc.request("second", {}), /synchronous write failure/);
});
