import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import test, { type TestContext } from "node:test";
import { appendJsonl, atomicReplaceFile, readJsonlTolerant } from "./jsonl.js";
import { ensureDir, journalDir, logDir, resolveMeshBridgePaths, stateRoot } from "./paths.js";
import { makeRedactor, redactRecord } from "./redact.js";
import { nextLocalOccurrence, scheduleDailyLocal } from "./schedule.js";
import { StatusStore } from "./status.js";
import { TelemetrySink } from "./telemetry.js";
// service.version is read from package.json at runtime (see docs/spec/bridge-config.md "Version Telemetry"),
// so tests must derive the expected version from the same manifest instead of hardcoding it.
const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

function sandbox(t: TestContext): string {
  const previous = process.env.MESH_BRIDGE_STATE_DIR;
  const dir = mkdtempSync(join(tmpdir(), "mesh-bridge-telemetry-"));
  process.env.MESH_BRIDGE_STATE_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.MESH_BRIDGE_STATE_DIR;
    else process.env.MESH_BRIDGE_STATE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function resource(): Record<string, string> {
  return { "service.name": "mesh-bridge", "service.version": packageVersion, "os.type": "test", "host.name": "host" };
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean) : [];
}

function recordAt(ms: number, body = "body"): unknown {
  return {
    timeUnixNano: (BigInt(ms) * 1_000_000n).toString(),
    observedTimeUnixNano: (BigInt(ms) * 1_000_000n).toString(),
    severityNumber: 9,
    severityText: "INFO",
    body: { stringValue: body },
    attributes: [],
    resource: { attributes: [] },
    instrumentationScope: { name: "mesh-bridge", version: packageVersion },
    eventName: "message",
  };
}

test("paths resolve platform defaults and MESH_BRIDGE_STATE_DIR overrides every root", (t) => {
  const dir = sandbox(t);
  assert.equal(stateRoot(), dir);
  assert.equal(logDir(), join(dir, "Logs"));
  assert.equal(journalDir(), join(dir, "journal"));

  assert.deepEqual(resolveMeshBridgePaths("win32", { ProgramData: "D:\\Data" }, "C:\\Users\\Lexi"), {
    stateRoot: win32.join("D:\\Data", "Mesh Bridge"),
    logDir: win32.join("D:\\Data", "Mesh Bridge", "Logs"),
    journalDir: win32.join("D:\\Data", "Mesh Bridge", "journal"),
  });
  assert.deepEqual(resolveMeshBridgePaths("linux", {}, "/home/lexi"), {
    stateRoot: posix.join("/home/lexi", ".local", "state", "mesh-bridge"),
    logDir: posix.join("/home/lexi", ".local", "state", "mesh-bridge", "logs"),
    journalDir: posix.join("/home/lexi", ".local", "state", "mesh-bridge", "journal"),
  });
  assert.deepEqual(resolveMeshBridgePaths("linux", { XDG_STATE_HOME: "/var/state" }, "/home/lexi"), {
    stateRoot: posix.join("/var/state", "mesh-bridge"),
    logDir: posix.join("/var/state", "mesh-bridge", "logs"),
    journalDir: posix.join("/var/state", "mesh-bridge", "journal"),
  });
  assert.deepEqual(resolveMeshBridgePaths("darwin", {}, "/Users/lexi"), {
    stateRoot: posix.join("/Users/lexi", "Library", "Application Support", "Mesh Bridge"),
    logDir: posix.join("/Users/lexi", "Library", "Logs", "Mesh Bridge"),
    journalDir: posix.join("/Users/lexi", "Library", "Application Support", "Mesh Bridge", "journal"),
  });
  for (const platform of ["win32", "linux", "darwin"] as const) {
    const resolved = resolveMeshBridgePaths(platform, { MESH_BRIDGE_STATE_DIR: "/tmp/root" }, "/home/lexi");
    assert.equal(resolved.stateRoot, "/tmp/root");
    assert.equal(resolved.logDir.endsWith(`${platform === "win32" ? "\\" : "/"}Logs`), true);
    assert.equal(resolved.journalDir.endsWith(`${platform === "win32" ? "\\" : "/"}journal`), true);
  }

  const nested = join(dir, "a", "b");
  ensureDir(nested);
  assert.equal(existsSync(nested), true);
  if (process.platform !== "win32") assert.equal(statSync(nested).mode & 0o777, 0o700);
});

