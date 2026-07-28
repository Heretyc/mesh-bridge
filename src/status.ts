import { EventEmitter } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { TelemetrySink } from "./telemetry.js";

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
    channelPairs: Array<{ discordChannelId: string; meshtasticChannelName: string; meshChannelIndex: number | null }>;
  };
  counters: Record<string, number>;
  queues: { discordToMesh: number; meshToDiscord: number };
  logDegraded: boolean;
  journalDegraded: boolean;
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

export class StatusStore extends EventEmitter {
  private telemetry?: TelemetrySink;
  private readonly state: StatusSnapshot = {
    startedAt: new Date().toISOString(),
    connections: { discord: "offline", meshtastic: "offline", serialPort: "-", localNode: "-", channelPairs: [] },
    counters: { discordReceived: 0, meshSent: 0, meshReceived: 0, discordSent: 0, retries: 0, failures: 0, rejected: 0 },
    queues: { discordToMesh: 0, meshToDiscord: 0 },
    logDegraded: false,
    journalDegraded: false,
    events: [],
  };

  public useTelemetry(sink: TelemetrySink): void {
    this.telemetry = sink;
  }

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
    this.pushEvent(level, code, meta);
    this.telemetry?.logEvent(level, code, meta);
    this.changed();
  }

  public logDegraded(degraded: boolean, code: string, meta: Record<string, unknown> = {}): void {
    this.state.logDegraded = degraded;
    this.pushEvent(degraded ? "warn" : "info", code, meta);
    this.changed();
  }

  public journalDegraded(degraded: boolean, code: string, meta: Record<string, unknown> = {}): void {
    this.state.journalDegraded = degraded;
    if (degraded) this.pushEvent("warn", code, meta);
    this.changed();
  }

  private pushEvent(level: Level, code: string, meta: Record<string, unknown>): void {
    const safe = redact(meta) as Record<string, unknown>;
    this.state.events.push({ at: new Date().toISOString(), level, code, detail: Object.keys(safe).length ? JSON.stringify(safe) : "" });
    if (this.state.events.length > 25) this.state.events.shift();
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

// Absolute deadline for a freshly accepted socket to present its token. Unlike a resettable inactivity
// timeout, this bound cannot be extended by a client that dribbles bytes, so a pre-auth socket can never
// keep the server alive past it and block shutdown.
const IPC_AUTH_TIMEOUT_MS = 5_000;

export class IpcServer {
  /** Every accepted socket, authenticated or not, so close() can guarantee-destroy all of them. */
  private readonly sockets = new Set<Socket>();
  /** Authenticated subscribers only; the broadcast target set. Always a subset of `sockets`. */
  private readonly clients = new Set<Socket>();
  private server?: Server;
  private readonly broadcast = (): void => {
    const line = `${JSON.stringify(this.store.snapshot())}\n`;
    for (const socket of this.clients) socket.write(line);
  };

  public constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly store: StatusStore,
    private readonly onShutdown?: () => void,
  ) {}

  public start(): Promise<void> {
    return new Promise((resolveStart, reject) => {
      this.server = createServer((socket) => this.accept(socket));
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
    // Destroy EVERY accepted socket, including any still mid-authentication, so server.close() is never left
    // waiting on a connection that never authenticated.
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolveClose) => this.server?.close(() => resolveClose()) ?? resolveClose());
  }

  // Track a socket from the instant it is accepted, before any auth, and drop it from both sets when it closes.
  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.clients.delete(socket);
    });
    this.authenticate(socket);
  }

  private authenticate(socket: Socket): void {
    // Absolute deadline, not a resettable inactivity timeout: a partial-token client cannot extend it.
    const authTimer = setTimeout(() => socket.destroy(), IPC_AUTH_TIMEOUT_MS);
    authTimer.unref();
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
      clearTimeout(authTimer);
      // Any bytes buffered after the token's newline are command data that
      // arrived in the same TCP segment; seed the command buffer with them so
      // they are not dropped when the post-auth handler is installed.
      let commands = input.slice(newline + 1);
      const processCommands = (): void => {
        if (commands.length > 256) {
          socket.destroy();
          return;
        }
        const commandEnd = commands.indexOf("\n");
        if (commandEnd < 0) return;
        socket.off("data", onCommand);
        if (commands.slice(0, commandEnd).replace(/\r$/u, "") === "shutdown" && this.onShutdown) {
          this.store.event("info", "IPC_SHUTDOWN_REQUESTED");
          this.onShutdown();
        } else {
          socket.destroy();
        }
      };
      const onCommand = (commandChunk: Buffer): void => {
        commands += commandChunk.toString("utf8");
        processCommands();
      };
      socket.on("data", onCommand);
      this.clients.add(socket);
      socket.write(`${JSON.stringify(this.store.snapshot())}\n`);
      // Process residual command bytes already buffered from the auth segment.
      processCommands();
    };
    socket.on("data", onData);
  }
}
