import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Constants, MeshDevice, Protobuf, Types } from "@meshtastic/core";
import { TransportNodeSerial } from "@meshtastic/transport-node-serial";
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageType,
  Partials,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type SendableChannels,
  type User,
} from "discord.js";
import { SerialPort } from "serialport";
import { loadEnvironment, parseConfig, unsafeEnvPermissions, type Config } from "./config.js";
import {
  BoundedQueue,
  ReplyCorrelator,
  TtlDedup,
  backoff,
  delay,
  discordReactionDisplay,
  discoverMeshtasticPath,
  formatMappedReactionForMesh,
  formatMeshForDiscord,
  formatUnmappedReactionForMesh,
  hasRequiredDiscordPermissions,
  isMeshTapback,
  meshTapbackEmoji,
  replyIdForChunk,
  resolveDiscordMentions,
  resolveEncryptedChannel,
  retry,
  safeAttachmentName,
  safeDisplayName,
  shouldForwardDiscord,
  shouldForwardDiscordReaction,
  shouldForwardMesh,
  splitDiscordForMesh,
  visibleDiscordReactionTarget,
} from "./logic.js";
import { ChannelJournal } from "./journal.js";
import { logDir } from "./paths.js";
import { meshtasticSerialCandidates } from "./serial.js";
import { IpcServer, StatusStore } from "./status.js";
import { TelemetrySink } from "./telemetry.js";

class FatalConfigurationError extends Error {}

interface DiscordJob {
  id: string;
  chunks: string[];
  /** Discord message this one natively replies to, resolved to a mesh root only at delivery time. */
  replyToDiscordId: string | undefined;
}

interface DiscordReactionJob {
  targetDiscordId: string;
  displayName: string;
  emoji: string;
  targetBody: string;
}

/** Messages and reactions share one outbound queue so global send order, pacing, and ACK retries stay single-threaded. */
type OutboundJob = DiscordJob | DiscordReactionJob;

interface MeshJob {
  from: number;
  text: string;
  packetId: number;
  replyId: number;
}

interface MeshTapbackJob {
  from: number;
  /** Grapheme handed to the Discord reaction API. */
  emoji: string;
  packetId: number;
  replyId: number;
}

type InboundJob = MeshJob | MeshTapbackJob;

interface MeshSession {
  device: MeshDevice;
  channel: number;
  localNode: number;
  disconnected: Promise<void>;
  activate: () => void;
  close: () => Promise<void>;
}

const allowedMentions = { parse: [] as never[], repliedUser: false };

