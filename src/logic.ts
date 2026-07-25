import { PermissionFlagsBits, escapeMarkdown } from "discord.js";

// Firmware adds the encoded Data port and bitfield to text before enforcing the 239-byte encrypted envelope.
export const MESHTASTIC_TEXT_BYTES = 232;
const encoder = new TextEncoder();
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface DiscordRouteInput {
  channelId: string;
  authorBot: boolean;
  webhookId: string | null;
  ordinary: boolean;
  hasBody: boolean;
}

export interface MeshRouteInput {
  portNum: number;
  channel: number;
  from: number;
  destination: "broadcast" | "direct";
}

export interface MeshChannelCandidate {
  index: number;
  role: number;
  name: string;
  psk: Uint8Array;
}

export function resolveEncryptedChannel(channels: MeshChannelCandidate[], configuredName: string): number {
  const matches = channels.filter((channel) => channel.role !== 0 && channel.name === configuredName);
  if (matches.length === 0) throw new Error(`Meshtastic channel named "${configuredName}" was not found`);
  if (matches.length > 1) throw new Error(`Meshtastic channel named "${configuredName}" is ambiguous`);
  const channel = matches[0]!;
  if (channel.index < 0 || channel.index > 7) throw new Error(`Meshtastic channel "${configuredName}" has invalid index ${channel.index}`);
  if (channel.psk.length === 0 || (channel.psk.length === 1 && channel.psk[0] === 0)) {
    throw new Error(`Meshtastic channel "${configuredName}" is not encrypted`);
  }
  return channel.index;
}

// Native replies need history access and mesh tapbacks need reaction access, on top of the two forwarding permissions.
export const REQUIRED_DISCORD_PERMISSIONS: readonly bigint[] = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AddReactions,
];

export function hasRequiredDiscordPermissions(permissions: { has(bits: bigint[]): boolean } | null | undefined): boolean {
  return permissions?.has([...REQUIRED_DISCORD_PERMISSIONS]) === true;
}

export function shouldForwardDiscord(input: DiscordRouteInput, configuredChannelId: string): boolean {
  return input.channelId === configuredChannelId && !input.authorBot && input.webhookId === null && input.ordinary && input.hasBody;
}

export function shouldForwardMesh(input: MeshRouteInput, configuredChannel: number, localNodeId: number): boolean {
  return input.portNum === 1 && input.channel === configuredChannel && input.from !== localNodeId;
}

export function safeDisplayName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim() || "unknown";
}

export function formatMeshForDiscord(longName: string, text: string): string {
  const escapedName = escapeMarkdown(safeDisplayName(longName)).replaceAll("[", "\\[").replaceAll("]", "\\]");
  return `**[${escapedName}]:** ${text}`;
}

export interface DiscordReactionRouteInput {
  channelId: string;
  reactorBot: boolean;
}

// Reactions are routed like messages: configured channel only, never from a bot. The bot test is also what
// keeps the reactions this bridge adds for mesh tapbacks from looping straight back out to the mesh.
export function shouldForwardDiscordReaction(input: DiscordReactionRouteInput, configuredChannelId: string): boolean {
  return input.channelId === configuredChannelId && !input.reactorBot;
}

const VARIATION_SELECTOR_16 = 0xfe0f;

export interface DiscordReactionEmoji {
  /** Custom emoji id, or null for a Unicode reaction. */
  id: string | null;
  /** The Unicode grapheme for a Unicode reaction, or the custom emoji's name. */
  name: string | null;
}

export function discordReactionDisplay(emoji: DiscordReactionEmoji): string {
  if (!emoji.name) throw new Error("Discord reaction has no usable emoji");
  return emoji.id === null ? emoji.name : `:${emoji.name}:`;
}

