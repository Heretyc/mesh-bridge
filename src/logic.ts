import { escapeMarkdown } from "discord.js";

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