test("jsonl helpers atomically replace, tolerate malformed lines, and append newline-delimited records", (t) => {
  const dir = sandbox(t);
  const file = join(dir, "records.jsonl");
  writeFileSync(file, "old\n");
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, "new\n");
  assert.equal(readFileSync(file, "utf8"), "old\n");
  rmSync(temp);

  atomicReplaceFile(file, "new\n");
  assert.equal(readFileSync(file, "utf8"), "new\n");
  assert.equal(existsSync(temp), false);

  writeFileSync(file, "{\"ok\":1}\nnot-json\n{\"ok\":2}\n");
  assert.deepEqual(readJsonlTolerant<{ ok: number }>(file), [{ ok: 1 }, { ok: 2 }]);
  appendJsonl(file, { ok: 3 });
  assert.equal(readFileSync(file, "utf8").endsWith("\n"), true);
  assert.deepEqual(readJsonlTolerant<{ ok: number }>(file).at(-1), { ok: 3 });
});

test("telemetry writes OTel-shaped JSONL records with decimal nanosecond strings and KeyValue attributes", (t) => {
  sandbox(t);
  const file = join(logDir(), "telemetry.jsonl");
  const sink = new TelemetrySink({ logFile: file, secrets: [], resource: resource(), now: () => 1_700_000_000_000 });
  t.after(() => sink.close());
  sink.logMessageBody("discord->mesh", "full body", { packetId: 42 });
  sink.logEvent("warn", "WARN_CODE", { detail: "value" });
  sink.logEvent("error", "ERROR_CODE");

  const parsed = lines(file).map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(typeof parsed[0]?.timeUnixNano, "string");
  assert.equal(parsed[0]?.timeUnixNano, "1700000000000000000");
  assert.equal(parsed[0]?.severityNumber, 9);
  assert.deepEqual(parsed[0]?.body, { stringValue: "full body" });
  assert.deepEqual(parsed[0]?.attributes, [
    { key: "direction", value: { stringValue: "discord->mesh" } },
    { key: "packetId", value: { stringValue: "42" } },
  ]);
  assert.equal(parsed[1]?.severityNumber, 13);
  assert.equal(parsed[2]?.severityNumber, 17);
  assert.equal("traceId" in parsed[0]!, false);
  assert.equal("spanId" in parsed[0]!, false);
});

test("telemetry exact-token redaction removes configured secrets from bodies, attributes, and final lines", (t) => {
  sandbox(t);
  const discordToken = "d".repeat(40);
  const ipcToken = "i".repeat(64);
  const file = join(logDir(), "telemetry.jsonl");
  const sink = new TelemetrySink({ logFile: file, secrets: [discordToken, ipcToken], resource: resource(), now: () => 1 });
  t.after(() => sink.close());
  sink.logMessageBody("discord->mesh", `full body ${discordToken}`, { nested: { token: ipcToken } });
  sink.logEvent("error", "TOKEN_ERROR", { error: `failed with ${ipcToken}` });

  const text = readFileSync(file, "utf8");
  assert.equal(text.includes(discordToken), false);
  assert.equal(text.includes(ipcToken), false);
  assert.equal(text.includes("[REDACTED]"), true);
  assert.equal(text.includes("full body"), true);

  const redactor = makeRedactor(["", "tiny", "x".repeat(30), "y".repeat(32)]);
  const redacted = redactor("tiny " + "x".repeat(30) + " " + "y".repeat(32));
  assert.equal(redacted.includes("tiny"), true);
  assert.equal(redacted.includes("x".repeat(30)), false);
  assert.equal(redacted.includes("y".repeat(32)), false);
  assert.deepEqual(redactRecord({ a: ["x".repeat(30)] }, redactor), { a: ["[REDACTED]"] });
});

test("prune keeps records inside 24 hours, drops older and malformed lines, and leaves valid JSONL", (t) => {
  sandbox(t);
  ensureDir(logDir());
  const now = 1_700_000_000_000;
  const file = join(logDir(), "telemetry.jsonl");
  writeFileSync(file, [
    JSON.stringify(recordAt(now - 23 * 60 * 60 * 1000, "keep " + "d".repeat(40))),
    "malformed",
    JSON.stringify(recordAt(now - 25 * 60 * 60 * 1000, "drop")),
    "",
  ].join("\n"));

  const sink = new TelemetrySink({ logFile: file, secrets: ["d".repeat(40)], resource: resource(), now: () => now });
  t.after(() => sink.close());
  const parsed = lines(file).map((line) => JSON.parse(line) as { body: { stringValue: string } });
  assert.deepEqual(parsed.map((entry) => entry.body.stringValue), ["keep [REDACTED]"]);
  assert.equal(readFileSync(file, "utf8").includes("d".repeat(40)), false);
});

