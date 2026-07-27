import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
import { loadConfig, loadEnvironment, reloadChannelPairs, unsafeEnvPermissions, type ChannelPairConfig, type Config } from "./config.js";
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
  type MeshChannelCandidate,
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
import { IpcServer, StatusStore, type StatusSnapshot } from "./status.js";
import { TelemetrySink } from "./telemetry.js";

// Read once from the runtime image so telemetry never carries a hardcoded/duplicated version.
// From the built layout this module is dist/service.js, so ../package.json is the repo-root manifest.
const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

class FatalConfigurationError extends Error {}

interface DiscordJob {
  /** Durable route tag: the originating pair's Discord channel id, so the worker never infers a destination. */
  discordChannelId: string;
  id: string;
  chunks: string[];
  /** Discord message this one natively replies to, resolved to a mesh root only at delivery time. */
  replyToDiscordId: string | undefined;
}

interface DiscordReactionJob {
  discordChannelId: string;
  targetDiscordId: string;
  displayName: string;
  emoji: string;
  targetBody: string;
}

/** Messages and reactions share one outbound queue so global send order, pacing, and ACK retries stay single-threaded. */
type OutboundJob = DiscordJob | DiscordReactionJob;

interface MeshJob {
  discordChannelId: string;
  from: number;
  text: string;
  packetId: number;
  replyId: number;
}

interface MeshTapbackJob {
  discordChannelId: string;
  from: number;
  /** Grapheme handed to the Discord reaction API. */
  emoji: string;
  packetId: number;
  replyId: number;
}

type InboundJob = MeshJob | MeshTapbackJob;

/** Per-pair state: config plus this pair's own journal, correlator, resolved Discord handle, and resolved mesh index. */
interface PairState extends ChannelPairConfig {
  journal: ChannelJournal;
  replies: ReplyCorrelator;
  discordChannel: SendableChannels | undefined;
  meshChannel: number | undefined;
}

interface MeshSession {
  device: MeshDevice;
  /** Names resolved against this device's channel list; installed into pairsByMeshChannel only on activation. */
  resolvedPairs: Array<[number, PairState]>;
  localNode: number;
  disconnected: Promise<void>;
  activate: () => void;
  close: () => Promise<void>;
}

const allowedMentions = { parse: [] as never[], repliedUser: false };

// Operator-visible notice for a fully failed reaction delivery; hoisted so the
// format-failure and ACK-failure branches cannot drift on its text.
const REACTION_DELIVERY_FAILED_NOTICE = "Mesh Bridge: reaction delivery failed; 0/1 packets acknowledged.";

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

/**
 * Resolve every configured pair against a device's channel candidates. Pure: touches no serial port, no I/O, no class
 * state — exported so the spec's collision and pending semantics can be unit-tested without opening a device.
 *
 * Pairs are processed in iteration (config array) order. A name absent from the device list (`resolveEncryptedChannel`
 * throws "was not found") leaves its pair PENDING — it is simply omitted from the result and receives no Mesh->Discord
 * traffic. Two names resolving to the SAME device index is an immediate startup failure with the spec's exact message,
 * where the earlier config-order name is the `owner` named first. Every other `resolveEncryptedChannel` failure
 * (ambiguous / not encrypted / invalid index) is re-thrown unchanged so it stays FATAL.
 */
export function resolveChannelPairs<T extends { meshtasticChannelName: string }>(
  pairs: Iterable<T>,
  channels: MeshChannelCandidate[],
): Array<[number, T]> {
  const resolvedPairs: Array<[number, T]> = [];
  const ownerByIndex = new Map<number, T>();
  for (const pair of pairs) {
    let index: number;
    try {
      index = resolveEncryptedChannel(channels, pair.meshtasticChannelName);
    } catch (error) {
      if (/was not found/i.test(reason(error))) continue; // pending: name absent from this device's channel list
      throw error; // ambiguous / invalid index / unencrypted remain fatal (converted by the caller's outer catch)
    }
    const owner = ownerByIndex.get(index);
    if (owner !== undefined) {
      throw new FatalConfigurationError(
        `Meshtastic channel name collision: ${JSON.stringify(owner.meshtasticChannelName)} and ${JSON.stringify(pair.meshtasticChannelName)} both resolve to device channel index ${index}`,
      );
    }
    ownerByIndex.set(index, pair);
    resolvedPairs.push([index, pair]);
  }
  return resolvedPairs;
}

