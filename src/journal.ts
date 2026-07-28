import { join } from "node:path";
import { TtlMap } from "./logic.js";
import { appendJsonl, atomicReplaceFile, readJsonlTolerant } from "./jsonl.js";
import { ensureDir, journalDir } from "./paths.js";
import { scheduleDailyLocal, type DailyTask } from "./schedule.js";

export const JOURNAL_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const JOURNAL_LIMIT = 10_000;
export const JOURNAL_COMPACT_HOUR = 2;

const CHANNEL_ID = /^\d{17,20}$/u;

export type JournalDirection = "meshRootByDiscordId" | "discordIdByMeshId";

export type JournalRecord =
  | { dir: "meshRootByDiscordId"; k: string; v: number; at: number }
  | { dir: "discordIdByMeshId"; k: number; v: string; at: number };

type Writer = (path: string, record: unknown) => void;
type Replacer = (path: string, data: string | Buffer) => void;
type Reader = (path: string) => unknown[];

export interface JournalOptions {
  now?: () => number;
  onDegraded?: (error: unknown) => void;
  onRecovered?: () => void;
  append?: Writer;
  replace?: Replacer;
  read?: Reader;
}

function isRecord(record: unknown): record is JournalRecord {
  if (!record || typeof record !== "object") return false;
  const candidate = record as Partial<JournalRecord>;
  if (candidate.dir === "meshRootByDiscordId") return typeof candidate.k === "string" && typeof candidate.v === "number" && Number.isFinite(candidate.at);
  if (candidate.dir === "discordIdByMeshId") return typeof candidate.k === "number" && typeof candidate.v === "string" && Number.isFinite(candidate.at);
  return false;
}

function line(record: JournalRecord): string {
  return JSON.stringify(record);
}

export class JournalWriter {
  private degraded = false;
  public constructor(
    private readonly file: string,
    private readonly append: Writer,
    private readonly replace: Replacer,
    private readonly onDegraded: ((error: unknown) => void) | undefined,
    private readonly onRecovered: (() => void) | undefined,
  ) {}

  public write(record: JournalRecord): void {
    try {
      this.append(this.file, record);
      this.recover();
    } catch (error) {
      this.failOpen(error);
    }
  }

  public rewrite(records: JournalRecord[]): void {
    try {
      this.replace(this.file, records.map(line).join("\n") + (records.length ? "\n" : ""));
      this.recover();
    } catch (error) {
      this.failOpen(error);
    }
  }

  public failOpen(error: unknown): void {
    if (this.degraded) return;
    this.degraded = true;
    this.onDegraded?.(error);
  }

  private recover(): void {
    if (!this.degraded) return;
    this.degraded = false;
    this.onRecovered?.();
  }
}

export class JournaledTtlMap<K extends string | number, V extends string | number> extends TtlMap<K, V> {
  public constructor(
    ttlMs: number,
    limit: number,
    private readonly dir: JournalDirection,
    private readonly writer: JournalWriter,
    private readonly now: () => number,
  ) {
    super(ttlMs, limit);
  }

  public override set(key: K, value: V, now = this.now()): void {
    super.set(key, value, now);
    this.writer.write({ dir: this.dir, k: key, v: value, at: now } as JournalRecord);
  }

  public replay(key: K, value: V, at: number): void {
    super.set(key, value, at);
  }
}

export class ChannelJournal {
  public readonly file: string;
  public readonly meshRootByDiscordId: JournaledTtlMap<string, number>;
  public readonly discordIdByMeshId: JournaledTtlMap<number, string>;
  private readonly timer: DailyTask;
  private readonly now: () => number;
  private readonly writer: JournalWriter;
  private replayed = false;

  public constructor(channelId: string, opts: JournalOptions = {}) {
    if (!CHANNEL_ID.test(channelId)) throw new Error("Discord channel id must be a validated snowflake before journal use");
    this.now = opts.now ?? Date.now;
    this.file = join(journalDir(), `${channelId}.reply-mapping.jsonl`);
    this.writer = new JournalWriter(this.file, opts.append ?? appendJsonl, opts.replace ?? atomicReplaceFile, opts.onDegraded, opts.onRecovered);
    this.meshRootByDiscordId = new JournaledTtlMap<string, number>(JOURNAL_TTL_MS, JOURNAL_LIMIT, "meshRootByDiscordId", this.writer, this.now);
    this.discordIdByMeshId = new JournaledTtlMap<number, string>(JOURNAL_TTL_MS, JOURNAL_LIMIT, "discordIdByMeshId", this.writer, this.now);

    const read = opts.read ?? readJsonlTolerant;
    try {
      ensureDir(journalDir());
      for (const record of read(this.file)) this.replay(record);
      this.replayed = true;
    } catch (error) {
      this.writer.failOpen(error);
    }
    if (this.replayed) this.compact();
    this.timer = scheduleDailyLocal(JOURNAL_COMPACT_HOUR, () => this.compact(), { now: this.now, onError: (error) => this.writer.failOpen(error) });
  }

  public compact(now = this.now()): void {
    // Data-loss guard: never rewrite the on-disk journal until at least one clean
    // replay has populated the in-memory maps. A failed (non-ENOENT) startup read
    // leaves the maps empty but the file still recoverable; compacting here would
    // overwrite that recoverable content with near-empty data. Appends continue
    // fail-open, but compaction stays a no-op while the load is degraded.
    if (!this.replayed) {
      process.stderr.write("[Mesh Bridge] warning: skipping reply mapping journal compaction; on-disk journal was never cleanly replayed (preserving recoverable data)\n");
      return;
    }
    const records: JournalRecord[] = [
      ...this.meshRootByDiscordId.liveEntries(now).map(([k, v, at]) => ({ dir: "meshRootByDiscordId" as const, k, v, at })),
      ...this.discordIdByMeshId.liveEntries(now).map(([k, v, at]) => ({ dir: "discordIdByMeshId" as const, k, v, at })),
    ].sort((left, right) => left.at - right.at);
    this.writer.rewrite(records);
  }

  public close(): void {
    this.timer.stop();
    this.compact();
  }

  private replay(record: unknown): void {
    if (!isRecord(record) || this.now() - record.at >= JOURNAL_TTL_MS) return;
    if (record.dir === "meshRootByDiscordId") this.meshRootByDiscordId.replay(record.k, record.v, record.at);
    else this.discordIdByMeshId.replay(record.k, record.v, record.at);
  }
}