function discordMessageBody(message: Message): string {
  const attachmentNames = message.attachments.map((attachment) => safeAttachmentName(attachment.name));
  const mentionNames = {
    members: new Map(message.mentions.members?.map((member) => [member.id, member.displayName] as const) ?? []),
    users: new Map(message.mentions.users.map((user) => [user.id, user.displayName] as const)),
    roles: new Map(message.mentions.roles.map((role) => [role.id, role.name] as const)),
  };
  return [resolveDiscordMentions(message.content, mentionNames), ...attachmentNames].filter(Boolean).join(" ");
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function disconnectRejectedProbe(transport: TransportNodeSerial): Promise<void> {
  const onUnhandled = (error: unknown): void => {
    if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await transport.disconnect().catch(() => undefined);
    await delay(0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
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
  private readonly discordToMesh: BoundedQueue<OutboundJob>;
  private readonly meshToDiscord: BoundedQueue<InboundJob>;
  private readonly discordDedup: TtlDedup;
  private readonly meshDedup: TtlDedup;
  private readonly journal: ChannelJournal;
  private readonly replies: ReplyCorrelator;
  private nodeNames = new Map<number, string>();
  private discord: Client | undefined;
  private discordChannel: SendableChannels | undefined;
  private mesh: MeshSession | undefined;
  private readonly telemetry: TelemetrySink;
  private lastMeshSend = 0;

  public constructor(private readonly config: Config) {
    this.ipc = new IpcServer(config.ipcPort, config.ipcToken, this.status);
    this.telemetry = new TelemetrySink({
      logFile: join(logDir(), "telemetry.jsonl"),
      secrets: [config.discordToken, config.ipcToken],
      resource: {
        "service.name": "mesh-bridge",
        "service.version": "1.0.0",
        "os.type": process.platform === "win32" ? "windows" : process.platform,
        "host.name": hostname(),
      },
      onWriteError: (error) => {
        this.status.logDegraded(true, "LOG_WRITE_FAILED", { error: String(error) });
        process.stderr.write("[Mesh Bridge] warning: telemetry log writes failed; continuing without disk telemetry\n");
      },
      onWriteRecovered: () => {
        this.status.logDegraded(false, "LOG_WRITE_RECOVERED");
        process.stderr.write("[Mesh Bridge] notice: telemetry log writes recovered\n");
      },
    });
    this.status.useTelemetry(this.telemetry);
    this.discordDedup = new TtlDedup(config.dedupTtlMs, config.queueLimit * 10);
    this.meshDedup = new TtlDedup(config.dedupTtlMs, config.queueLimit * 10);
    this.journal = new ChannelJournal(config.discordChannelId, {
      onDegraded: (error) => {
        this.status.journalDegraded(true, "JOURNAL_WRITE_FAILED", { error: String(error) });
        process.stderr.write("[Mesh Bridge] warning: reply mapping journal writes failed; continuing with in-memory reply correlation\n");
      },
      onRecovered: () => this.status.journalDegraded(false, "JOURNAL_WRITE_RECOVERED"),
    });
    this.replies = new ReplyCorrelator(this.journal.meshRootByDiscordId, this.journal.discordIdByMeshId);
    this.discordToMesh = new BoundedQueue(config.queueLimit, (depth) => this.status.queue("discordToMesh", depth));
    this.meshToDiscord = new BoundedQueue(config.queueLimit, (depth) => this.status.queue("meshToDiscord", depth));
  }

  public async run(): Promise<void> {
    process.once("SIGINT", () => this.abort.abort(new Error("SIGINT")));
    process.once("SIGTERM", () => this.abort.abort(new Error("SIGTERM")));
    await this.ipc.start();
    this.status.event("info", "SERVICE_STARTED", { ipcPort: this.config.ipcPort });

    this.discordToMesh.start((job) => this.deliverOutbound(job).catch((error) => {
      if (!this.abort.signal.aborted) this.status.event("error", "DISCORD_TO_MESH_WORKER_FAILED", { reason: reason(error) });
    }));
    this.meshToDiscord.start((job) => this.deliverInbound(job).catch((error) => {
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

  /** A single worker per direction: reactions reuse the message path's ordering, pacing, and retry budget. */
  private deliverOutbound(job: OutboundJob): Promise<void> {
    return "chunks" in job ? this.deliverDiscordToMesh(job) : this.deliverDiscordReactionToMesh(job);
  }

  private deliverInbound(job: InboundJob): Promise<void> {
    return "text" in job ? this.deliverMeshToDiscord(job) : this.deliverMeshTapbackToDiscord(job);
  }

  private async discordLoop(): Promise<void> {
    let attempt = 0;
    while (!this.abort.signal.aborted) {
      this.status.link("discord", "connecting");
      const client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.GuildMessageReactions,
        ],
        // Reactions arrive for messages this process never cached, so the reaction, its message, and that
        // message's channel are all accepted in partial form and fetched on demand.
        partials: [Partials.Message, Partials.Channel, Partials.Reaction],
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
      // Only additions are bridged: official Meshtastic core and protobufs expose no tapback removal.
      client.on(Events.MessageReactionAdd, (reaction, user) => {
        void this.handleDiscordReaction(reaction, user).catch((error) => {
          this.status.count("failures");
          this.status.event("error", "DISCORD_REACTION_HANDLER_FAILED", { reason: reason(error) });
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
        if (!hasRequiredDiscordPermissions(channel.permissionsFor(client.user))) {
          throw new FatalConfigurationError("Mesh Bridge needs only View Channel, Send Messages, Read Message History, and Add Reactions in DISCORD_CHANNEL_ID");
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
    // Resolve mentions before attachments and chunking so the substituted names are charged to the 232-byte ceiling.
    const body = discordMessageBody(message);
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
    this.telemetry.logMessageBody("discord->mesh", body, { discordId: message.id });
    const displayName = message.member?.displayName ?? message.author.globalName ?? message.author.username;
    const job: DiscordJob = {
      id: message.id,
      chunks: splitDiscordForMesh(displayName, body),
      replyToDiscordId: message.reference?.messageId,
    };
    if (!this.discordToMesh.enqueue(job)) {
      this.status.count("rejected");
      this.status.event("error", "DISCORD_TO_MESH_QUEUE_FULL", { discordId: message.id });
      await this.reportDiscord("Mesh Bridge: message was not queued because the mesh queue is full.");
    }
  }

  private async handleDiscordReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    // Reject other channels before resolving partials, but fetch a partial user before trusting its bot identity.
    if (reaction.message.channelId !== this.config.discordChannelId) return;
    const reactor = user.partial ? await user.fetch() : user;
    if (!shouldForwardDiscordReaction({
      channelId: reaction.message.channelId,
      reactorBot: reactor.bot,
    }, this.config.discordChannelId)) return;

    const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
    const message = fullReaction.message.partial ? await fullReaction.message.fetch() : fullReaction.message;
    const fallbackName = reactor.globalName ?? reactor.username;
    const displayName = await message.guild?.members.fetch(reactor.id)
      .then((member) => member.displayName)
      .catch(() => fallbackName) ?? fallbackName;

    this.status.count("discordReceived");
    const job: DiscordReactionJob = {
      targetDiscordId: message.id,
      displayName,
      emoji: discordReactionDisplay({ id: fullReaction.emoji.id, name: fullReaction.emoji.name }),
      targetBody: visibleDiscordReactionTarget(
        discordMessageBody(message),
        message.author.bot && message.author.username === "Mesh Bridge",
      ),
    };
    if (!this.discordToMesh.enqueue(job)) {
      this.status.count("rejected");
      this.status.event("error", "DISCORD_TO_MESH_QUEUE_FULL", { kind: "reaction", referencedId: message.id });
      await this.reportDiscord("Mesh Bridge: reaction was not queued because the mesh queue is full.");
    }
  }

  private async deliverDiscordToMesh(job: DiscordJob): Promise<void> {
    // Resolved at delivery time so FIFO ordering decides whether the target has been correlated yet.
    const meshRoot = this.replies.meshRootFor(job.replyToDiscordId);
    if (job.replyToDiscordId !== undefined && meshRoot === undefined) {
      this.status.event("warn", "REPLY_TARGET_UNAVAILABLE", { direction: "discordToMesh", referencedId: job.replyToDiscordId });
    }
    let delivered = 0;
    // The loop index, not the delivered count, decides the reply root: chunk 1 is the only chunk that quotes it.
    for (const [index, chunk] of job.chunks.entries()) {
      try {
        const packetId = await retry(async () => {
          const session = await this.waitForMesh();
          await this.waitForMeshSendSlot();
          return Promise.race([
            session.device.sendText(chunk, "broadcast", true, session.channel as Types.ChannelNumber, replyIdForChunk(index, meshRoot)),
            session.disconnected.then<never>(() => Promise.reject(new Error("Meshtastic disconnected before ACK"))),
            delay(65_000, this.abort.signal).then<never>(() => Promise.reject(new Error("Meshtastic ACK timeout"))),
          ]);
        }, this.config.ackRetries, () => {
          this.status.count("retries");
          this.status.event("warn", "MESH_SEND_RETRY", { discordId: job.id, chunk: index + 1 });
        });
        // Every chunk maps back to the Discord message; only chunk 1 becomes that message's canonical mesh root.
        this.replies.recordOutboundChunk(job.id, index, packetId);
        delivered += 1;
        this.status.count("meshSent");
        this.telemetry.logMessageBody("discord->mesh", chunk, { discordId: job.id, chunk: index + 1, packetId });
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

  private async deliverDiscordReactionToMesh(job: DiscordReactionJob): Promise<void> {
    // Resolve at delivery time so a just-queued bridge message can establish its ACKed root first.
    const meshRoot = this.replies.meshRootFor(job.targetDiscordId);
    let text: string;
    try {
      text = meshRoot === undefined
        ? formatUnmappedReactionForMesh(job.displayName, job.emoji, job.targetBody)
        : formatMappedReactionForMesh(job.displayName, job.emoji);
    } catch (error) {
      this.status.count("failures");
      this.status.event("error", "MESH_REACTION_FORMAT_FAILED", { referencedId: job.targetDiscordId, reason: reason(error) });
      await this.reportDiscord("Mesh Bridge: reaction delivery failed; 0/1 packets acknowledged.");
      return;
    }

    try {
      const packetId = await retry(async () => {
        const session = await this.waitForMesh();
        await this.waitForMeshSendSlot();
        return Promise.race([
          session.device.sendText(text, "broadcast", true, session.channel as Types.ChannelNumber, meshRoot),
          session.disconnected.then<never>(() => Promise.reject(new Error("Meshtastic disconnected before ACK"))),
          delay(65_000, this.abort.signal).then<never>(() => Promise.reject(new Error("Meshtastic ACK timeout"))),
        ]);
      }, this.config.ackRetries, (attempt) => {
        this.status.count("retries");
        this.status.event("warn", "MESH_REACTION_SEND_RETRY", { referencedId: job.targetDiscordId, attempt });
      });
      this.replies.aliasMeshPacket(packetId, job.targetDiscordId);
      this.status.count("meshSent");
      this.telemetry.logMessageBody("discord->mesh.reaction", text, { referencedId: job.targetDiscordId, targetBody: job.targetBody, packetId });
    } catch {
      if (this.abort.signal.aborted) return;
      this.status.count("failures");
      this.status.event("error", "MESH_REACTION_DELIVERY_FAILED", { delivered: 0, total: 1 });
      await this.reportDiscord("Mesh Bridge: reaction delivery failed; 0/1 packets acknowledged.");
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
    const candidates = meshtasticSerialCandidates(ports);
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
      await disconnectRejectedProbe(transport);
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
    if (data.emoji !== 0) {
      const emoji = isMeshTapback({ emoji: data.emoji, replyId: data.replyId })
        ? meshTapbackEmoji(text)
        : undefined;
      if (emoji === undefined) {
        this.status.count("rejected");
        this.status.event("error", "MESH_TAPBACK_INVALID", { from: packet.from, packetId: packet.id, referencedId: data.replyId });
        return;
      }
      if (!this.meshToDiscord.enqueue({ from: packet.from, emoji, packetId: packet.id, replyId: data.replyId })) {
        this.status.count("rejected");
        this.status.event("error", "MESH_TO_DISCORD_QUEUE_FULL", { from: packet.from, packetId: packet.id, kind: "reaction" });
      }
      return;
    }
    this.telemetry.logMessageBody("mesh->discord", text, { from: packet.from, packetId: packet.id, replyId: data.replyId });
    if (!this.meshToDiscord.enqueue({ from: packet.from, text, packetId: packet.id, replyId: data.replyId })) {
      this.status.count("rejected");
      this.status.event("error", "MESH_TO_DISCORD_QUEUE_FULL", { from: packet.from, packetId: packet.id });
    }
  }

  private async deliverMeshToDiscord(job: MeshJob): Promise<void> {
    const channel = await this.waitForDiscord();
    const name = this.nodeNames.get(job.from) ?? `Unknown !${job.from.toString(16).padStart(8, "0")}`;
    const target = this.replies.discordTargetFor(job.replyId);
    if (job.replyId !== 0 && target === undefined) {
      this.status.event("warn", "REPLY_TARGET_UNAVAILABLE", { direction: "meshToDiscord", referencedId: job.replyId });
    }
    try {
      const content = formatMeshForDiscord(name, job.text);
      const sent = await channel.send({
        content,
        allowedMentions,
        ...(target === undefined ? {} : { reply: { messageReference: target, failIfNotExists: false } }),
      });
      // failIfNotExists silently drops the reference when the target is gone; surface that as unthreaded.
      if (target !== undefined && sent.reference?.messageId !== target) {
        this.status.event("warn", "REPLY_TARGET_UNAVAILABLE", { direction: "meshToDiscord", referencedId: job.replyId });
      }
      this.replies.recordInbound(job.packetId, sent.id);
      this.status.count("discordSent");
      this.telemetry.logMessageBody("mesh->discord", content, { from: job.from, packetId: job.packetId, discordId: sent.id });
    } catch (error) {
      if (this.abort.signal.aborted) return;
      this.status.count("failures");
      this.status.event("error", "DISCORD_DELIVERY_FAILED", { from: job.from });
    }
  }

  private async deliverMeshTapbackToDiscord(job: MeshTapbackJob): Promise<void> {
    const target = this.replies.discordTargetFor(job.replyId);
    if (target === undefined) {
      this.status.count("failures");
      this.status.event("error", "DISCORD_REACTION_TARGET_UNAVAILABLE", { direction: "meshToDiscord", referencedId: job.replyId });
      return;
    }
    // A reply to this tapback packet should still thread onto the message that was reacted to.
    this.replies.aliasMeshPacket(job.packetId, target);
    try {
      const channel = await this.waitForDiscord();
      const message = await channel.messages.fetch(target);
      await message.react(job.emoji);
      this.status.count("discordSent");
      this.telemetry.logMessageBody("mesh->discord.reaction", job.emoji, { from: job.from, packetId: job.packetId, referencedId: job.replyId, discordId: target });
    } catch {
      if (this.abort.signal.aborted) return;
      this.status.count("failures");
      this.status.event("error", "DISCORD_REACTION_DELIVERY_FAILED", { from: job.from, referencedId: job.replyId });
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
    this.journal.close();
    this.telemetry.close();
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

// Only `node dist/service.js` runs the bridge; importing this module must not open the radio or Discord.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