/** Strip only the bold wrapper emitted by formatMeshForDiscord, keeping its visible attribution. */
export function visibleDiscordReactionTarget(body: string, bridgeAuthored: boolean): string {
  return bridgeAuthored
    ? body.replace(/^\*\*(\[[^\r\n]+?\]:)\*\*/u, (_wrapper: string, attribution: string) =>
      attribution.replace(/\\([\\`*_\[\]~>|])/gu, "$1"))
    : body;
}

export function formatMappedReactionForMesh(displayName: string, emoji: string): string {
  const text = `${safeDisplayName(displayName)} reacted with ${emoji}`;
  if (byteLength(text) > MESHTASTIC_TEXT_BYTES) throw new Error("Discord reaction text exceeds the Meshtastic payload limit");
  return text;
}

export function formatUnmappedReactionForMesh(displayName: string, emoji: string, body: string): string {
  if (!body.trim()) throw new Error("Discord reaction target has no usable text");
  const graphemes = [...segmenter.segment(body)].map((part) => part.segment);
  const capped = graphemes.slice(0, 40);
  const cappedTruncated = graphemes.length > 40;
  for (let length = capped.length; length >= 0; length -= 1) {
    const shortened = length < capped.length;
    const excerpt = `${capped.slice(0, length).join("")}${cappedTruncated || shortened ? "..." : ""}`;
    const text = `${safeDisplayName(displayName)} reacted ${emoji} to "${excerpt}"`;
    if (byteLength(text) <= MESHTASTIC_TEXT_BYTES) return text;
  }
  throw new Error("Discord reaction attribution leaves no room for a Meshtastic excerpt");
}

export interface MeshTapbackInput {
  emoji: number;
  replyId: number;
}

/** Firmware marks a tapback with a nonzero Data.emoji plus the reply id of the message being tapped. */
export function isMeshTapback(input: MeshTapbackInput): boolean {
  return input.emoji !== 0 && input.replyId !== 0;
}

function printableGrapheme(text: string): boolean {
  return [...text].every((point) => {
    const value = point.codePointAt(0)!;
    return value >= 0x20 && value !== 0x7f;
  });
}

/** Return the decoded single-base emoji payload, never the numeric Data.emoji flag. */
export function meshTapbackEmoji(payload: string): string | undefined {
  const text = payload;
  const points = [...text];
  if (
    printableGrapheme(text)
    && /^\p{Extended_Pictographic}$/u.test(points[0] ?? "")
    && (points.length === 1 || (points.length === 2 && points[1]!.codePointAt(0) === VARIATION_SELECTOR_16))
  ) return text;
  return undefined;
}

export function safeAttachmentName(name: string): string {
  return (name.split(/[\\/]/u).at(-1) ?? "attachment").replace(/[\u0000-\u001f\u007f]/gu, "");
}

export interface DiscordMentionNames {
  /** Guild member display names (nickname when set), keyed by user id. */
  members: ReadonlyMap<string, string>;
  /** Mentioned user display names, keyed by user id; used only when the member name is missing. */
  users: ReadonlyMap<string, string>;
  /** Role names, keyed by role id. */
  roles: ReadonlyMap<string, string>;
}

// Only these three forms are rewritten. Channel (<#id>), slash-command (</name:id>), and custom emoji
// (<:name:id>, <a:name:id>) markup cannot match, because none of them place a digit or "&" after "<@".
const DISCORD_MENTION = /<@!?(\d{1,32})>|<@&(\d{1,32})>/gu;

export function resolveDiscordMentions(content: string, names: DiscordMentionNames): string {
  return content.replace(DISCORD_MENTION, (match: string, userId: string | undefined, roleId: string | undefined) => {
    let name: string | undefined;
    if (userId === undefined) name = names.roles.get(roleId!);
    else name = names.members.get(userId) || names.users.get(userId);
    return name ? `@${name}` : match;
  });
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function splitOnce(body: string, name: string, total: number): string[] {
  const graphemes = [...segmenter.segment(body)].map((part) => part.segment);
  const pieces: string[] = [];
  let start = 0;
  while (start < graphemes.length) {
    const prefix = `[${name}]: (${pieces.length + 1}/${total}) `;
    const capacity = MESHTASTIC_TEXT_BYTES - byteLength(prefix);
    if (capacity < 1) throw new Error("Discord display name leaves no room for Meshtastic text");

    let used = 0;
    let end = start;
    while (end < graphemes.length) {
      const size = byteLength(graphemes[end]!);
      if (used + size > capacity) break;
      used += size;
      end += 1;
    }
    if (end === start) throw new Error("A Unicode grapheme exceeds the Meshtastic payload limit");

    if (end < graphemes.length) {
      for (let boundary = end; boundary > start + 1; boundary -= 1) {
        if (/\s/u.test(graphemes[boundary - 1]!)) {
          end = boundary;
          break;
        }
      }
    }
    pieces.push(graphemes.slice(start, end).join(""));
    start = end;
  }
  return pieces;
}

export function splitDiscordForMesh(displayName: string, body: string): string[] {
  if (!body) return [];
  const name = safeDisplayName(displayName);
  const single = `[${name}]: ${body}`;
  if (byteLength(single) <= MESHTASTIC_TEXT_BYTES) return [single];
  let total = 2;
  for (let pass = 0; pass < 20; pass += 1) {
    const pieces = splitOnce(body, name, total);
    if (pieces.length === total) return pieces.map((piece, index) => `[${name}]: (${index + 1}/${total}) ${piece}`);
    total = pieces.length;
  }
  throw new Error("Could not stabilize Meshtastic chunk numbering");
}

export async function discoverMeshtasticPath(paths: readonly string[], probe: (path: string) => Promise<boolean>): Promise<string> {
  if (paths.length === 0) throw new Error("No USB serial device found; connect a Meshtastic device");
  const matches: string[] = [];
  // ponytail: sequential probing avoids opening unrelated serial devices concurrently; parallelize only if many-port startup latency matters.
  for (const path of paths) if (await probe(path)) matches.push(path);
  if (matches.length === 0) throw new Error(`No Meshtastic device found among USB serial ports (${paths.join(", ")})`);
  if (matches.length > 1) throw new Error(`Multiple Meshtastic devices found (${matches.join(", ")}); connect exactly one`);
  return matches[0]!;
}

export async function retry<T>(operation: () => Promise<T>, retries: number, onRetry?: (attempt: number) => void): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < retries) onRetry?.(attempt + 1);
    }
  }
  throw lastError;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

export function backoff(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));
}

export class TtlDedup {
  private readonly entries = new Map<string, number>();
  public constructor(private readonly ttlMs: number, private readonly limit: number) {}

  public seen(key: string, now = Date.now()): boolean {
    const previous = this.entries.get(key);
    if (previous !== undefined && now - previous < this.ttlMs) return true;
    this.entries.set(key, now);
    for (const [candidate, timestamp] of this.entries) {
      if (now - timestamp >= this.ttlMs || this.entries.size > this.limit) this.entries.delete(candidate);
      else break;
    }
    return false;
  }
}

/** Insertion-ordered, TTL-bounded, capacity-bounded map. Writing a key refreshes both its lifetime and its position. */
export class TtlMap<K, V> {
  private readonly entries = new Map<K, { value: V; at: number }>();
  public constructor(private readonly ttlMs: number, private readonly limit: number) {}

  public set(key: K, value: V, now = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { value, at: now });
    for (const [candidate, entry] of this.entries) {
      if (now - entry.at >= this.ttlMs || this.entries.size > this.limit) this.entries.delete(candidate);
      else break;
    }
  }

  public get(key: K, now = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (now - entry.at >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Non-expired [key,value,at] triples in insertion order. Read-only: no eviction side effects. */
  public liveEntries(now = Date.now()): Array<[K, V, number]> {
    const out: Array<[K, V, number]> = [];
    for (const [key, entry] of this.entries) if (now - entry.at < this.ttlMs) out.push([key, entry.value, entry.at]);
    return out;
  }

  public get size(): number {
    return this.entries.size;
  }
}

/**
 * Bidirectional reply correlation. The first mesh chunk of a Discord message is the canonical reply root,
 * while every chunk maps back to that Discord message so a mesh reply to any chunk threads correctly.
 */
export class ReplyCorrelator {
  public constructor(
    private readonly meshRootByDiscordId: TtlMap<string, number>,
    private readonly discordIdByMeshId: TtlMap<number, string>,
  ) {}

  /** Mesh packet id to quote when relaying a Discord reply, or undefined when the target is unknown or expired. */
  public meshRootFor(discordId: string | undefined, now?: number): number | undefined {
    return discordId === undefined ? undefined : this.meshRootByDiscordId.get(discordId, now);
  }

  /** Discord message id to reply to when relaying a mesh reply, or undefined when the target is unknown or expired. */
  public discordTargetFor(replyId: number, now?: number): string | undefined {
    return replyId === 0 ? undefined : this.discordIdByMeshId.get(replyId, now);
  }

  public recordOutboundChunk(discordId: string, chunkIndex: number, meshPacketId: number, now?: number): void {
    if (meshPacketId === 0) return; // Mesh id 0 means "unset" and must never be correlated.
    this.discordIdByMeshId.set(meshPacketId, discordId, now);
    if (chunkIndex === 0) this.meshRootByDiscordId.set(discordId, meshPacketId, now);
  }

  public recordInbound(meshPacketId: number, discordId: string, now?: number): void {
    if (meshPacketId === 0) return;
    this.discordIdByMeshId.set(meshPacketId, discordId, now);
    this.meshRootByDiscordId.set(discordId, meshPacketId, now);
  }

  /** Point an extra mesh packet id at an already-correlated Discord message, leaving that message's canonical mesh root alone. */
  public aliasMeshPacket(meshPacketId: number, discordId: string, now?: number): void {
    if (meshPacketId === 0) return;
    this.discordIdByMeshId.set(meshPacketId, discordId, now);
  }
}

/** Only the first chunk carries the native reply; continuations are plain sends. */
export function replyIdForChunk(chunkIndex: number, meshRootId: number | undefined): number | undefined {
  return chunkIndex === 0 ? meshRootId : undefined;
}

export class BoundedQueue<T> {
  private readonly items: T[] = [];
  private worker?: (item: T) => Promise<void>;
  private pumping = false;
  private accepting = true;
  private idleWaiters: Array<() => void> = [];

  public constructor(private readonly limit: number, private readonly onDepth: (depth: number) => void) {}

  public start(worker: (item: T) => Promise<void>): void {
    this.worker = worker;
    void this.pump();
  }

  public enqueue(item: T): boolean {
    if (!this.accepting || this.items.length >= this.limit) return false;
    this.items.push(item);
    this.onDepth(this.items.length);
    void this.pump();
    return true;
  }

  public get depth(): number {
    return this.items.length;
  }

  public async drain(timeoutMs: number): Promise<boolean> {
    this.accepting = false;
    if (!this.pumping && this.items.length === 0) return true;
    return Promise.race([
      new Promise<boolean>((resolve) => this.idleWaiters.push(() => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  private async pump(): Promise<void> {
    if (this.pumping || !this.worker) return;
    this.pumping = true;
    try {
      while (this.items.length > 0) {
        const item = this.items.shift()!;
        this.onDepth(this.items.length);
        await this.worker(item);
      }
    } finally {
      this.pumping = false;
      if (this.items.length === 0) this.idleWaiters.splice(0).forEach((resolve) => resolve());
    }
  }
}
