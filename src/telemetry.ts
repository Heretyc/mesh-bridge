import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicReplaceFile, readJsonlTolerant } from "./jsonl.js";
import { ensureDir } from "./paths.js";
import { makeRedactor, redactRecord, type Redactor } from "./redact.js";
import { scheduleDailyLocal, type DailyTask } from "./schedule.js";

export type TelemetryLevel = "info" | "warn" | "error";
export type Direction = "discord->mesh" | "mesh->discord" | "mesh->discord.reaction" | "discord->mesh.reaction";

interface TelemetryRecord {
  timeUnixNano?: string;
  observedTimeUnixNano?: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: Array<{ key: string; value: { stringValue: string } }>;
  resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
  instrumentationScope: { name: string; version: string };
  eventName: string;
}

const severity: Record<TelemetryLevel, { number: number; text: string }> = {
  info: { number: 9, text: "INFO" },
  warn: { number: 13, text: "WARN" },
  error: { number: 17, text: "ERROR" },
};

function stringValue(value: string): { stringValue: string } {
  return { stringValue: value };
}

function kv(key: string, value: unknown): { key: string; value: { stringValue: string } } {
  return { key, value: stringValue(String(value)) };
}

function nanos(ms: number): string {
  return (BigInt(ms) * 1_000_000n).toString();
}

function timestampMs(record: TelemetryRecord): number | undefined {
  if (record.timeUnixNano === undefined) return undefined;
  try {
    return Number(BigInt(record.timeUnixNano) / 1_000_000n);
  } catch {
    return undefined;
  }
}

export class TelemetrySink {
  private readonly timer: DailyTask;
  private readonly redact: Redactor;
  private degraded = false;

  public constructor(private readonly opts: {
    logFile: string;
    secrets: string[];
    resource: Record<string, string>;
    now?: () => number;
    onWriteError?: (e: unknown) => void;
    onWriteRecovered?: () => void;
  }) {
    this.redact = makeRedactor(opts.secrets);
    try {
      ensureDir(dirname(opts.logFile));
    } catch (error) {
      this.failOpen(error);
    }
    this.pruneOnce();
    this.timer = scheduleDailyLocal(2, () => this.pruneOnce(), {
      ...(opts.now === undefined ? {} : { now: opts.now }),
      onError: (error) => this.failOpen(error),
    });
  }

  public get isDegraded(): boolean {
    return this.degraded;
  }

  public logMessageBody(direction: Direction, body: string, attrs: Record<string, unknown> = {}): void {
    this.write(this.record("info", "message", body, { direction, ...attrs }));
  }

  public logEvent(level: TelemetryLevel, code: string, attrs: Record<string, unknown> = {}): void {
    this.write(this.record(level, code, code, attrs));
  }

  public close(): void {
    this.timer.stop();
  }

  private record(level: TelemetryLevel, eventName: string, body: string, attrs: Record<string, unknown>): TelemetryRecord {
    const at = nanos(this.opts.now?.() ?? Date.now());
    const sev = severity[level];
    return {
      timeUnixNano: at,
      observedTimeUnixNano: at,
      severityNumber: sev.number,
      severityText: sev.text,
      body: stringValue(body),
      attributes: Object.entries(attrs).map(([key, value]) => kv(key, value)),
      resource: { attributes: Object.entries(this.opts.resource).map(([key, value]) => kv(key, value)) },
      instrumentationScope: { name: this.opts.resource["service.name"] ?? "mesh-bridge", version: this.opts.resource["service.version"] ?? "unknown" },
      eventName,
    };
  }

  private write(record: TelemetryRecord): void {
    try {
      const redacted = redactRecord(record, this.redact);
      const line = `${this.redact(JSON.stringify(redacted))}\n`;
      appendFileSync(this.opts.logFile, line, { encoding: "utf8", mode: 0o600 });
      this.recover();
    } catch (error) {
      this.failOpen(error);
    }
  }

  public pruneOnce(): void {
    try {
      const cutoff = (this.opts.now?.() ?? Date.now()) - 86_400_000;
      const keep = readJsonlTolerant<TelemetryRecord>(this.opts.logFile)
        .filter((record) => {
          const ms = timestampMs(record);
          return ms !== undefined && ms >= cutoff;
        });
      const data = keep
        .map((record) => this.redact(JSON.stringify(redactRecord(record, this.redact))))
        .join("\n");
      atomicReplaceFile(this.opts.logFile, data + (keep.length ? "\n" : ""));
      this.recover();
    } catch (error) {
      this.failOpen(error);
    }
  }

  private failOpen(error: unknown): void {
    if (this.degraded) return;
    this.degraded = true;
    this.opts.onWriteError?.(error);
  }

  private recover(): void {
    if (!this.degraded) return;
    this.degraded = false;
    this.opts.onWriteRecovered?.();
  }
}
