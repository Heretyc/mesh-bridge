import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ChannelJournal, JOURNAL_LIMIT, JOURNAL_TTL_MS } from "./journal.js";
import { ReplyCorrelator, TtlMap } from "./logic.js";
import { StatusStore } from "./status.js";

const channelA = "123456789012345678";
const channelB = "223456789012345678";
const baseNow = 1_900_000_000_000;

function tempState(t: TestContext): string {
  const previous = process.env.MESH_BRIDGE_STATE_DIR;
  const dir = mkdtempSync(join(tmpdir(), "mesh-bridge-journal-"));
  process.env.MESH_BRIDGE_STATE_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.MESH_BRIDGE_STATE_DIR;
    else process.env.MESH_BRIDGE_STATE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function correlator(journal: ChannelJournal): ReplyCorrelator {
  return new ReplyCorrelator(journal.meshRootByDiscordId, journal.discordIdByMeshId);
}

test("TtlMap liveEntries reports live entries without mutating expiry state", (t) => {
  tempState(t);
  const map = new TtlMap<string, number>(100, 10);
  map.set("expired", 1, 0);
  map.set("live", 2, 60);

  assert.deepEqual(map.liveEntries(100), [["live", 2, 60]]);
  assert.equal(map.size, 2);
  assert.equal(map.get("expired", 100), undefined);
  assert.equal(map.size, 1);
});

test("journal mappings survive restart in both directions", (t) => {
  tempState(t);
  const first = new ChannelJournal(channelA, { now: () => baseNow });
  const before = correlator(first);
  before.recordOutboundChunk("discord-out", 0, 101, baseNow);
  before.recordInbound(202, "discord-in", baseNow + 1);

  const after = correlator(new ChannelJournal(channelA, { now: () => baseNow + 2 }));
  assert.equal(after.meshRootFor("discord-out", baseNow + 2), 101);
  assert.equal(after.discordTargetFor(101, baseNow + 2), "discord-out");
  assert.equal(after.meshRootFor("discord-in", baseNow + 2), 202);
  assert.equal(after.discordTargetFor(202, baseNow + 2), "discord-in");
});

test("canonical root and aliases round-trip without alias repair", (t) => {
  tempState(t);
  const before = correlator(new ChannelJournal(channelA, { now: () => baseNow }));
  before.recordOutboundChunk("discord-root", 0, 10, baseNow);
  before.recordOutboundChunk("discord-root", 1, 11, baseNow + 1);
  before.aliasMeshPacket(12, "discord-root", baseNow + 2);

  const after = correlator(new ChannelJournal(channelA, { now: () => baseNow + 3 }));
  assert.equal(after.meshRootFor("discord-root", baseNow + 3), 10);
  assert.equal(after.discordTargetFor(10, baseNow + 3), "discord-root");
  assert.equal(after.discordTargetFor(11, baseNow + 3), "discord-root");
  assert.equal(after.discordTargetFor(12, baseNow + 3), "discord-root");
});

test("mesh packet id 0 is never persisted or resolvable", (t) => {
  tempState(t);
  const journal = new ChannelJournal(channelA, { now: () => baseNow });
  const replies = correlator(journal);
  replies.recordOutboundChunk("discord-zero-out", 0, 0, baseNow);
  replies.recordInbound(0, "discord-zero-in", baseNow);
  replies.aliasMeshPacket(0, "discord-zero-alias", baseNow);

  assert.equal(replies.discordTargetFor(0, baseNow), undefined);
  assert.equal(replies.meshRootFor("discord-zero-out", baseNow), undefined);
  assert.equal(replies.meshRootFor("discord-zero-in", baseNow), undefined);
  assert.equal(existsSync(journal.file) ? readFileSync(journal.file, "utf8").includes("discord-zero") : false, false);
});

test("10001st entry evicts the oldest in one direction only", (t) => {
  tempState(t);
  const journal = new ChannelJournal(channelA, { now: () => baseNow });
  journal.discordIdByMeshId.set(1, "stable-discord", baseNow);
  for (let index = 0; index <= JOURNAL_LIMIT; index += 1) {
    journal.meshRootByDiscordId.set(`discord-${index}`, index + 10, baseNow + index + 1);
  }

  assert.equal(journal.meshRootByDiscordId.size, JOURNAL_LIMIT);
  assert.equal(journal.meshRootByDiscordId.get("discord-0", baseNow + JOURNAL_LIMIT + 1), undefined);
  assert.equal(journal.meshRootByDiscordId.get("discord-10000", baseNow + JOURNAL_LIMIT + 1), 10_010);
  assert.equal(journal.discordIdByMeshId.get(1, baseNow + JOURNAL_LIMIT + 1), "stable-discord");
});

test("expired entries read undefined before compaction and disappear after compaction", (t) => {
  tempState(t);
  const journal = new ChannelJournal(channelA, { now: () => baseNow });
  const replies = correlator(journal);
  const old = baseNow - JOURNAL_TTL_MS - 1;
  replies.recordInbound(777, "expired-discord", old);

  assert.equal(replies.discordTargetFor(777, baseNow), undefined);
  assert.equal(replies.meshRootFor("expired-discord", baseNow), undefined);
  assert.equal(readFileSync(journal.file, "utf8").includes("expired-discord"), true);
  journal.compact(baseNow);
  assert.equal(readFileSync(journal.file, "utf8").includes("expired-discord"), false);
});

test("compaction is atomic and lossless for the live union of directions", (t) => {
  tempState(t);
  const journal = new ChannelJournal(channelA, { now: () => baseNow });
  const replies = correlator(journal);
  replies.recordInbound(1, "orphanable-discord", baseNow);
  for (let index = 0; index <= JOURNAL_LIMIT; index += 1) {
    journal.meshRootByDiscordId.set(`overflow-${index}`, index + 50, baseNow + index + 1);
  }

  assert.equal(replies.meshRootFor("orphanable-discord", baseNow + JOURNAL_LIMIT + 1), undefined);
  assert.equal(replies.discordTargetFor(1, baseNow + JOURNAL_LIMIT + 1), "orphanable-discord");
  journal.compact(baseNow + JOURNAL_LIMIT + 1);

  const after = correlator(new ChannelJournal(channelA, { now: () => baseNow + JOURNAL_LIMIT + 2 }));
  assert.equal(after.meshRootFor("orphanable-discord", baseNow + JOURNAL_LIMIT + 2), undefined);
  assert.equal(after.discordTargetFor(1, baseNow + JOURNAL_LIMIT + 2), "orphanable-discord");
});

test("malformed and truncated journal lines are skipped while valid entries load", (t) => {
  const dir = tempState(t);
  const journalDir = join(dir, "journal");
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(join(journalDir, `${channelA}.reply-mapping.jsonl`), [
    JSON.stringify({ dir: "meshRootByDiscordId", k: "survivor-root", v: 301, at: baseNow }),
    "{bad json",
    '{"dir":"discordIdByMeshId","k":302,',
    JSON.stringify({ dir: "discordIdByMeshId", k: 302, v: "survivor-discord", at: baseNow + 1 }),
    JSON.stringify({ dir: "discordIdByMeshId", k: "wrong", v: "ignored", at: baseNow + 1 }),
    "",
  ].join("\n"));

  const replies = correlator(new ChannelJournal(channelA, { now: () => baseNow + 2 }));
  assert.equal(replies.meshRootFor("survivor-root", baseNow + 2), 301);
  assert.equal(replies.discordTargetFor(302, baseNow + 2), "survivor-discord");
});

test("validated channel ids use separate files and isolated mappings", (t) => {
  tempState(t);
  const first = new ChannelJournal(channelA, { now: () => baseNow });
  const second = new ChannelJournal(channelB, { now: () => baseNow });
  correlator(first).recordInbound(401, "discord-a", baseNow);
  correlator(second).recordInbound(402, "discord-b", baseNow);

  assert.notEqual(first.file, second.file);
  assert.equal(correlator(first).discordTargetFor(402, baseNow), undefined);
  assert.equal(correlator(second).discordTargetFor(401, baseNow), undefined);
});

test("invalid channel ids are rejected before filename use", (t) => {
  tempState(t);
  assert.throws(() => new ChannelJournal("../123456789012345678", { now: () => baseNow }), /validated snowflake/u);
  assert.throws(() => new ChannelJournal("123", { now: () => baseNow }), /validated snowflake/u);
});

test("append failure is fail-open with one TUI warning and one stderr warning", (t) => {
  tempState(t);
  const status = new StatusStore();
  const stderrWrites: string[] = [];
  const stderr = process.stderr as NodeJS.WriteStream & { write(chunk: string): boolean };
  const originalWrite = stderr.write.bind(stderr);
  stderr.write = ((chunk: string) => {
    stderrWrites.push(chunk);
    return true;
  }) as typeof stderr.write;
  t.after(() => {
    stderr.write = originalWrite as typeof stderr.write;
  });

  const journal = new ChannelJournal(channelA, {
    now: () => baseNow,
    append: () => { throw new Error("disk full"); },
    onDegraded: (error) => {
      status.journalDegraded(true, "JOURNAL_WRITE_FAILED", { error: String(error) });
      process.stderr.write("[Mesh Bridge] warning: reply mapping journal writes failed; continuing with in-memory reply correlation\n");
    },
  });
  const replies = correlator(journal);

  assert.doesNotThrow(() => replies.recordInbound(501, "discord-fail-open", baseNow));
  assert.equal(replies.discordTargetFor(501, baseNow), "discord-fail-open");
  assert.equal(replies.meshRootFor("discord-fail-open", baseNow), 501);
  const snapshot = status.snapshot();
  assert.equal(snapshot.journalDegraded, true);
  assert.equal(snapshot.events.filter((event) => event.code === "JOURNAL_WRITE_FAILED").length, 1);
  assert.equal(stderrWrites.length, 1);
});
