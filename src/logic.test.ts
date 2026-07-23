import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "./config.js";
import { PermissionFlagsBits } from "discord.js";
import {
  BoundedQueue,
  MESHTASTIC_TEXT_BYTES,
  ReplyCorrelator,
  TtlDedup,
  TtlMap,
  classifyDiscordReaction,
  discoverMeshtasticPath,
  formatMeshForDiscord,
  formatReactionForMesh,
  hasRequiredDiscordPermissions,
  isMeshTapback,
  meshTapbackEmoji,
  replyIdForChunk,
  resolveDiscordMentions,
  resolveEncryptedChannel,
  retry,
  safeAttachmentName,
  shouldForwardDiscord,
  shouldForwardDiscordReaction,
  shouldForwardMesh,
  splitDiscordForMesh,
} from "./logic.js";

const validEnv: NodeJS.ProcessEnv = {
  DISCORD_TOKEN: "a".repeat(40),
  DISCORD_CHANNEL_ID: "123456789012345678",
  MESHTASTIC_CHANNEL_NAME: "private",
  IPC_TOKEN: "b".repeat(64),
};

test("configuration validates required secrets and bounded values", () => {
  assert.equal(parseConfig(validEnv).queueLimit, 100);
  assert.throws(() => parseConfig({ ...validEnv, DISCORD_TOKEN: "replace-me" }), /DISCORD_TOKEN/u);
  assert.throws(() => parseConfig({ ...validEnv, MESHTASTIC_CHANNEL_NAME: "😀😀😀" }), /11 UTF-8 bytes/u);
  assert.throws(() => parseConfig({ ...validEnv, QUEUE_LIMIT: "0" }), /QUEUE_LIMIT/u);
});

test("Discord routing accepts ordinary configured-channel users only", () => {
  const base = { channelId: validEnv.DISCORD_CHANNEL_ID!, authorBot: false, webhookId: null, ordinary: true, hasBody: true };
  assert.equal(shouldForwardDiscord(base, validEnv.DISCORD_CHANNEL_ID!), true);
  assert.equal(shouldForwardDiscord({ ...base, channelId: "999999999999999999" }, validEnv.DISCORD_CHANNEL_ID!), false);
  assert.equal(shouldForwardDiscord({ ...base, authorBot: true }, validEnv.DISCORD_CHANNEL_ID!), false);
  assert.equal(shouldForwardDiscord({ ...base, webhookId: "123" }, validEnv.DISCORD_CHANNEL_ID!), false);
  assert.equal(shouldForwardDiscord({ ...base, ordinary: false }, validEnv.DISCORD_CHANNEL_ID!), false);
  assert.equal(shouldForwardDiscord({ ...base, hasBody: false }, validEnv.DISCORD_CHANNEL_ID!), false);
  assert.equal(safeAttachmentName("C:\\fake\\photo.JPG"), "photo.JPG");
});

test("Discord reaction routing accepts configured-channel users only", () => {
  const base = { channelId: validEnv.DISCORD_CHANNEL_ID!, reactorBot: false };
  assert.equal(shouldForwardDiscordReaction(base, validEnv.DISCORD_CHANNEL_ID!), true);
  assert.equal(shouldForwardDiscordReaction({ ...base, channelId: "999999999999999999" }, validEnv.DISCORD_CHANNEL_ID!), false);
  assert.equal(shouldForwardDiscordReaction({ ...base, reactorBot: true }, validEnv.DISCORD_CHANNEL_ID!), false);
});

test("Discord reactions preserve one base codepoint plus optional VS16 and fall back for every other grapheme", () => {
  assert.deepEqual(classifyDiscordReaction({ id: null, name: "😀" }), {
    tapback: "😀", display: "😀", supported: true,
  });
  const heart = classifyDiscordReaction({ id: null, name: "❤️" });
  assert.deepEqual(heart, { tapback: "❤️", display: "❤️", supported: true });
  assert.equal(formatReactionForMesh(heart, "Ada]"), "❤️[Ada]]: Reacted with ❤️");

  for (const [emoji, display] of [
    [{ id: "123", name: "lol" }, ":lol:"],
    [{ id: null, name: "👍🏽" }, "👍🏽"],
    [{ id: null, name: "🇺🇸" }, "🇺🇸"],
    [{ id: null, name: "👩‍💻" }, "👩‍💻"],
  ] as const) {
    const plan = classifyDiscordReaction(emoji);
    assert.deepEqual(plan, { tapback: "✳️", display, supported: false });
  }
});

