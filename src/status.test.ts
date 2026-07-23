import assert from "node:assert/strict";
import { createServer, createConnection } from "node:net";
import test from "node:test";
import { IpcServer, StatusStore } from "./status.js";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate test port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

function readFirstLine(port: number, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => socket.destroy(new Error("IPC test timeout")), 2_000);
    let input = "";
    socket.on("connect", () => socket.write(`${token}\n`));
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      const newline = input.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timer);
        socket.destroy();
        resolve(input.slice(0, newline));
      }
    });
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timer);
      if (!input) reject(new Error("IPC authentication rejected"));
    });
  });
}

test("local IPC authenticates and exposes only sanitized status", async () => {
  const port = await freePort();
  const token = "t".repeat(64);
  const store = new StatusStore();
  const ipc = new IpcServer(port, token, store);
  await ipc.start();
  try {
    const snapshot = JSON.parse(await readFirstLine(port, token)) as { connections: { discord: string } };
    assert.equal(snapshot.connections.discord, "offline");
    await assert.rejects(readFirstLine(port, "wrong-token"), /authentication rejected/u);
  } finally {
    await ipc.close();
  }
});
