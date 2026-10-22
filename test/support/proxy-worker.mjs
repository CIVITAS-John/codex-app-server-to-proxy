import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers";
import {
  prepareServeOptions,
  parseServeOptions,
} from "../../dist/core/config.js";
import { createLogger } from "../../dist/core/logger.js";
import { createProxyServer } from "../../dist/http/server.js";
import { JsonRpcTransport } from "../../dist/app-server/json-rpc.js";

/** Starts a real listener with typed synthetic protocol frames supplied by the test. */
async function start({ root, port, frames, marker }) {
  const options = await prepareServeOptions(
    parseServeOptions(["--root", root, "--port", String(port)]),
  );
  const proxy = createProxyServer(options, createLogger("error"));
  const address = await proxy.listen();
  // Simulate app-server-owned home files only after this worker owns its port.
  await mkdir(address.options.codexHome, { recursive: true });
  await writeFile(join(address.options.codexHome, "worker-marker"), marker);
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const rpc = new JsonRpcTransport(incoming, outgoing);
  const lines = createInterface({ input: outgoing });
  const send = (frame) => incoming.write(`${JSON.stringify(frame)}\n`);
  lines.on("line", (line) => {
    const request = JSON.parse(line);
    if (!request.method || request.id === undefined) return;
    const frame = frames.responses[request.method];
    if (!frame) throw new Error(`Unexpected fake RPC: ${request.method}`);
    send({ ...frame, id: request.id });
    if (request.method === "turn/start")
      setImmediate(() => frames.notifications.forEach(send));
  });
  proxy.setTransport(rpc);
  proxy.setReady(true);
  process.once("message", async () => {
    await proxy.close();
    lines.close();
    incoming.destroy();
    outgoing.destroy();
    process.disconnect();
  });
  process.send({ ...address, origin: `http://127.0.0.1:${address.port}` });
}

process.once("message", (settings) => {
  void start(settings).catch((error) => {
    process.send({ error: error.message });
    process.exitCode = 1;
    process.disconnect();
  });
});
