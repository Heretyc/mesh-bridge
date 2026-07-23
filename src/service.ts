import { createHash } from "node:crypto";
import { Constants, MeshDevice, Protobuf, Types } from "@meshtastic/core";
import { TransportNodeSerial } from "@meshtastic/transport-node-serial";
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageType,
  PermissionFlagsBits,
  type Message,
  type SendableChannels,
} from "discord.js";
import { SerialPort } from "serialport";
import { loadEnvironment, parseConfig, unsafeEnvPermissions, type Config } from "./config.js";
import {
  BoundedQueue,
  TtlDedup,
  backoff,
  delay,
  discoverMeshtasticPath,
  resolveEncryptedChannel,
  retry,
  safeAttachmentName,
  safeDisplayName,
  shouldForwardDiscord,
  shouldForwardMesh,
  splitDiscordForMesh,
} from "./logic.js";
import { IpcServer, StatusStore } from "./status.js";

class FatalConfigurationError extends Error {}

interface DiscordJob {
  id: string;
  chunks: string[];
}

interface MeshJob {
  from: number;
  text: string;
}

interface MeshSession {
  device: MeshDevice;
  channel: number;
  localNode: number;
  disconnected: Promise<void>;
  activate: () => void;
  close: () => Promise<void>;
}

const allowedMentions = { parse: [] as never[], repliedUser: false };

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortPromise(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export class BridgeService {
  public readonly status = new StatusStore();
  private readonly abort = new AbortController();
  private readonly ipc: IpcServer;
  private readonly discordToMesh: BoundedQueue<DiscordJob>;
  private readonly meshToDiscord: BoundedQueue<MeshJob>;
  private readonly discordDedup: TtlDedup;
  private readonly meshDedup: TtlDedup;
  private nodeNames = new Map<number, string>();
  private discord: Client | undefined;
  private discordChannel: SendableChannels | undefined;
  private mesh: MeshSession | undefined;
  private lastMeshSend = 0;

  public constructor(private readonly config: Config) {
    this.ipc = new IpcServer(config.ipcPort, config.ipcToken, this.status);
    this.discordDedup = new TtlDedup(config.dedupTtlMs, config.queueLimit * 10);
    this.meshDedup = new TtlDedup(config.dedupTtlMs, config.queueLimit * 10);
    this.discordToMesh = new BoundedQueue(config.queueLimit, (depth) => this.status.queue("discordToMesh", depth));
    this.meshToDiscord = new BoundedQueue(config.queueLimit, (depth) => this.status.queue("meshToDiscord", depth));
  }

  public async run(): Promise<void> {
    process.once("SIGINT", () => this.abort.abort(new Error("SIGINT")));
    process.once("SIGTERM", () => this.abort.abort(new Error("SIGTERM")));
    await this.ipc.start();
    this.status.event("info", "SERVICE_STARTED", { ipcPort: this.config.ipcPort });

    this.discordToMesh.start((job) => this.deliverDiscordToMesh(job).catch((error) => {
      if (!this.abort.signal.aborted) this.status.event("error", "DISCORD_TO_MESH_WORKER_FAILED", { reason: reason(error) });
    }));
    this.meshToDiscord.start((job) => this.deliverMeshToDiscord(job).catch((error) => {
      if (!this.abort.signal.aborted) this.status.event("error", "MESH_TO_DISCORD_WORKER_FAILED", { reason: reason(error) });
    }));

    try {
      await Promise.all([this.discordLoop(), this.meshLoop()]);
    } catch (error) {
      this.status.event("error", "SERVICE_FATAL", { reason: reason(error) });
      this.abort.abort(error);
      throw error;
    } finally {
      await this.shutdown();
    }
  }

  private async discordLoop(): Promise<void> {
    let attempt = 0;
    while (!this.abort.signal.aborted) {
      this.status.link("discord", "connecting");
      const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
        allowedMentions,
      });
      let invalidated!: () => void;
      const invalid = new Promise<void>((resolve) => { invalidated = resolve; });
      client.once(Events.Invalidated, invalidated);
      client.on(Events.Error, (error) => this.status.event("error", "DISCORD_CLIENT_ERROR", { reason: reason(error) }));
      client.on(Events.ShardDisconnect, (_event, shardId) => {
        this.status.link("discord", "connecting");
        this.status.event("warn", "DISCORD_DISCONNECTED", { shardId });
      });
      client.on(Events.ShardResume, (shardId) => {
        this.status.link("discord", "online");
        this.status.event("info", "DISCORD_RESUMED", { shardId });
      });
      client.on(Events.MessageCreate, (message) => {
        void this.handleDiscordMessage(message).catch((error) => {
          this.status.count("failures");
          this.status.event("error", "DISCORD_MESSAGE_HANDLER_FAILED", { reason: reason(error) });
        });
      });

      try {
        const ready = this.waitForDiscordReady(client);
        await Promise.all([client.login(this.config.discordToken), ready]);
        if (client.user?.username !== "Mesh Bridge") {
          throw new FatalConfigurationError(`Discord bot username must be exactly "Mesh Bridge"; found "${client.user?.username ?? "unknown"}"`);
        }
        const channel = await client.channels.fetch(this.config.discordChannelId);
        if (!channel || !channel.isSendable() || channel.isDMBased()) {
          throw new FatalConfigurationError("DISCORD_CHANNEL_ID is not a sendable server channel visible to Mesh Bridge");
        }
        const permissions = channel.permissionsFor(client.user);
        if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
          throw new FatalConfigurationError("Mesh Bridge needs only View Channel and Send Messages in DISCORD_CHANNEL_ID");
        }
        this.discord = client;
        this.discordChannel = channel;
        this.status.link("discord", "online");
        this.status.event("info", "DISCORD_CONNECTED");
        attempt = 0;
        await Promise.race([invalid, abortPromise(this.abort.signal)]);
      } catch (error) {
        if (error instanceof FatalConfigurationError || /invalid token/i.test(reason(error))) throw error;
        if (!this.abort.signal.aborted) {
          this.status.link("discord", "error");
          this.status.event("error", "DISCORD_CONNECT_FAILED", { reason: reason(error), retryMs: backoff(attempt) });
        }
      } finally {
        if (this.discord === client) {
          this.discord = undefined;
          this.discordChannel = undefined;
        }
        client.destroy();
      }
      if (!this.abort.signal.aborted) await delay(backoff(attempt++), this.abort.signal);
    }
  }

  private waitForDiscordReady(client: Client): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Discord ready timeout")), 30_000);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      client.once(Events.ClientReady, done);
      this.abort.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(this.abort.signal.reason);
      }, { once: true });
    });
  }

  private async handleDiscordMessage(message: Message): Promise<void> {
    const attachmentNames = message.attachments.map((attachment) => safeAttachmentName(attachment.name));
    const body = [message.content, ...attachmentNames].filter(Boolean).join(" ");
    const ordinary = message.type === MessageType.Default || message.type === MessageType.Reply;
    if (!shouldForwardDiscord({
      channelId: message.channelId,
      authorBot: message.author.bot,
      webhookId: message.webhookId,
      ordinary,
      hasBody: body.length > 0,
    }, this.config.discordChannelId)) return;
    if (this.discordDedup.seen(`discord:${message.id}`)) return;

    this.status.count("discordReceived");
    const displayName = message.member?.displayName ?? message.author.globalName ?? message.author.username;
    const job = { id: message.id, chunks: splitDiscordForMesh(displayName, body) };
    if (!this.discordToMesh.enqueue(job)) {
      this.status.count("rejected");
      this.status.event("error", "DISCORD_TO_MESH_QUEUE_FULL", { discordId: message.id });
      await this.reportDiscord("Mesh Bridge: message was not queued because the mesh queue is full.");
    }
  }

  private async deliverDiscordToMesh(job: DiscordJob): Promise<void> {
    let delivered = 0;
    for (const chunk of job.chunks) {
      try {
        await retry(async () => {
          const session = await this.waitForMesh();
          await this.waitForMeshSendSlot();
          await Promise.race([
            session.device.sendText(chunk, "broadcast", true, session.channel as Types.ChannelNumber),
            session.disconnected.then(() => Promise.reject(new Error("Meshtastic disconnected before ACK"))),
            delay(65_000, this.abort.signal).then(() => Promise.reject(new Error("Meshtastic ACK timeout"))),
          ]);
        }, this.config.ackRetries, () => {
          this.status.count("retries");
          this.status.event("warn", "MESH_SEND_RETRY", { discordId: job.id, chunk: delivered + 1 });
        });
        delivered += 1;
        this.status.count("meshSent");
      } catch (error) {
        if (this.abort.signal.aborted) return;
        this.status.count("failures");
        this.status.event("error", delivered === 0 ? "MESH_DELIVERY_FAILED" : "MESH_DELIVERY_PARTIAL", {
          discordId: job.id,
          delivered,
          total: job.chunks.length,
          reason: reason(error),
        });
        const kind = delivered === 0 ? "failed" : "partially failed";
        await this.reportDiscord(`Mesh Bridge: mesh delivery ${kind}; ${delivered}/${job.chunks.length} chunks acknowledged.`);
        return;
      }
    }
  }

  private async waitForMeshSendSlot(): Promise<void> {
    const remaining = this.lastMeshSend + this.config.sendIntervalMs - Date.now();
    if (remaining > 0) await delay(remaining, this.abort.signal);
    this.lastMeshSend = Date.now();
  }

  private async meshLoop(): Promise<void> {
    let attempt = 0;
    while (!this.abort.signal.aborted) {
      this.status.link("meshtastic", "connecting");
      try {
        const session = await this.openMesh();
        this.mesh = session;
        this.status.link("meshtastic", "online");
        this.status.event("info", "MESHTASTIC_CONNECTED", { channel: session.channel });
        attempt = 0;
        await Promise.race([session.disconnected, abortPromise(this.abort.signal)]);
      } catch (error) {
        if (error instanceof FatalConfigurationError) throw error;
        if (!this.abort.signal.aborted) {
          this.status.link("meshtastic", "error");
          this.status.event("error", "MESHTASTIC_CONNECT_FAILED", { reason: reason(error), retryMs: backoff(attempt) });
        }
      } finally {
        const session = this.mesh;
        this.mesh = undefined;
        if (session) await session.close().catch(() => undefined);
        this.status.connection({ serialPort: "-", localNode: "-", meshChannel: "-" });
      }
      if (!this.abort.signal.aborted) await delay(backoff(attempt++), this.abort.signal);
    }
  }

  private async openMesh(): Promise<MeshSession> {
    const ports = await SerialPort.list();
    const candidates = ports.filter((port) => Boolean(port.vendorId) || /^USB/i.test(port.pnpId ?? ""));
    const sessions = new Map<string, MeshSession>();
    try {
      const serialPath = await discoverMeshtasticPath(candidates.map((port) => port.path), async (path) => {
        try {
          sessions.set(path, await this.openMeshAt(path));
          return true;
        } catch (error) {
          if (error instanceof FatalConfigurationError) throw error;
          this.status.event("warn", "SERIAL_PROBE_REJECTED", { serialPort: path, reason: reason(error) });
          return false;
        }
      });
      const session = sessions.get(serialPath)!;
      session.activate();
      return session;
    } catch (error) {
      await Promise.allSettled([...sessions.values()].map((session) => session.close()));
      throw error;
    }
  }

  private async openMeshAt(serialPath: string): Promise<MeshSession> {
    const port = new SerialPort({ path: serialPath, baudRate: 115_200, autoOpen: false });
    await new Promise<void>((resolve, reject) => port.open((error) => error ? reject(error) : resolve()));
    const transport = new TransportNodeSerial(port);
    const device = new MeshDevice(transport);
    device.log.settings.minLevel = 4;
    const channels: Protobuf.Channel.Channel[] = [];
    const pending: Protobuf.Mesh.MeshPacket[] = [];
    const nodeNames = new Map<number, string>();
    let localNode = 0;
    let routePacket: ((packet: Protobuf.Mesh.MeshPacket) => void) | undefined;
    let resolveDisconnected!: () => void;
    const disconnected = new Promise<void>((resolve) => { resolveDisconnected = resolve; });

    device.events.onMyNodeInfo.subscribe((info) => { localNode = info.myNodeNum; });
    device.events.onChannelPacket.subscribe((channel) => channels.push(channel));
    device.events.onNodeInfoPacket.subscribe((info) => {
      if (info.user?.longName) nodeNames.set(info.num, safeDisplayName(info.user.longName));
    });
    device.events.onUserPacket.subscribe((packet) => {
      if (packet.data.longName) nodeNames.set(packet.from, safeDisplayName(packet.data.longName));
    });
    device.events.onMeshPacket.subscribe((packet) => {
      if (routePacket) routePacket(packet);
      else if (pending.length < this.config.queueLimit) pending.push(packet);
      else {
        this.status.count("rejected");
        this.status.event("warn", "MESH_STARTUP_QUEUE_FULL", { serialPort: serialPath, packetId: packet.id });
      }
    });
    device.events.onDeviceStatus.subscribe((state) => {
      if (state === Types.DeviceStatusEnum.DeviceDisconnected) resolveDisconnected();
    });

    try {
      await new Promise<void>((resolveConfigured, rejectConfigured) => {
        const timer = setTimeout(() => rejectConfigured(new Error("Timed out waiting for Meshtastic configuration")), this.config.configTimeoutMs);
        device.events.onDeviceStatus.subscribe((state) => {
          if (state === Types.DeviceStatusEnum.DeviceConfigured) {
            clearTimeout(timer);
            resolveConfigured();
          } else if (state === Types.DeviceStatusEnum.DeviceDisconnected) {
            clearTimeout(timer);
            rejectConfigured(new Error("Meshtastic disconnected during configuration"));
          }
        });
        void device.configure().catch(rejectConfigured);
      });

      if (localNode === 0) throw new FatalConfigurationError("Meshtastic configuration did not provide a local node ID");
      const channel = resolveEncryptedChannel(channels.map((entry) => ({
        index: entry.index,
        role: entry.role,
        name: entry.settings?.name ?? "",
        psk: entry.settings?.psk ?? new Uint8Array(),
      })), this.config.meshChannelName);
      const session: MeshSession = {
        device,
        channel,
        localNode,
        disconnected,
        activate: () => {
          this.nodeNames = nodeNames;
          routePacket = (packet) => this.handleMeshPacket(packet, session);
          pending.splice(0).forEach(routePacket);
          device.setHeartbeatInterval(300_000);
          this.status.connection({
            serialPort: serialPath,
            localNode: `!${localNode.toString(16).padStart(8, "0")}`,
            meshChannel: String(channel),
          });
        },
        close: async () => {
          const graceful = device.disconnect().catch(() => undefined);
          await Promise.race([graceful, delay(1_000)]);
          await transport.disconnect().catch(() => undefined);
        },
      };
      return session;
    } catch (error) {
      await transport.disconnect().catch(() => undefined);
      if (/channel named|not encrypted|invalid index/i.test(reason(error))) throw new FatalConfigurationError(reason(error));
      throw error;
    }
  }

  private handleMeshPacket(packet: Protobuf.Mesh.MeshPacket, session: MeshSession): void {
    if (packet.payloadVariant.case !== "decoded") return;
    const data = packet.payloadVariant.value;
    if (!shouldForwardMesh({
      portNum: data.portnum,
      channel: packet.channel,
      from: packet.from,
      destination: packet.to === Constants.broadcastNum ? "broadcast" : "direct",
    }, session.channel, session.localNode)) return;
    const fallback = createHash("sha256").update(data.payload).digest("hex").slice(0, 16);
    const dedupKey = packet.id === 0
      ? `mesh:${packet.from}:0:${packet.rxTime}:${fallback}`
      : `mesh:${packet.from}:${packet.id}`;
    if (this.meshDedup.seen(dedupKey)) return;

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data.payload);
    } catch {
      this.status.count("rejected");
      this.status.event("error", "MESH_INVALID_UTF8", { from: packet.from, packetId: packet.id });
      return;
    }
    this.status.count("meshReceived");
    if (!this.meshToDiscord.enqueue({ from: packet.from, text })) {
      this.status.count("rejected");
      this.status.event("error", "MESH_TO_DISCORD_QUEUE_FULL", { from: packet.from, packetId: packet.id });
    }
  }

  private async deliverMeshToDiscord(job: MeshJob): Promise<void> {
    const channel = await this.waitForDiscord();
    const name = this.nodeNames.get(job.from) ?? `Unknown !${job.from.toString(16).padStart(8, "0")}`;
    try {
      await channel.send({ content: `${name}: ${job.text}`, allowedMentions });
      this.status.count("discordSent");
    } catch (error) {
      if (this.abort.signal.aborted) return;
      this.status.count("failures");
      this.status.event("error", "DISCORD_DELIVERY_FAILED", { from: job.from });
    }
  }

  private async waitForMesh(): Promise<MeshSession> {
    while (!this.mesh) await delay(250, this.abort.signal);
    return this.mesh;
  }

  private async waitForDiscord(): Promise<SendableChannels> {
    while (!this.discordChannel) await delay(250, this.abort.signal);
    return this.discordChannel;
  }

  private async reportDiscord(content: string): Promise<void> {
    try {
      const channel = await this.waitForDiscord();
      await channel.send({ content, allowedMentions });
    } catch (error) {
      if (!this.abort.signal.aborted) this.status.event("error", "FAILURE_REPORT_UNDELIVERED");
    }
  }

  private async shutdown(): Promise<void> {
    this.abort.abort(new Error("shutdown"));
    this.status.event("info", "SERVICE_STOPPING");
    await Promise.all([this.discordToMesh.drain(15_000), this.meshToDiscord.drain(15_000)]);
    this.discord?.destroy();
    await this.mesh?.close().catch(() => undefined);
    await this.ipc.close();
  }
}

async function main(): Promise<void> {
  try {
    const envPath = loadEnvironment();
    const config = parseConfig(process.env);
    const service = new BridgeService(config);
    for (const warning of unsafeEnvPermissions(envPath)) {
      service.status.event("warn", "UNSAFE_ENV_PERMISSIONS", { acl: warning });
      console.warn(`[Mesh Bridge] warning: .env has broad permissions: ${warning}`);
    }
    await service.run();
  } catch (error) {
    console.error(`[Mesh Bridge] fatal: ${reason(error)}`);
    process.exitCode = 1;
  }
}

void main();