test("mesh tapbacks require emoji and reply ids and accept only the decoded emoji payload", () => {
  assert.equal(isMeshTapback({ emoji: 0x2764, replyId: 42 }), true);
  assert.equal(isMeshTapback({ emoji: 0, replyId: 42 }), false);
  assert.equal(isMeshTapback({ emoji: 0x2764, replyId: 0 }), false);
  assert.equal(meshTapbackEmoji("❤️"), "❤️");
  assert.equal(meshTapbackEmoji("😀"), "😀");
  for (const invalid of ["", "\u0000", "wrong", " ❤️ ", "👍🏽", "🇺🇸", "👩‍💻"]) {
    assert.equal(meshTapbackEmoji(invalid), undefined);
  }
});

test("Mesh routing scopes text to the channel, includes broadcasts and DMs, and blocks local loops", () => {
  const base = { portNum: 1, channel: 3, from: 42, destination: "broadcast" as const };
  assert.equal(shouldForwardMesh(base, 3, 7), true);
  assert.equal(shouldForwardMesh({ ...base, destination: "direct" }, 3, 7), true);
  assert.equal(shouldForwardMesh({ ...base, portNum: 67 }, 3, 7), false);
  assert.equal(shouldForwardMesh({ ...base, channel: 2 }, 3, 7), false);
  assert.equal(shouldForwardMesh({ ...base, from: 7 }, 3, 7), false);
  assert.equal(formatMeshForDiscord("Long Name", "hello"), "**[Long Name]:** hello");
  assert.equal(formatMeshForDiscord("A**B]", "hello"), "**[A\\*\\*B\\]]:** hello");
});

test("encrypted channel resolution fails closed", () => {
  const channel = { index: 2, role: 2, name: "private", psk: new Uint8Array([1]) };
  assert.equal(resolveEncryptedChannel([channel], "private"), 2);
  assert.throws(() => resolveEncryptedChannel([], "private"), /not found/u);
  assert.throws(() => resolveEncryptedChannel([channel, { ...channel, index: 3 }], "private"), /ambiguous/u);
  assert.throws(() => resolveEncryptedChannel([{ ...channel, psk: new Uint8Array() }], "private"), /not encrypted/u);
  assert.throws(() => resolveEncryptedChannel([{ ...channel, psk: new Uint8Array([0]) }], "private"), /not encrypted/u);
});

test("serial discovery selects one Meshtastic radio among unrelated USB ports", async () => {
  const probed: string[] = [];
  assert.equal(await discoverMeshtasticPath(["COM3", "COM4"], async (path) => {
    probed.push(path);
    return path === "COM4";
  }), "COM4");
  assert.deepEqual(probed, ["COM3", "COM4"]);
  await assert.rejects(discoverMeshtasticPath([], async () => false), /No USB serial device/u);
  await assert.rejects(discoverMeshtasticPath(["COM3"], async () => false), /No Meshtastic device/u);
  await assert.rejects(discoverMeshtasticPath(["COM3", "COM4"], async () => true), /Multiple Meshtastic devices/u);
});

test("UTF-8 chunks include stable numbering and attribution inside 232 bytes", () => {
  const url = `https://example.test/${"path/".repeat(35)}end?x=1&y=2`;
  const body = `hello 😀 ${url} ${"word ".repeat(100)}`;
  const chunks = splitDiscordForMesh("Display 😀", body);
  assert.ok(chunks.length > 1);
  const reconstructed: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    assert.ok(Buffer.byteLength(chunk, "utf8") <= MESHTASTIC_TEXT_BYTES);
    const marker = `[Display 😀]: (${index + 1}/${chunks.length}) `;
    assert.ok(chunk.startsWith(marker));
    reconstructed.push(chunk.slice(marker.length));
  }
  assert.equal(reconstructed.join(""), body);
});

test("Discord attribution is bracketed for single chunks and every split chunk", () => {
  assert.deepEqual(splitDiscordForMesh("Ada Lovelace", "short"), ["[Ada Lovelace]: short"]);
  assert.deepEqual(splitDiscordForMesh("Ada Lovelace", ""), []);

  const chunks = splitDiscordForMesh("Ada Lovelace", "word ".repeat(120).trim());
  assert.ok(chunks.length > 1);
  for (const [index, chunk] of chunks.entries()) {
    assert.ok(chunk.startsWith(`[Ada Lovelace]: (${index + 1}/${chunks.length}) `));
    assert.ok(Buffer.byteLength(chunk, "utf8") <= MESHTASTIC_TEXT_BYTES);
  }

  // Brackets and marker are charged to the ceiling: "[A]: " is five bytes, so 227 body bytes exactly fill one chunk.
  assert.equal(Buffer.byteLength(splitDiscordForMesh("A", "x".repeat(227))[0]!, "utf8"), MESHTASTIC_TEXT_BYTES);
  assert.match(splitDiscordForMesh("A", "x".repeat(228))[0]!, /^\[A\]: \(1\/2\) /u);
});

