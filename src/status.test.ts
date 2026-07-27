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

function sendCommand(port: number, token: string, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => socket.destroy(new Error("IPC test timeout")), 2_000);
    let sent = false;
    socket.on("connect", () => socket.write(`${token}\n`));
    socket.on("data", () => {
      if (sent) return;
      sent = true;
      socket.write(`${command}\n`);
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(timer);
      sent ? resolve() : reject(new Error("IPC authentication rejected"));
    });
  });
}

test("authenticated IPC shutdown command invokes the shutdown hook exactly once", async () => {
  const port = await freePort();
  const token = "t".repeat(64);
  const store = new StatusStore();
  let calls = 0;
  let resolveShutdown!: () => void;
  const requested = new Promise<void>((resolveRequest) => (resolveShutdown = resolveRequest));
  const ipc = new IpcServer(port, token, store, () => {
    calls += 1;
    resolveShutdown();
  });
  await ipc.start();
  try {
    const settled = sendCommand(port, token, "shutdown");
    await requested;
    await ipc.close();
    await settled;
    assert.equal(calls, 1);
  } finally {
    await ipc.close();
  }
});

test("shutdown command in the same segment as the token invokes the shutdown hook exactly once", async () => {
  const port = await freePort();
  const token = "t".repeat(64);
  const store = new StatusStore();
  let calls = 0;
  let resolveShutdown!: () => void;
  const requested = new Promise<void>((resolveRequest) => (resolveShutdown = resolveRequest));
  const ipc = new IpcServer(port, token, store, () => {
    calls += 1;
    resolveShutdown();
  });
  await ipc.start();
  try {
    const socket = createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => socket.destroy(new Error("IPC test timeout")), 2_000);
    // Token and command arrive together in a single write, before any snapshot.
    socket.on("connect", () => socket.write(`${token}\nshutdown\n`));
    socket.on("error", () => undefined);
    await requested;
    clearTimeout(timer);
    socket.destroy();
    assert.equal(calls, 1);
  } finally {
    await ipc.close();
  }
});

test("unknown IPC commands drop the client without invoking the shutdown hook", async () => {
  const port = await freePort();
  const token = "t".repeat(64);
  const store = new StatusStore();
  let calls = 0;
  const ipc = new IpcServer(port, token, store, () => {
    calls += 1;
  });
  await ipc.start();
  try {
    await sendCommand(port, token, "reboot");
    assert.equal(calls, 0);
  } finally {
    await ipc.close();
  }
});

test("close() promptly destroys a socket stuck mid-authentication instead of waiting out its deadline", async () => {
  const port = await freePort();
  const token = "t".repeat(64);
  const store = new StatusStore();
  const ipc = new IpcServer(port, token, store);
  await ipc.start();
  try {
    // A client that writes a partial token with no newline never authenticates, so it is never a tracked
    // subscriber — before the fix close() left the server waiting on it until the 5s auth deadline fired.
    const socket = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      socket.on("connect", () => {
        socket.write("partial-token-without-a-newline");
        resolve();
      });
      socket.on("error", reject);
    });
    // Yield so the server's connection handler has accepted and tracked the socket before we close.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const started = Date.now();
    await ipc.close();
    const elapsed = Date.now() - started;
    // Far under the 5s absolute auth deadline: close() destroyed the pre-auth socket up front, not waited.
    assert.ok(elapsed < 1_000, `close() returned promptly (${elapsed}ms)`);
    socket.destroy();
  } finally {
    await ipc.close();
  }
});

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