test("telemetry fail-open sets one degraded warning, does not recurse, and reports recovery", (t) => {
  sandbox(t);
  const file = join(logDir(), "telemetry.jsonl");
  const status = new StatusStore();
  const stderr: string[] = [];
  const sink = new TelemetrySink({
    logFile: file,
    secrets: [],
    resource: resource(),
    now: () => 1,
    onWriteError: (error) => {
      status.logDegraded(true, "LOG_WRITE_FAILED", { error: String(error) });
      stderr.push("warn");
    },
    onWriteRecovered: () => {
      status.logDegraded(false, "LOG_WRITE_RECOVERED");
      stderr.push("recover");
    },
  });
  t.after(() => sink.close());
  status.useTelemetry(sink);

  rmSync(file, { force: true });
  mkdirSync(file);
  assert.doesNotThrow(() => status.event("info", "RELAY_CALL", { message: "full body" }));
  assert.equal(status.snapshot().logDegraded, true);
  assert.equal(status.snapshot().events.filter((event) => event.code === "LOG_WRITE_FAILED").length, 1);
  assert.deepEqual(stderr, ["warn"]);

  assert.doesNotThrow(() => status.event("warn", "SECOND_FAIL", { message: "full body" }));
  assert.equal(status.snapshot().events.filter((event) => event.code === "LOG_WRITE_FAILED").length, 1);
  assert.deepEqual(stderr, ["warn"]);

  rmSync(file, { recursive: true, force: true });
  assert.doesNotThrow(() => status.event("info", "RECOVERED"));
  assert.equal(status.snapshot().logDegraded, false);
  assert.equal(status.snapshot().events.filter((event) => event.code === "LOG_WRITE_RECOVERED").length, 1);
  assert.deepEqual(stderr, ["warn", "recover"]);
});

test("StatusStore snapshot stays byte-identical with telemetry attached and sanitized bodies absent", (t) => {
  sandbox(t);
  const RealDate = Date;
  const fixedMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  class FixedDate extends RealDate {
    public constructor(value?: string | number | Date) {
      if (value === undefined) super(fixedMs);
      else super(value);
    }

    public static override now(): number {
      return fixedMs;
    }
  }
  globalThis.Date = FixedDate as DateConstructor;
  try {
    const plain = new StatusStore();
    const withTelemetry = new StatusStore();
    const sink = new TelemetrySink({ logFile: join(logDir(), "telemetry.jsonl"), secrets: [], resource: resource(), now: () => fixedMs });
    t.after(() => sink.close());
    withTelemetry.useTelemetry(sink);
    plain.event("info", "SAME_EVENT", { message: "secret body", visible: "ok" });
    withTelemetry.event("info", "SAME_EVENT", { message: "secret body", visible: "ok" });

    const left = JSON.stringify(plain.snapshot());
    const right = JSON.stringify(withTelemetry.snapshot());
    assert.equal(right, left);
    assert.equal(right.includes("secret body"), false);
  } finally {
    globalThis.Date = RealDate;
  }
});

test("daily scheduler computes local 02:00 including DST dates, unrefs timers, and routes task errors", async (t) => {
  sandbox(t);
  const normal = nextLocalOccurrence(2, new Date(2026, 0, 1, 1, 30, 0));
  assert.equal(normal.getHours(), 2);
  assert.equal(normal.getMinutes(), 0);
  const tomorrow = nextLocalOccurrence(2, new Date(2026, 0, 1, 2, 0, 0));
  assert.equal(tomorrow.getDate(), new Date(2026, 0, 2).getDate());

  const dst = nextLocalOccurrence(2, new Date(2026, 2, 8, 1, 30, 0));
  assert.equal(dst.getMinutes(), 0);
  assert.equal(dst.getSeconds(), 0);
  assert.ok(dst.getTime() > new Date(2026, 2, 8, 1, 30, 0).getTime());

  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let capturedDelay = -1;
  let unrefCalled = false;
  let callback: (() => void) | undefined;
  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: number) => {
    capturedDelay = timeout ?? 0;
    callback = () => {
      if (typeof handler === "function") handler();
    };
    return { unref: () => { unrefCalled = true; } } as NodeJS.Timeout;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
  try {
    const errors: unknown[] = [];
    const task = scheduleDailyLocal(2, () => { throw new Error("boom"); }, {
      now: () => new Date(2026, 0, 1, 1, 0, 0).getTime(),
      onError: (error) => errors.push(error),
    });
    assert.equal(capturedDelay, 60 * 60 * 1000);
    assert.equal(unrefCalled, true);
    callback?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
    task.stop();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});