const mentionNames = {
  members: new Map([["123456789012345678", "Ada the Admin"]]),
  users: new Map([["123456789012345678", "ada"], ["222222222222222222", "Grace Hopper"]]),
  roles: new Map([["876543210987654321", "Mesh Ops"]]),
};

test("user mentions resolve to the guild member name and fall back to the user name", () => {
  assert.equal(resolveDiscordMentions("<@123456789012345678>", mentionNames), "@Ada the Admin");
  assert.equal(resolveDiscordMentions("<@!123456789012345678>", mentionNames), "@Ada the Admin");
  assert.equal(resolveDiscordMentions("<@222222222222222222>", mentionNames), "@Grace Hopper");
  assert.equal(resolveDiscordMentions("hi <@!222222222222222222> and <@123456789012345678>!", mentionNames),
    "hi @Grace Hopper and @Ada the Admin!");
});

test("role mentions resolve to the role name and unknown ids stay unchanged", () => {
  assert.equal(resolveDiscordMentions("<@&876543210987654321> ping", mentionNames), "@Mesh Ops ping");
  assert.equal(resolveDiscordMentions("<@999999999999999999>", mentionNames), "<@999999999999999999>");
  assert.equal(resolveDiscordMentions("<@!999999999999999999>", mentionNames), "<@!999999999999999999>");
  assert.equal(resolveDiscordMentions("<@&999999999999999999>", mentionNames), "<@&999999999999999999>");
  assert.equal(resolveDiscordMentions("<@123456789012345678> <@&999999999999999999>", mentionNames),
    "@Ada the Admin <@&999999999999999999>");
});

test("non-mention Discord markup, URLs, and plain text pass through byte-for-byte", () => {
  for (const untouched of [
    "https://example.test/a?b=1&c=2#frag",
    "<#123456789012345678>",
    "</deploy:123456789012345678>",
    "<:smile:123456789012345678>",
    "<a:wave:123456789012345678>",
    "<t:1700000000:R>",
    "@everyone @here plain text 😀",
    "<@123456789012345678", // unterminated
    "<@abc>",
  ]) assert.equal(resolveDiscordMentions(untouched, mentionNames), untouched);

  // A mention is substituted wherever it appears, including inside a URL: Discord itself renders it as a
  // mention there, and making the resolver URL-aware would cost more than it protects.
  assert.equal(resolveDiscordMentions("https://example.test/a?u=<@123456789012345678>", mentionNames),
    "https://example.test/a?u=@Ada the Admin");
});

test("resolved mention text is charged to the byte ceiling by attribution and numbering", () => {
  const resolved = resolveDiscordMentions("<@123456789012345678> <@&876543210987654321>", mentionNames);
  assert.equal(resolved, "@Ada the Admin @Mesh Ops");
  assert.deepEqual(splitDiscordForMesh("Grace", resolved), ["[Grace]: @Ada the Admin @Mesh Ops"]);

  const long = resolveDiscordMentions(`<@123456789012345678> ${"x".repeat(220)}`, mentionNames);
  const chunks = splitDiscordForMesh("A", long);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(Buffer.byteLength(chunk, "utf8") <= MESHTASTIC_TEXT_BYTES);
  assert.ok(chunks[0]!.startsWith("[A]: (1/2) @Ada the Admin"));
});

test("ACK retry is bounded and observable with a mock sender", async () => {
  let calls = 0;
  const retries: number[] = [];
  const result = await retry(async () => {
    calls += 1;
    if (calls < 3) throw new Error("mock NACK");
    return 99;
  }, 2, (attempt) => retries.push(attempt));
  assert.equal(result, 99);
  assert.equal(calls, 3);
  assert.deepEqual(retries, [1, 2]);

  calls = 0;
  await assert.rejects(retry(async () => {
    calls += 1;
    throw new Error("mock timeout");
  }, 1), /mock timeout/u);
  assert.equal(calls, 2);
});

test("TtlMap expires, refreshes on write, and evicts the oldest entry past capacity", () => {
  const map = new TtlMap<string, number>(100, 2);
  map.set("a", 1, 0);
  assert.equal(map.get("a", 50), 1);
  assert.equal(map.get("a", 100), undefined); // expiry is exclusive of the TTL boundary
  assert.equal(map.size, 0);

  map.set("b", 2, 0);
  map.set("b", 3, 60); // rewriting refreshes both value and lifetime
  assert.equal(map.get("b", 150), 3);
  assert.equal(map.get("b", 161), undefined);

  const bounded = new TtlMap<string, number>(1_000, 2);
  bounded.set("x", 1, 0);
  bounded.set("y", 2, 1);
  bounded.set("z", 3, 2);
  assert.equal(bounded.size, 2);
  assert.equal(bounded.get("x", 3), undefined); // insertion-ordered eviction drops the oldest
  assert.deepEqual([bounded.get("y", 3), bounded.get("z", 3)], [2, 3]);
});