/**
 * Names of every configured pair that did NOT resolve to a device channel (pending). Pure counterpart to
 * resolveChannelPairs, exported so the loud-alert set can be unit-tested without opening a device: given the
 * configured pairs and the resolved subset, it returns the meshtastic channel names left unresolved, in config
 * order. Membership is by object identity — resolveChannelPairs returns the same pair references it was handed.
 */
export function unresolvedMeshChannelNames<T extends { meshtasticChannelName: string }>(
  configured: Iterable<T>,
  resolved: Array<[number, T]>,
): string[] {
  const resolvedPairs = new Set(resolved.map(([, pair]) => pair));
  const names: string[] = [];
  for (const pair of configured) {
    if (!resolvedPairs.has(pair)) names.push(pair.meshtasticChannelName);
  }
  return names;
}

// Durability policy: one misconfigured channel never stops the service — it degrades gracefully and alerts
// loudly. A configured pair that cannot be wired is re-checked, and its error re-logged, on this cadence until
// it recovers (mesh: a name absent from the device; discord: an unresolvable channel id) — every two minutes.
const CHANNEL_ALERT_INTERVAL_MS = 120_000;

// One shared wall-clock budget for draining BOTH outbound queues on shutdown while the Discord and Mesh
// transports are still alive. Kept under WinSW's 20s stoptimeout so the drain plus the transport teardown
// that follows it still complete before the service manager force-kills the process.
const SHUTDOWN_DRAIN_MS = 15_000;

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
  // Two distinct signals. `stopping` begins a graceful shutdown: it unblocks the reconnect loops so they
  // return WITHOUT tearing down their live transport, leaving Discord and Mesh alive for the drain. `abort`
  // is the hard transport/delivery kill, fired only after the drain completes (or a fatal error), so that
  // work already accepted is delivered during shutdown instead of being cancelled the instant a stop begins.
  private readonly stopping = new AbortController();
  private readonly abort = new AbortController();
  private readonly ipc: IpcServer;
  private readonly discordToMesh: BoundedQueue<OutboundJob>;
  private readonly meshToDiscord: BoundedQueue<InboundJob>;
  private readonly discordDedup: TtlDedup;
  private readonly meshDedup: TtlDedup;
  private readonly pairsByDiscordId = new Map<string, PairState>();
  private readonly pairsByMeshChannel = new Map<number, PairState>();
  /** Discord channel ids whose journal is currently degraded; aggregate flag clears only when this empties. */
  private readonly journalDegradedIds = new Set<string>();
  private nodeNames = new Map<number, string>();
  private discord: Client | undefined;
  private mesh: MeshSession | undefined;
  private readonly telemetry: TelemetrySink;
  private lastMeshSend = 0;
  /** Meshtastic channel names configured but absent from the current device (pending); alerted until they resolve. */
  private readonly meshUnresolved = new Set<string>();
  private meshUnresolvedTimer: NodeJS.Timeout | undefined;

  public constructor(private readonly config: Config) {
    this.ipc = new IpcServer(config.ipcPort, config.ipcToken, this.status, () => this.stopping.abort(new Error("IPC_SHUTDOWN")));
    this.telemetry = new TelemetrySink({
      logFile: join(logDir(), "telemetry.jsonl"),
      secrets: [config.discordToken, config.ipcToken],
      resource: {
        "service.name": "mesh-bridge",
        "service.version": packageVersion,
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
    // One journal + correlator per configured pair; never shared. Degradation is tracked per Discord id so
    // one recovered journal cannot clear the aggregate flag while another journal is still failing.
    for (const pair of config.channels) {
      const journal = new ChannelJournal(pair.discordChannelId, {
        onDegraded: (error) => {
          this.journalDegradedIds.add(pair.discordChannelId);
          this.status.journalDegraded(true, "JOURNAL_WRITE_FAILED", { error: String(error), discordChannelId: pair.discordChannelId });
          process.stderr.write("[Mesh Bridge] warning: reply mapping journal writes failed; continuing with in-memory reply correlation\n");
        },
        onRecovered: () => {
          this.journalDegradedIds.delete(pair.discordChannelId);
          if (this.journalDegradedIds.size === 0) this.status.journalDegraded(false, "JOURNAL_WRITE_RECOVERED");
        },
      });
      this.pairsByDiscordId.set(pair.discordChannelId, {
        discordChannelId: pair.discordChannelId,
        meshtasticChannelName: pair.meshtasticChannelName,
        journal,
        replies: new ReplyCorrelator(journal.meshRootByDiscordId, journal.discordIdByMeshId),
        discordChannel: undefined,
        meshChannel: undefined,
      });
    }
    this.status.connection({ channelPairs: this.channelPairsStatus() });
    this.discordToMesh = new BoundedQueue(config.queueLimit, (depth) => this.status.queue("discordToMesh", depth));
    this.meshToDiscord = new BoundedQueue(config.queueLimit, (depth) => this.status.queue("meshToDiscord", depth));
  }

  /** Every configured pair with its current resolved mesh index (null = pending), for the status payload. */
  private channelPairsStatus(): StatusSnapshot["connections"]["channelPairs"] {
    return [...this.pairsByDiscordId.values()].map((pair) => ({
      discordChannelId: pair.discordChannelId,
      meshtasticChannelName: pair.meshtasticChannelName,
      meshChannelIndex: pair.meshChannel ?? null,
    }));
  }

  public async run(): Promise<void> {
    process.once("SIGINT", () => this.stopping.abort(new Error("SIGINT")));
    process.once("SIGTERM", () => this.stopping.abort(new Error("SIGTERM")));
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
      // A fatal error is a hard stop, not a graceful drain: unblock the loops AND kill transports at once so
      // the shutdown drain (which sees an already-aborted signal) returns immediately rather than waiting.
      this.stopping.abort(error);
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
    while (!this.stopping.signal.aborted) {
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

      let channelRetry: NodeJS.Timeout | undefined;
      try {
        const ready = this.waitForDiscordReady(client);
        await Promise.all([client.login(this.config.discordToken), ready]);
        if (client.user?.username !== "Mesh Bridge") {
          throw new FatalConfigurationError(`Discord bot username must be exactly "Mesh Bridge"; found "${client.user?.username ?? "unknown"}"`);
        }
        // Durability policy: resolve every configured Discord channel independently. A channel-level failure
        // (Unknown Channel, Missing Access, not sendable, missing permissions) is NEVER fatal — the channels
        // that resolve are wired and bridge immediately, while each broken one is re-attempted every two
        // minutes from a fresh read of config.jsonc so an operator can correct a bad id without a restart.
        // Only an invalid token stays fatal. Handles are committed only after the pass, so a fatal mid-pass
        // never leaves a half-populated routing table behind a client about to be destroyed.
        const resolved: Array<[PairState, SendableChannels]> = [];
        const broken: PairState[] = [];
        for (const pair of this.pairsByDiscordId.values()) {
          try {
            resolved.push([pair, await this.resolveDiscordChannel(client, pair.discordChannelId)]);
          } catch (error) {
            if (/invalid token/i.test(reason(error))) throw error;
            broken.push(pair);
            this.status.event("error", "DISCORD_CHANNEL_UNRESOLVED", { discordChannelId: pair.discordChannelId, reason: reason(error) });
          }
        }
        for (const [pair, channel] of resolved) pair.discordChannel = channel;
        this.discord = client;
        this.status.link("discord", "online");
        this.status.event("info", "DISCORD_CONNECTED", { resolved: resolved.length, broken: broken.length });
        attempt = 0;
        if (broken.length > 0) channelRetry = this.startDiscordChannelRetry(client, broken);
        await Promise.race([invalid, abortPromise(this.stopping.signal)]);
      } catch (error) {
        if (error instanceof FatalConfigurationError || /invalid token/i.test(reason(error))) throw error;
        if (!this.stopping.signal.aborted) {
          this.status.link("discord", "error");
          this.status.event("error", "DISCORD_CONNECT_FAILED", { reason: reason(error), retryMs: backoff(attempt) });
        }
      } finally {
        if (channelRetry !== undefined) clearInterval(channelRetry);
        // On a graceful stop leave the live client intact so shutdown() can drain outbound work through it and
        // destroy it only afterwards; on a reconnect (or a non-live client mid-connect) tear it down as usual.
        if (!(this.stopping.signal.aborted && this.discord === client)) {
          if (this.discord === client) {
            this.discord = undefined;
            for (const pair of this.pairsByDiscordId.values()) pair.discordChannel = undefined;
          }
          client.destroy();
        }
      }
      if (!this.stopping.signal.aborted) await delay(backoff(attempt++), this.stopping.signal);
    }
  }

  // Fetch and validate one configured Discord channel. Throws a plain Error (channel-level, non-fatal) whose
  // message names the id when the channel is missing, not a sendable server channel, or missing the bridge's
  // required permissions; the caller keeps every other working channel bridging and retries this one.
  private async resolveDiscordChannel(client: Client, discordChannelId: string): Promise<SendableChannels> {
    const channel = await client.channels.fetch(discordChannelId);
    if (!channel || !channel.isSendable() || channel.isDMBased()) {
      throw new Error(`Discord channel ${JSON.stringify(discordChannelId)} is not a sendable server channel visible to Mesh Bridge`);
    }
    // client.user is non-null here: this runs only after login + the "Mesh Bridge" username check succeed.
    if (!hasRequiredDiscordPermissions(channel.permissionsFor(client.user!))) {
      throw new Error(`Mesh Bridge needs View Channel, Send Messages, Read Message History, and Add Reactions in Discord channel ${JSON.stringify(discordChannelId)}`);
    }
    return channel;
  }

  // Re-attempt every unresolved Discord channel every two minutes for as long as the client stays up. Each pass
  // re-reads config.jsonc so a corrected id is honored live; the loud DISCORD_CHANNEL_UNRESOLVED error repeats
  // per still-broken channel until it recovers. The interval is unref'd and cleared when the client tears down.
  private startDiscordChannelRetry(client: Client, broken: PairState[]): NodeJS.Timeout {
    let pending = [...broken];
    let running = false;
    const timer = setInterval(() => {
      if (running) return; // never overlap a slow pass with the next tick
      running = true;
      void (async () => {
        const stillBroken: PairState[] = [];
        for (const pair of pending) {
          if (this.discord !== client) return; // client torn down mid-pass; stop touching its handles
          if (!(await this.retryDiscordChannel(client, pair))) stillBroken.push(pair);
        }
        pending = stillBroken;
        if (pending.length === 0) clearInterval(timer);
      })().finally(() => { running = false; });
    }, CHANNEL_ALERT_INTERVAL_MS);
    timer.unref();
    return timer;
  }

  // One retry attempt for a single broken pair. Re-reads config.jsonc so an operator's corrected id (matched by
  // the stable meshtastic name) is picked up without a restart; on success wires the handle, re-keys the routing
  // map if the id changed, and logs recovery. Never throws — a failed attempt just re-logs the loud error.
  private async retryDiscordChannel(client: Client, pair: PairState): Promise<boolean> {
    let desiredId = pair.discordChannelId;
    try {
      const fresh = reloadChannelPairs().find((entry) => entry.meshtasticChannelName === pair.meshtasticChannelName);
      if (fresh !== undefined) desiredId = fresh.discordChannelId;
    } catch (error) {
      this.status.event("error", "DISCORD_CONFIG_RELOAD_FAILED", { discordChannelId: pair.discordChannelId, reason: reason(error) });
    }
    try {
      const channel = await this.resolveDiscordChannel(client, desiredId);
      if (desiredId !== pair.discordChannelId && !this.pairsByDiscordId.has(desiredId)) {
        this.pairsByDiscordId.delete(pair.discordChannelId);
        pair.discordChannelId = desiredId;
        this.pairsByDiscordId.set(desiredId, pair);
      }
      pair.discordChannel = channel;
      this.status.event("info", "DISCORD_CHANNEL_RESOLVED", { discordChannelId: pair.discordChannelId });
      return true;
    } catch (error) {
      this.status.event("error", "DISCORD_CHANNEL_UNRESOLVED", { discordChannelId: desiredId, reason: reason(error) });
      return false;
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
      this.stopping.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(this.stopping.signal.reason);
      }, { once: true });
    });
  }

  private async handleDiscordMessage(message: Message): Promise<void> {
    // Route by channel id before any body work: an unconfigured channel is ignored outright.
    const pair = this.pairsByDiscordId.get(message.channelId);
    if (pair === undefined) return;
    // Resolve mentions before attachments and chunking so the substituted names are charged to the 232-byte ceiling.
    const body = discordMessageBody(message);
    const ordinary = message.type === MessageType.Default || message.type === MessageType.Reply;
    if (!shouldForwardDiscord({
      channelId: message.channelId,
      authorBot: message.author.bot,
      webhookId: message.webhookId,
      ordinary,
      hasBody: body.length > 0,
    }, pair.discordChannelId)) return;
    if (this.discordDedup.seen(`discord:${pair.discordChannelId}:${message.id}`)) return;

    this.status.count("discordReceived");
    this.telemetry.logMessageBody("discord->mesh", body, { discordId: message.id });
    const displayName = message.member?.displayName ?? message.author.globalName ?? message.author.username;
    const job: DiscordJob = {
      discordChannelId: pair.discordChannelId,
      id: message.id,
      chunks: splitDiscordForMesh(displayName, body),
      replyToDiscordId: message.reference?.messageId,
    };
    if (!this.discordToMesh.enqueue(job)) {
      this.status.count("rejected");
      this.status.event("error", "DISCORD_TO_MESH_QUEUE_FULL", { discordId: message.id });
      await this.reportDiscord(pair.discordChannelId, "Mesh Bridge: message was not queued because the mesh queue is full.");
    }
  }

  private async handleDiscordReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    // Reject other channels before resolving partials, but fetch a partial user before trusting its bot identity.
    const pair = this.pairsByDiscordId.get(reaction.message.channelId);
    if (pair === undefined) return;
    const reactor = user.partial ? await user.fetch() : user;
    if (!shouldForwardDiscordReaction({
      channelId: reaction.message.channelId,
      reactorBot: reactor.bot,
    }, pair.discordChannelId)) return;

    const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
    const message = fullReaction.message.partial ? await fullReaction.message.fetch() : fullReaction.message;
    const fallbackName = reactor.globalName ?? reactor.username;
    const displayName = await message.guild?.members.fetch(reactor.id)
      .then((member) => member.displayName)
      .catch(() => fallbackName) ?? fallbackName;

    this.status.count("discordReceived");
    const job: DiscordReactionJob = {
      discordChannelId: pair.discordChannelId,
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
      await this.reportDiscord(pair.discordChannelId, "Mesh Bridge: reaction was not queued because the mesh queue is full.");
    }
  }

  private async deliverDiscordToMesh(job: DiscordJob): Promise<void> {
    const pair = this.pairsByDiscordId.get(job.discordChannelId);
    if (pair === undefined) return;
    // Resolved at delivery time so FIFO ordering decides whether the target has been correlated yet.
    const meshRoot = pair.replies.meshRootFor(job.replyToDiscordId);
    if (job.replyToDiscordId !== undefined && meshRoot === undefined) {
      this.status.event("warn", "REPLY_TARGET_UNAVAILABLE", { direction: "discordToMesh", referencedId: job.replyToDiscordId });
    }
    let delivered = 0;
    // The loop index, not the delivered count, decides the reply root: chunk 1 is the only chunk that quotes it.
    for (const [index, chunk] of job.chunks.entries()) {
      try {
        const packetId = await retry(async () => {
          // Re-resolve the job's own pair each attempt so a reconnect that changes the session or index is honored.
          const { session, channel } = await this.waitForMesh(job.discordChannelId);
          await this.waitForMeshSendSlot();
          return Promise.race([
            session.device.sendText(chunk, "broadcast", true, channel as Types.ChannelNumber, replyIdForChunk(index, meshRoot)),
            session.disconnected.then<never>(() => Promise.reject(new Error("Meshtastic disconnected before ACK"))),
            delay(65_000, this.abort.signal).then<never>(() => Promise.reject(new Error("Meshtastic ACK timeout"))),
          ]);
        }, this.config.ackRetries, () => {
          this.status.count("retries");
          this.status.event("warn", "MESH_SEND_RETRY", { discordId: job.id, chunk: index + 1 });
        });
        // Every chunk maps back to the Discord message; only chunk 1 becomes that message's canonical mesh root.
        pair.replies.recordOutboundChunk(job.id, index, packetId);
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
        await this.reportDiscord(job.discordChannelId, `Mesh Bridge: mesh delivery ${kind}; ${delivered}/${job.chunks.length} chunks acknowledged.`);
        return;
      }
    }
  }

  private async deliverDiscordReactionToMesh(job: DiscordReactionJob): Promise<void> {
    const pair = this.pairsByDiscordId.get(job.discordChannelId);
    if (pair === undefined) return;
    // Resolve at delivery time so a just-queued bridge message can establish its ACKed root first.
    const meshRoot = pair.replies.meshRootFor(job.targetDiscordId);
    let text: string;
    try {
      text = meshRoot === undefined
        ? formatUnmappedReactionForMesh(job.displayName, job.emoji, job.targetBody)
        : formatMappedReactionForMesh(job.displayName, job.emoji);
    } catch (error) {
      this.status.count("failures");
      this.status.event("error", "MESH_REACTION_FORMAT_FAILED", { referencedId: job.targetDiscordId, reason: reason(error) });
      await this.reportDiscord(job.discordChannelId, REACTION_DELIVERY_FAILED_NOTICE);
      return;
    }

    try {
      const packetId = await retry(async () => {
        const { session, channel } = await this.waitForMesh(job.discordChannelId);
        await this.waitForMeshSendSlot();
        return Promise.race([
          session.device.sendText(text, "broadcast", true, channel as Types.ChannelNumber, meshRoot),
          session.disconnected.then<never>(() => Promise.reject(new Error("Meshtastic disconnected before ACK"))),
          delay(65_000, this.abort.signal).then<never>(() => Promise.reject(new Error("Meshtastic ACK timeout"))),
        ]);
      }, this.config.ackRetries, (attempt) => {
        this.status.count("retries");
        this.status.event("warn", "MESH_REACTION_SEND_RETRY", { referencedId: job.targetDiscordId, attempt });
      });
      pair.replies.aliasMeshPacket(packetId, job.targetDiscordId);
      this.status.count("meshSent");
      this.telemetry.logMessageBody("discord->mesh.reaction", text, { referencedId: job.targetDiscordId, targetBody: job.targetBody, packetId });
    } catch {
      if (this.abort.signal.aborted) return;
      this.status.count("failures");
      this.status.event("error", "MESH_REACTION_DELIVERY_FAILED", { delivered: 0, total: 1 });
      await this.reportDiscord(job.discordChannelId, REACTION_DELIVERY_FAILED_NOTICE);
    }
  }

  private async waitForMeshSendSlot(): Promise<void> {
    const remaining = this.lastMeshSend + this.config.sendIntervalMs - Date.now();
    if (remaining > 0) await delay(remaining, this.abort.signal);
    this.lastMeshSend = Date.now();
  }

  private async meshLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopping.signal.aborted) {
      this.status.link("meshtastic", "connecting");
      try {
        const session = await this.openMesh();
        this.mesh = session;
        this.status.link("meshtastic", "online");
        this.status.event("info", "MESHTASTIC_CONNECTED", { channels: session.resolvedPairs.map(([index]) => index) });
        // Durability policy: a name absent from this device leaves its pair pending, never stops the service.
        // Alert loudly for each unresolved name and keep re-alerting every two minutes until it recovers.
        this.reconcileMeshResolution(session.resolvedPairs);
        attempt = 0;
        await Promise.race([session.disconnected, abortPromise(this.stopping.signal)]);
      } catch (error) {
        if (error instanceof FatalConfigurationError) throw error;
        if (!this.stopping.signal.aborted) {
          this.status.link("meshtastic", "error");
          this.status.event("error", "MESHTASTIC_CONNECT_FAILED", { reason: reason(error), retryMs: backoff(attempt) });
        }
      } finally {
        // On a graceful stop leave the live session intact so shutdown() can drain outbound sends through it and
        // close it only afterwards; on a reconnect (or when no session came up) tear the routing down as usual.
        if (!(this.stopping.signal.aborted && this.mesh !== undefined)) {
          const session = this.mesh;
          this.mesh = undefined;
          if (session) await session.close().catch(() => undefined);
          // Tear down mesh->discord routing but keep every configured pair row, now shown as pending.
          this.pairsByMeshChannel.clear();
          for (const pair of this.pairsByDiscordId.values()) pair.meshChannel = undefined;
          // The whole session is gone (a separate meshtastic link alert covers that), so stop the per-name
          // unresolved alerting; the next successful connect reconciles and re-alerts any still-missing name.
          this.stopMeshResolutionAlerts();
          this.status.connection({ serialPort: "-", localNode: "-", channelPairs: this.channelPairsStatus() });
        }
      }
      if (!this.stopping.signal.aborted) await delay(backoff(attempt++), this.stopping.signal);
    }
  }

  // Compare the configured pairs against what resolved on the live device. Names newly missing raise one loud
  // MESH_CHANNEL_UNRESOLVED error; names that came back raise MESH_CHANNEL_RESOLVED. While any name is missing a
  // two-minute interval re-raises the loud error so a lingering misconfiguration cannot go quiet.
  private reconcileMeshResolution(resolvedPairs: Array<[number, PairState]>): void {
    const pending = unresolvedMeshChannelNames(this.pairsByDiscordId.values(), resolvedPairs);
    const pendingSet = new Set(pending);
    for (const name of this.meshUnresolved) {
      if (!pendingSet.has(name)) this.status.event("info", "MESH_CHANNEL_RESOLVED", { meshtasticChannelName: name });
    }
    const newlyBroken = pending.filter((name) => !this.meshUnresolved.has(name));
    this.meshUnresolved.clear();
    for (const name of pending) this.meshUnresolved.add(name);
    if (newlyBroken.length > 0) {
      this.status.event("error", "MESH_CHANNEL_UNRESOLVED", { meshtasticChannelNames: newlyBroken });
    }
    if (this.meshUnresolved.size === 0) {
      this.clearMeshUnresolvedTimer();
    } else if (this.meshUnresolvedTimer === undefined) {
      this.meshUnresolvedTimer = setInterval(() => {
        this.status.event("error", "MESH_CHANNEL_UNRESOLVED", { meshtasticChannelNames: [...this.meshUnresolved], repeat: true });
      }, CHANNEL_ALERT_INTERVAL_MS);
      this.meshUnresolvedTimer.unref();
    }
  }

  // Silence the mesh unresolved-channel alerting (session gone or service stopping); no recovery log is emitted.
  private stopMeshResolutionAlerts(): void {
    this.clearMeshUnresolvedTimer();
    this.meshUnresolved.clear();
  }

  private clearMeshUnresolvedTimer(): void {
    if (this.meshUnresolvedTimer !== undefined) {
      clearInterval(this.meshUnresolvedTimer);
      this.meshUnresolvedTimer = undefined;
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
      const candidates = channels.map((entry) => ({
        index: entry.index,
        role: entry.role,
        name: entry.settings?.name ?? "",
        psk: entry.settings?.psk ?? new Uint8Array(),
      }));
      // Resolve every configured pair against this device. A name absent from the device leaves its pair
      // pending (no Mesh->Discord traffic); two names sharing one index is an immediate startup failure.
      // The resolution is a pure function (unit-tested in service.test.ts); the outer catch still converts
      // ambiguous / not-encrypted / invalid-index errors it re-throws into FatalConfigurationError.
      const resolvedPairs = resolveChannelPairs(this.pairsByDiscordId.values(), candidates);
      const session: MeshSession = {
        device,
        resolvedPairs,
        localNode,
        disconnected,
        activate: () => {
          this.nodeNames = nodeNames;
          // Install routing BEFORE draining the startup buffer so pre-activation packets route, not drop.
          for (const [index, pair] of resolvedPairs) {
            pair.meshChannel = index;
            this.pairsByMeshChannel.set(index, pair);
          }
          routePacket = (packet) => this.handleMeshPacket(packet, session);
          pending.splice(0).forEach(routePacket);
          device.setHeartbeatInterval(300_000);
          this.status.connection({
            serialPort: serialPath,
            localNode: `!${localNode.toString(16).padStart(8, "0")}`,
            channelPairs: this.channelPairsStatus(),
          });
        },
        close: async () => {
          const graceful = device.disconnect().catch(() => undefined);
          await Promise.race([graceful, delay(1_000)]);
          // serial disconnect can hang; don't let it eat the stop budget.
          let timer: NodeJS.Timeout | undefined;
          const deadline = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 3_000);
            timer.unref();
          });
          await Promise.race([transport.disconnect().catch(() => undefined), deadline]);
          clearTimeout(timer);
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
    // Route by mesh channel index before decode or dedup: an unconfigured/pending index is ignored.
    const pair = this.pairsByMeshChannel.get(packet.channel);
    if (pair === undefined) return;
    if (packet.payloadVariant.case !== "decoded") return;
    const data = packet.payloadVariant.value;
    if (!shouldForwardMesh({
      portNum: data.portnum,
      channel: packet.channel,
      from: packet.from,
      destination: packet.to === Constants.broadcastNum ? "broadcast" : "direct",
    }, packet.channel, session.localNode)) return;
    // Dedup keys carry the pair's Discord id so the same packet id on two mesh channels never collides.
    const fallback = createHash("sha256").update(data.payload).digest("hex").slice(0, 16);
    const dedupKey = packet.id === 0
      ? `mesh:${pair.discordChannelId}:${packet.from}:0:${packet.rxTime}:${fallback}`
      : `mesh:${pair.discordChannelId}:${packet.from}:${packet.id}`;
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
      if (!this.meshToDiscord.enqueue({ discordChannelId: pair.discordChannelId, from: packet.from, emoji, packetId: packet.id, replyId: data.replyId })) {
        this.status.count("rejected");
        this.status.event("error", "MESH_TO_DISCORD_QUEUE_FULL", { from: packet.from, packetId: packet.id, kind: "reaction" });
      }
      return;
    }
    this.telemetry.logMessageBody("mesh->discord", text, { from: packet.from, packetId: packet.id, replyId: data.replyId });
    if (!this.meshToDiscord.enqueue({ discordChannelId: pair.discordChannelId, from: packet.from, text, packetId: packet.id, replyId: data.replyId })) {
      this.status.count("rejected");
      this.status.event("error", "MESH_TO_DISCORD_QUEUE_FULL", { from: packet.from, packetId: packet.id });
    }
  }

  private async deliverMeshToDiscord(job: MeshJob): Promise<void> {
    const pair = this.pairsByDiscordId.get(job.discordChannelId);
    if (pair === undefined) return;
    const channel = await this.waitForDiscord(job.discordChannelId);
    const name = this.nodeNames.get(job.from) ?? `Unknown !${job.from.toString(16).padStart(8, "0")}`;
    const target = pair.replies.discordTargetFor(job.replyId);
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
      pair.replies.recordInbound(job.packetId, sent.id);
      this.status.count("discordSent");
      this.telemetry.logMessageBody("mesh->discord", content, { from: job.from, packetId: job.packetId, discordId: sent.id });
    } catch (error) {
      if (this.abort.signal.aborted) return;
      this.status.count("failures");
      this.status.event("error", "DISCORD_DELIVERY_FAILED", { from: job.from });
    }
  }

  private async deliverMeshTapbackToDiscord(job: MeshTapbackJob): Promise<void> {
    const pair = this.pairsByDiscordId.get(job.discordChannelId);
    if (pair === undefined) return;
    const target = pair.replies.discordTargetFor(job.replyId);
    if (target === undefined) {
      this.status.count("failures");
      this.status.event("error", "DISCORD_REACTION_TARGET_UNAVAILABLE", { direction: "meshToDiscord", referencedId: job.replyId });
      return;
    }
    // A reply to this tapback packet should still thread onto the message that was reacted to.
    pair.replies.aliasMeshPacket(job.packetId, target);
    try {
      const channel = await this.waitForDiscord(job.discordChannelId);
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

  /** Wait for the shared mesh session AND this pair's resolved index; both are required to send Discord->mesh. */
  private async waitForMesh(discordChannelId: string): Promise<{ session: MeshSession; channel: number }> {
    for (;;) {
      const session = this.mesh;
      const meshChannel = this.pairsByDiscordId.get(discordChannelId)?.meshChannel;
      if (session && meshChannel !== undefined) return { session, channel: meshChannel };
      await delay(250, this.abort.signal);
    }
  }

  private async waitForDiscord(discordChannelId: string): Promise<SendableChannels> {
    for (;;) {
      const channel = this.pairsByDiscordId.get(discordChannelId)?.discordChannel;
      if (channel) return channel;
      await delay(250, this.abort.signal);
    }
  }

  private async reportDiscord(discordChannelId: string, content: string): Promise<void> {
    try {
      const channel = await this.waitForDiscord(discordChannelId);
      await channel.send({ content, allowedMentions });
    } catch (error) {
      if (!this.abort.signal.aborted) this.status.event("error", "FAILURE_REPORT_UNDELIVERED", { discordChannelId });
    }
  }

  private async shutdown(drainMs = SHUTDOWN_DRAIN_MS): Promise<void> {
    // (a) Stop ingress and unblock the reconnect loops. `stopping` may already be aborted (a SIGTERM/IPC
    // stop or a fatal error triggered this); firing it again is idempotent. The transport signal is NOT
    // aborted yet, so the delivery workers can keep using the live Discord and Mesh transports below.
    this.stopping.abort(new Error("shutdown"));
    this.clearMeshUnresolvedTimer();
    this.status.event("info", "SERVICE_STOPPING");
    // (b) Drain BOTH outbound queues under ONE shared wall-clock deadline while the transports are still
    // alive, so work already accepted is actually delivered instead of being dropped. A stuck worker cannot
    // outlast the shared deadline, so this is bounded even if a queue never goes idle. When shutdown runs
    // after a fatal error the transport signal is already aborted, so the workers bail and the drains return
    // at once rather than waiting the full budget.
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(() => deadline.abort(), drainMs);
    deadlineTimer.unref();
    try {
      await Promise.all([
        this.discordToMesh.drain(drainMs, deadline.signal),
        this.meshToDiscord.drain(drainMs, deadline.signal),
      ]);
    } finally {
      clearTimeout(deadlineTimer);
    }
    // (c) Only now cancel any in-flight send and tear the transports down. discord.destroy() returns a
    // promise here, so it is awaited alongside the mesh session close and the IPC server close.
    this.abort.abort(new Error("shutdown"));
    await Promise.all([
      this.discord?.destroy() ?? Promise.resolve(),
      this.mesh?.close().catch(() => undefined) ?? Promise.resolve(),
      this.ipc.close(),
    ]);
    // One journal failing to close must not skip the remaining journals or the telemetry close.
    for (const pair of this.pairsByDiscordId.values()) {
      try {
        pair.journal.close();
      } catch (error) {
        this.status.event("error", "JOURNAL_CLOSE_FAILED", { discordChannelId: pair.discordChannelId, reason: reason(error) });
      }
    }
    this.telemetry.close();
  }
}

async function main(): Promise<void> {
  try {
    const envPath = loadEnvironment();
    const config = loadConfig();
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
