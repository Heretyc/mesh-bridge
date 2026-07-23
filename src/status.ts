import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";

type LinkState = "offline" | "connecting" | "online" | "error";
type Level = "info" | "warn" | "error";

interface EventLine {
  at: string;
  level: Level;
  code: string;
  detail: string;
}

export interface StatusSnapshot {
  startedAt: string;
  connections: {
    discord: LinkState;
    meshtastic: LinkState;
    serialPort: string;
    localNode: string;
    meshChannel: string;
  };
  counters: Record<string, number>;
  queues: { discordToMesh: number; meshToDiscord: number };
  events: EventLine[];
}

const secretKey = /token|secret|content|message|text|payload|psk|key/i;

export function redact(value: unknown, key = ""): unknown {
  if (secretKey.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 500) : value;
}

class RotatingJsonLog {
  private readonly directory = resolve("logs");
  private readonly path = resolve(this.directory, "mesh-bridge.jsonl");

  public constructor(private readonly maxBytes = 1_048_576, private readonly copies = 5) {
    mkdirSync(this.directory, { recursive: true });
  }

  public write(level: Level, code: string, meta: Record<string, unknown>): void {
    const line = `${JSON.stringify({ at: new Date().toISOString(), level, code, meta: redact(meta) })}\n`;
    if (existsSync(this.path) && statSync(this.path).size + Buffer.byteLength(line) > this.maxBytes) this.rotate();
    appendFileSync(this.path, line, { encoding: "utf8", mode: 0o600 });
  }

  private rotate(): void {
    const oldest = `${this.path}.${this.copies}`;
    if (existsSync(oldest)) rmSync(oldest);
    for (let index = this.copies - 1; index >= 1; index -= 1) {
      const source = `${this.path}.${index}`;
      if (existsSync(source)) renameSync(source, `${this.path}.${index + 1}`);
    }
    renameSync(this.path, `${this.path}.1`);
  }
}

export class StatusStore extends EventEmitter {
  private readonly log = new RotatingJsonLog();
  private readonly state: StatusSnapshot = {
    startedAt: new Date().toISOString(),
    connections: { discord: "offline", meshtastic: "offline", serialPort: "-", localNode: "-", meshChannel: "-" },
    counters: { discordReceived: 0, meshSent: 0, meshReceived: 0, discordSent: 0, retries: 0, failures: 0, rejected: 0 },
    queues: { discordToMesh: 0, meshToDiscord: 0 },
    events: [],
  };

  public snapshot(): StatusSnapshot {
    return structuredClone(this.state);
  }

  public link(link: "discord" | "meshtastic", state: LinkState): void {
    this.state.connections[link] = state;
    this.changed();
  }

  public connection(meta: Partial<StatusSnapshot["connections"]>): void {
    Object.assign(this.state.connections, meta);
    this.changed();
  }

  public count(name: string, amount = 1): void {
    this.state.counters[name] = (this.state.counters[name] ?? 0) + amount;
    this.changed();
  }

  public queue(name: keyof StatusSnapshot["queues"], depth: number): void {
    this.state.queues[name] = depth;
    this.changed();
  }

  public event(level: Level, code: string, meta: Record<string, unknown> = {}): void {
    const safe = redact(meta) as Record<string, unknown>;
    this.state.events.push({ at: new Date().toISOString(), level, code, detail: Object.keys(safe).length ? JSON.stringify(safe) : "" });
    if (this.state.events.length > 25) this.state.events.shift();
    this.log.write(level, code, meta);
    this.changed();
  }

  private changed(): void {
    this.emit("changed");
  }
}

function matchesToken(received: string, expected: string): boolean {
  const left = Buffer.from(received, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export class IpcServer {
  private readonly clients = new Set<Socket>();
  private server?: Server;
  private readonly broadcast = (): void => {
    const line = `${JSON.stringify(this.store.snapshot())}\n`;
    for (const socket of this.clients) socket.write(line);
  };

  public constructor(private readonly port: number, private readonly token: string, private readonly store: StatusStore) {}

  public start(): Promise<void> {
    return new Promise((resolveStart, reject) => {
      this.server = createServer((socket) => this.authenticate(socket));
      this.server.once("error", reject);
      this.server.listen({ host: "127.0.0.1", port: this.port, exclusive: true }, () => {
        this.server?.off("error", reject);
        this.server?.on("error", (error) => this.store.event("error", "IPC_SERVER_ERROR", { error: String(error) }));
        this.store.on("changed", this.broadcast);
        resolveStart();
      });
    });
  }

  public async close(): Promise<void> {
    this.store.off("changed", this.broadcast);
    for (const socket of this.clients) socket.destroy();
    await new Promise<void>((resolveClose) => this.server?.close(() => resolveClose()) ?? resolveClose());
  }

  private authenticate(socket: Socket): void {
    socket.setTimeout(5_000, () => socket.destroy());
    let input = "";
    const onData = (chunk: Buffer): void => {
      input += chunk.toString("utf8");
      if (input.length > 4_096) {
        socket.destroy();
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      socket.off("data", onData);
      if (!matchesToken(input.slice(0, newline).replace(/\r$/u, ""), this.token)) {
        socket.destroy();
        return;
      }
      socket.setTimeout(0);
      socket.on("data", () => socket.destroy());
      socket.on("close", () => this.clients.delete(socket));
      this.clients.add(socket);
      socket.write(`${JSON.stringify(this.store.snapshot())}\n`);
    };
    socket.on("data", onData);
  }
}
