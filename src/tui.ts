import { createConnection } from "node:net";
import { loadIpcConfig } from "./config.js";
import { delay } from "./logic.js";
import type { StatusSnapshot } from "./status.js";

const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());

function visible(value: unknown): string {
  return String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "?");
}

function render(status: StatusSnapshot): void {
  const connections = status.connections;
  const counters = Object.entries(status.counters).map(([name, count]) => `${name}=${count}`).join("  ");
  const events = status.events.slice(-12).map((event) =>
    `${event.at.slice(11, 19)} ${event.level.toUpperCase().padEnd(5)} ${visible(event.code)} ${visible(event.detail)}`,
  );
  const output = [
    "Mesh Bridge — read-only local status",
    `Started ${status.startedAt}`,
    "",
    `Discord: ${connections.discord}  Meshtastic: ${connections.meshtastic}`,
    `Serial: ${visible(connections.serialPort)}  Node: ${visible(connections.localNode)}  Channel index: ${visible(connections.meshChannel)}`,
    `Queues: Discord→Mesh ${status.queues.discordToMesh}  Mesh→Discord ${status.queues.meshToDiscord}`,
    `Counters: ${counters}`,
    ...(status.logDegraded ? ["", "Telemetry log writes are degraded; relay traffic is still running."] : []),
    ...(status.journalDegraded ? ["", "Reply mapping journal writes are degraded; relay traffic is still running."] : []),
    "",
    "Sanitized rolling events",
    ...events,
    "",
    "Ctrl+C to detach",
  ].join("\n");
  process.stdout.write(`\u001b[2J\u001b[H${output}\n`);
}

async function attach(port: number, token: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let input = "";
    let authenticated = false;
    socket.on("connect", () => socket.write(`${token}\n`));
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      if (input.length > 1_048_576) return socket.destroy(new Error("IPC frame too large"));
      for (let newline = input.indexOf("\n"); newline >= 0; newline = input.indexOf("\n")) {
        const line = input.slice(0, newline).replace(/\r$/u, "");
        input = input.slice(newline + 1);
        if (!line) continue;
        try {
          render(JSON.parse(line) as StatusSnapshot);
          authenticated = true;
        } catch {
          socket.destroy(new Error("Invalid IPC response"));
        }
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (!stop.signal.aborted) {
        process.stdout.write(`\u001b[2J\u001b[HMesh Bridge TUI\n\n${authenticated ? "Service disconnected" : "Waiting for service (or check IPC_TOKEN)"}...\n`);
      }
      resolve();
    });
    stop.signal.addEventListener("abort", () => socket.destroy(), { once: true });
  });
}

async function main(): Promise<void> {
  try {
    const config = loadIpcConfig();
    while (!stop.signal.aborted) {
      await attach(config.ipcPort, config.ipcToken);
      if (!stop.signal.aborted) await delay(2_000, stop.signal);
    }
  } catch (error) {
    if (!stop.signal.aborted) {
      console.error(`[Mesh Bridge TUI] fatal: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}

void main();