test("first mesh chunk is the canonical reply root while every chunk maps back to the Discord message", () => {
  const correlator = new ReplyCorrelator(new TtlMap<string, number>(1_000, 10), new TtlMap<number, string>(1_000, 10));
  [111, 222, 333].forEach((meshId, index) => correlator.recordOutboundChunk("discord-1", index, meshId, 0));

  assert.equal(correlator.meshRootFor("discord-1", 0), 111);
  for (const meshId of [111, 222, 333]) assert.equal(correlator.discordTargetFor(meshId, 0), "discord-1");
  assert.equal(correlator.discordTargetFor(0, 0), undefined); // mesh id 0 means unset
  assert.equal(correlator.meshRootFor(undefined, 0), undefined);
  assert.equal(correlator.meshRootFor("unknown", 0), undefined);

  correlator.recordOutboundChunk("discord-2", 0, 0, 0); // an unACKed/zero id is never correlated
  assert.equal(correlator.meshRootFor("discord-2", 0), undefined);

  correlator.recordInbound(444, "discord-3", 0); // inbound mesh traffic correlates both directions
  assert.equal(correlator.discordTargetFor(444, 0), "discord-3");
  assert.equal(correlator.meshRootFor("discord-3", 0), 444);

  correlator.aliasMeshPacket(445, "discord-3", 0);
  correlator.aliasMeshPacket(0, "discord-3", 0);
  assert.equal(correlator.discordTargetFor(445, 0), "discord-3");
  assert.equal(correlator.meshRootFor("discord-3", 0), 444); // aliases never replace the canonical root
  assert.equal(correlator.discordTargetFor(0, 0), undefined);
  assert.equal(correlator.discordTargetFor(445, 1_000), undefined);

  assert.equal(correlator.meshRootFor("discord-1", 1_000), undefined); // correlation is TTL-bounded
  assert.equal(correlator.discordTargetFor(111, 1_000), undefined);
});

test("native replyId is sent only on the first chunk and unmapped targets relay unthreaded", async () => {
  const sent: Array<{ chunk: string; replyId: number | undefined }> = [];
  const sender = async (chunk: string, replyId: number | undefined): Promise<number> => {
    sent.push({ chunk, replyId });
    return 900 + sent.length;
  };

  const correlator = new ReplyCorrelator(new TtlMap<string, number>(1_000, 10), new TtlMap<number, string>(1_000, 10));
  correlator.recordInbound(555, "target-discord-id", 0);

  const chunks = splitDiscordForMesh("Ada", "word ".repeat(120).trim());
  assert.ok(chunks.length > 1);
  const root = correlator.meshRootFor("target-discord-id", 0);
  for (const [index, chunk] of chunks.entries()) {
    const meshId = await sender(chunk, replyIdForChunk(index, root));
    correlator.recordOutboundChunk("reply-discord-id", index, meshId, 0);
  }

  assert.equal(sent[0]!.replyId, 555);
  assert.ok(sent.slice(1).every((entry) => entry.replyId === undefined));
  assert.equal(correlator.meshRootFor("reply-discord-id", 0), 901);
  assert.equal(correlator.discordTargetFor(902, 0), "reply-discord-id");

  // An unknown/expired target yields no replyId at all, so the chunk is relayed unthreaded.
  assert.equal(replyIdForChunk(0, correlator.meshRootFor("never-seen", 0)), undefined);
});

test("startup requires View Channel, Send Messages, Read Message History, and Add Reactions", () => {
  const granted = (...bits: bigint[]) => ({ has: (needed: bigint[]) => needed.every((bit) => bits.includes(bit)) });
  const all = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AddReactions,
  ];

  assert.equal(hasRequiredDiscordPermissions(granted(...all)), true);
  for (const missing of all) assert.equal(hasRequiredDiscordPermissions(granted(...all.filter((bit) => bit !== missing))), false);
  assert.equal(hasRequiredDiscordPermissions(null), false);
});

test("TTL dedup and queue capacity are bounded", async () => {
  const dedup = new TtlDedup(100, 2);
  assert.equal(dedup.seen("a", 0), false);
  assert.equal(dedup.seen("a", 50), true);
  assert.equal(dedup.seen("a", 101), false);

  const depths: number[] = [];
  const handled: number[] = [];
  const queue = new BoundedQueue<number>(1, (depth) => depths.push(depth));
  assert.equal(queue.enqueue(1), true);
  assert.equal(queue.enqueue(2), false);
  queue.start(async (item) => { handled.push(item); });
  assert.equal(await queue.drain(1_000), true);
  assert.deepEqual(handled, [1]);
  assert.ok(depths.includes(0));
});
