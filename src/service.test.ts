import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Config } from "./config.js";
import { ReplyCorrelator, splitDiscordForMesh } from "./logic.js";
import { BridgeService } from "./service.js";
import type { StatusStore, StatusSnapshot } from "./status.js";

// service.version is read from package.json at runtime; tests derive it from the same manifest, never hardcode it.
const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const CHANNEL_A = "123456789012345678";
const CHANNEL_B = "223456789012345678";

const config: Config = {
  discordToken: "t".repeat(40),
  ipcToken: "i".repeat(64),
  ipcPort: 47_999, // never listened on: these tests drive delivery methods directly, never run().
  queueLimit: 10,
  ackRetries: 0,
  sendIntervalMs: 0,
  configTimeoutMs: 5_000,
  dedupTtlMs: 60_000,
  channels: [{ discordChannelId: CHANNEL_A, meshtasticChannelName: "private" }],
};

// Two-pair fixture for the multi-channel isolation tests; each pair resolves to a distinct device index.
const twoPairChannels = [
  { discordChannelId: CHANNEL_A, meshtasticChannelName: "alpha" },
  { discordChannelId: CHANNEL_B, meshtasticChannelName: "bravo" },
];

interface DiscordChannelStub {
  send: (options: Record<string, unknown>) => Promise<{ id: string; reference: { messageId: string } | null }>;
  messages?: { fetch: (id: string) => Promise<{ react: (emoji: string) => Promise<unknown> }> };
}

interface MeshSessionStub {
  device: { sendText: (...args: unknown[]) => Promise<number> };
  localNode: number;
  disconnected: Promise<void>;
}

// Per-pair state now owns the journal, correlator, resolved Discord handle, and resolved mesh index.
interface PairInternals {
  discordChannelId: string;
  meshtasticChannelName: string;
  replies: ReplyCorrelator;
  discordChannel: DiscordChannelStub | undefined;
  meshChannel: number | undefined;
  journal: { file: string };
}

interface Internals {
  status: StatusStore;
  abort: AbortController;
  pairsByDiscordId: Map<string, PairInternals>;
  pairsByMeshChannel: Map<number, PairInternals>;
  mesh: MeshSessionStub | undefined;
  channelPairsStatus(): StatusSnapshot["connections"]["channelPairs"];
  discordToMesh: {
    start(worker: (job: ReactionJob) => Promise<void>): void;
    drain(timeoutMs: number): Promise<boolean>;
  };
  meshToDiscord: {
    start(worker: (job: MeshTapbackJob) => Promise<void>): void;
    drain(timeoutMs: number): Promise<boolean>;
  };
  deliverOutbound(job: ReactionJob): Promise<void>;
  deliverInbound(job: MeshTapbackJob): Promise<void>;
  deliverDiscordToMesh(job: { discordChannelId: string; id: string; chunks: string[]; replyToDiscordId: string | undefined }): Promise<void>;
  deliverMeshToDiscord(job: { discordChannelId: string; from: number; text: string; packetId: number; replyId: number }): Promise<void>;
  deliverDiscordReactionToMesh(job: ReactionJob): Promise<void>;
  deliverMeshTapbackToDiscord(job: MeshTapbackJob): Promise<void>;
  handleDiscordReaction(reaction: unknown, user: unknown): Promise<void>;
  handleDiscordMessage(message: unknown): Promise<void>;
  handleMeshPacket(packet: unknown, session: unknown): void;
  telemetry: { close(): void };
  stateDir: string;
}

interface ReactionJob {
  discordChannelId: string;
  targetDiscordId: string;
  displayName: string;
  emoji: string;
  targetBody: string;
}

interface MeshTapbackJob {
  discordChannelId: string;
  from: number;
  emoji: string;
  packetId: number;
  replyId: number;
}

function newService(t: TestContext, overrides: Partial<Config> = {}): Internals {
  const previous = process.env.MESH_BRIDGE_STATE_DIR;
  const stateDir = mkdtempSync(join(tmpdir(), "mesh-bridge-service-"));
  process.env.MESH_BRIDGE_STATE_DIR = stateDir;
  const internals = new BridgeService({ ...config, ...overrides }) as unknown as Internals;
  internals.stateDir = stateDir;
  t.after(() => {
    internals.telemetry.close();
    internals.abort.abort(new Error("test finished")); // clears each send's 65s ACK timer
    for (const pair of internals.pairsByDiscordId.values()) (pair as unknown as { journal: { close(): void } }).journal.close();
    if (previous === undefined) delete process.env.MESH_BRIDGE_STATE_DIR;
    else process.env.MESH_BRIDGE_STATE_DIR = previous;
    rmSync(stateDir, { recursive: true, force: true });
  });
  return internals;
}

function pairOf(internals: Internals, id = CHANNEL_A): PairInternals {
  const pair = internals.pairsByDiscordId.get(id);
  assert.ok(pair, `pair ${id} must exist`);
  return pair;
}

// Map a resolved mesh channel index to a pair, mirroring the routing table that MeshSession.activate() installs.
function mapMeshChannel(internals: Internals, index: number, id = CHANNEL_A): PairInternals {
  const pair = pairOf(internals, id);
  pair.meshChannel = index;
  internals.pairsByMeshChannel.set(index, pair);
  return pair;
}

// One shared radio/transmitter for the whole bridge; wire it plus this pair's resolved index for outbound sends.
function attachMesh(internals: Internals, sendText: (...args: unknown[]) => Promise<number>, index = 3, id = CHANNEL_A): MeshSessionStub {
  const session: MeshSessionStub = { device: { sendText }, localNode: 7, disconnected: new Promise<void>(() => undefined) };
  internals.mesh = session;
  mapMeshChannel(internals, index, id);
  return session;
}

function warnings(internals: Internals): string[] {
  return internals.status.snapshot().events.filter((event) => event.code === "REPLY_TARGET_UNAVAILABLE").map((event) => event.detail);
}

function discordMessage(id: string, content: string, channelId = CHANNEL_A): unknown {
  return {
    id,
    type: 0,
    channelId,
    author: { bot: false, globalName: null, username: "Ada" },
    member: { displayName: "Ada" },
    webhookId: null,
    content,
    attachments: { map: () => [] },
    mentions: {
      members: { map: () => [] },
      users: { map: () => [] },
      roles: { map: () => [] },
    },
    reference: null,
  };
}

function reaction(
  targetDiscordId: string,
  emoji: { id: string | null; name: string | null },
  displayName = "Server Nick",
  content = "target body",
  bridgeAuthored = false,
  channelId = CHANNEL_A,
): unknown {
  return {
    partial: false,
    emoji,
    message: {
      partial: false,
      id: targetDiscordId,
      channelId,
      guild: { members: { fetch: async () => ({ displayName }) } },
      author: { bot: bridgeAuthored, username: bridgeAuthored ? "Mesh Bridge" : "target-user" },
      content,
      attachments: { map: () => [] },
      mentions: {
        members: { map: () => [] },
        users: { map: () => [] },
        roles: { map: () => [] },
      },
    },
  };
}

// A decoded broadcast text packet on a given mesh channel, for driving handleMeshPacket routing directly.
function meshTextPacket(opts: { id: number; from: number; channel: number; text: string; replyId?: number }): unknown {
  return {
    id: opts.id,
    from: opts.from,
    to: 0,
    channel: opts.channel,
    rxTime: 1,
    payloadVariant: {
      case: "decoded",
      value: { portnum: 1, payload: new TextEncoder().encode(opts.text), replyId: opts.replyId ?? 0, emoji: 0 },
    },
  };
}

const reactor = {
  partial: false,
  bot: false,
  id: "reactor-id",
  globalName: "Global Name",
  username: "username",
};

test("service telemetry writes full traffic bodies to disk without leaking configured tokens or TUI details", async (t) => {
  const internals = newService(t);
  const pair = pairOf(internals);
  const sends: unknown[][] = [];
  const reactions: string[] = [];
  attachMesh(internals, async (...args) => {
    sends.push(args);
    return 900 + sends.length;
  });
  pair.discordChannel = {
    send: async (options) => ({ id: `discord-${String(options.content).length}`, reference: null }),
    messages: { fetch: async () => ({ react: async (emoji) => { reactions.push(emoji); } }) },
  };

  await internals.handleDiscordMessage(discordMessage("discord-body", `discord visible ${config.discordToken}`));
  await internals.deliverDiscordToMesh({ discordChannelId: CHANNEL_A, id: "chunk-body", chunks: [`chunk visible ${config.discordToken}`], replyToDiscordId: undefined });
  internals.handleMeshPacket(meshTextPacket({ id: 700, from: 42, channel: 3, text: `mesh visible ${config.ipcToken}` }), { channel: 3, localNode: 7 });
  await internals.deliverMeshToDiscord({ discordChannelId: CHANNEL_A, from: 42, text: `discord post ${config.ipcToken}`, packetId: 701, replyId: 0 });
  pair.replies.recordOutboundChunk("reaction-target", 0, 901);
  await internals.deliverDiscordReactionToMesh({
    discordChannelId: CHANNEL_A,
    targetDiscordId: "reaction-target",
    displayName: "Reactor",
    emoji: "heart",
    targetBody: `target visible ${config.discordToken}`,
  });
  pair.replies.recordInbound(555, "tap-target");
  await internals.deliverMeshTapbackToDiscord({ discordChannelId: CHANNEL_A, from: 42, emoji: "heart", packetId: 702, replyId: 555 });

  assert.deepEqual(reactions, ["heart"]);
  const text = readFileSync(join(internals.stateDir, "Logs", "telemetry.jsonl"), "utf8");
  for (const expected of ["discord visible", "chunk visible", "mesh visible", "discord post", "Reactor reacted with heart", "target visible", "heart"]) {
    assert.equal(text.includes(expected), true);
  }
  assert.equal(text.includes(config.discordToken), false);
  assert.equal(text.includes(config.ipcToken), false);
  const snapshot = JSON.stringify(internals.status.snapshot());
  assert.equal(snapshot.includes("discord visible"), false);
  assert.equal(snapshot.includes("mesh visible"), false);
  assert.equal(snapshot.includes(config.discordToken), false);
  assert.equal(snapshot.includes(config.ipcToken), false);
});

test("service telemetry stamps service.version from package.json rather than a hardcoded value", async (t) => {
  const internals = newService(t);
  const pair = pairOf(internals);
  attachMesh(internals, async () => 900);
  pair.discordChannel = { send: async () => ({ id: "x", reference: null }) };
  await internals.deliverDiscordToMesh({ discordChannelId: CHANNEL_A, id: "m1", chunks: ["[Ada]: hi"], replyToDiscordId: undefined });

  const record = readFileSync(join(internals.stateDir, "Logs", "telemetry.jsonl"), "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { resource: { attributes: Array<{ key: string; value: { stringValue: string } }> } })[0]!;
  const version = record.resource.attributes.find((attribute) => attribute.key === "service.version")?.value.stringValue;
  assert.equal(version, packageVersion); // exactly what package.json holds, not "unknown" or a stale literal
});

test("Discord to Mesh sends the mesh root only on a reply's first chunk and maps chunks only once ACKed", async (t) => {
  const internals = newService(t);
  const pair = pairOf(internals);
  const sends: unknown[][] = [];
  const atCall: Array<{ root: number | undefined; own: string | undefined }> = [];
  let owner = "root-msg";
  attachMesh(internals, async (...args: unknown[]): Promise<number> => {
    const packetId = 900 + sends.length;
    sends.push(args);
    atCall.push({ root: pair.replies.meshRootFor(owner), own: pair.replies.discordTargetFor(packetId) });
    return packetId;
  });

  const chunks = splitDiscordForMesh("Ada", "word ".repeat(120).trim());
  assert.ok(chunks.length > 1);
  await internals.deliverDiscordToMesh({ discordChannelId: CHANNEL_A, id: owner, chunks, replyToDiscordId: undefined });
  const rootSends = sends.length;
  owner = "reply-msg";
  await internals.deliverDiscordToMesh({ discordChannelId: CHANNEL_A, id: owner, chunks, replyToDiscordId: "root-msg" });

  // Fifth argument (replyId) is explicitly passed on every send.
  for (const args of sends) assert.equal(args.length, 5);
  for (const args of sends.slice(0, rootSends)) assert.equal(args[4], undefined);
  assert.equal(sends[rootSends]![4], 900); // canonical root = first chunk of the replied-to message
  for (const args of sends.slice(rootSends + 1)) assert.equal(args[4], undefined);

  // Mappings appear only after a send resolves: no chunk sees its own id, and the root appears only from chunk 2 on.
  assert.deepEqual(atCall[0], { root: undefined, own: undefined });
  assert.deepEqual(atCall[1], { root: 900, own: undefined });
  assert.deepEqual(atCall[rootSends], { root: undefined, own: undefined });

  assert.equal(pair.replies.meshRootFor("root-msg"), 900);
  assert.equal(pair.replies.meshRootFor("reply-msg"), 900 + rootSends);
  for (let index = 0; index < sends.length; index += 1) {
    assert.equal(pair.replies.discordTargetFor(900 + index), index < rootSends ? "root-msg" : "reply-msg");
  }
});

test("Mesh to Discord replies natively and warns once per unavailable target without re-sending", async (t) => {
  const internals = newService(t);
  const pair = pairOf(internals);
  const sent: Array<Record<string, unknown>> = [];
  let reference: { messageId: string } | null = { messageId: "discord-root" };
  pair.discordChannel = {
    send: async (options: Record<string, unknown>) => {
      sent.push(options);
      return { id: `sent-${sent.length}`, reference };
    },
  };
  pair.replies.recordOutboundChunk("discord-root", 0, 555);

  await internals.deliverMeshToDiscord({ discordChannelId: CHANNEL_A, from: 42, text: "mesh secret body", packetId: 700, replyId: 555 });
  assert.deepEqual(sent[0]!.reply, { messageReference: "discord-root", failIfNotExists: false });
  assert.deepEqual(sent[0]!.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(pair.replies.discordTargetFor(700), "sent-1");
  assert.deepEqual(warnings(internals), []);

  // Unmapped nonzero reply: exactly one unthreaded send and one sanitized warning.
  reference = null;
  await internals.deliverMeshToDiscord({ discordChannelId: CHANNEL_A, from: 42, text: "mesh secret body", packetId: 701, replyId: 999 });
  assert.equal(sent.length, 2);
  assert.equal("reply" in sent[1]!, false);
  assert.equal(warnings(internals).length, 1);
  assert.deepEqual(JSON.parse(warnings(internals)[0]!), { direction: "meshToDiscord", referencedId: 999 });

  // Discord dropped the reference (failIfNotExists): warn once, never re-send.
  await internals.deliverMeshToDiscord({ discordChannelId: CHANNEL_A, from: 42, text: "mesh secret body", packetId: 702, replyId: 555 });
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[2]!.reply, { messageReference: "discord-root", failIfNotExists: false });
  assert.equal(warnings(internals).length, 2);
  assert.deepEqual(JSON.parse(warnings(internals)[1]!), { direction: "meshToDiscord", referencedId: 555 });
  assert.ok(warnings(internals).every((detail) => !detail.includes("mesh secret body")));
});

test("mesh heart tapback reacts natively, never sends text, and aliases its packet to the Discord target", async (t) => {
  const internals = newService(t);
  const pair = pairOf(internals);
  const reactions: string[] = [];
  const textSends: unknown[] = [];
  pair.replies.recordOutboundChunk("discord-target", 0, 555);
  pair.discordChannel = {
    send: async (options) => {
      textSends.push(options);
      return { id: "unexpected", reference: null };
    },
    messages: {
      fetch: async (id) => {
        assert.equal(id, "discord-target");
        return { react: async (emoji) => { reactions.push(emoji); } };
      },
    },
  };
  mapMeshChannel(internals, 3);
  internals.meshToDiscord.start((job) => internals.deliverInbound(job));

  internals.handleMeshPacket({
    id: 700,
    from: 42,
    to: 0,
    channel: 3,
    rxTime: 1,
    payloadVariant: {
      case: "decoded",
      value: {
        portnum: 1,
        payload: new TextEncoder().encode("❤️"),
        replyId: 555,
        emoji: 1,
      },
    },
  }, { channel: 3, localNode: 7 });
  assert.equal(await internals.meshToDiscord.drain(1_000), true);

  assert.deepEqual(reactions, ["❤️"]);
  assert.deepEqual(textSends, []);
  assert.equal(pair.replies.discordTargetFor(700), "discord-target");
  assert.equal(pair.replies.meshRootFor("discord-target"), 555);
});

test("invalid mesh tapbacks are rejected without text delivery or payload logging", async (t) => {
  const internals = newService(t);
  const pair = pairOf(internals);
  const delivered: string[] = [];
  pair.replies.recordOutboundChunk("discord-target", 0, 555);
  pair.discordChannel = {
    send: async (options) => {
      delivered.push(String(options.content));
      return { id: "unexpected", reference: null };
    },
    messages: { fetch: async () => ({ react: async (emoji) => { delivered.push(emoji); } }) },
  };
  mapMeshChannel(internals, 3);
  internals.meshToDiscord.start((job) => internals.deliverInbound(job));

  for (const [index, [payload, replyId]] of ([
    ["", 555],
    [" ", 555],
    ["secret-invalid", 555],
    ["❤️", 0],
  ] as const).entries()) {
    internals.handleMeshPacket({
      id: 710 + index,
      from: 42,
      to: 0,
      channel: 3,
      rxTime: 1,
      payloadVariant: {
        case: "decoded",
        value: {
          portnum: 1,
          payload: new TextEncoder().encode(payload),
          replyId,
          emoji: 1,
        },
      },
    }, { channel: 3, localNode: 7 });
  }
  assert.equal(await internals.meshToDiscord.drain(1_000), true);

  const snapshot = internals.status.snapshot();
  assert.deepEqual(delivered, []);
  assert.equal(snapshot.counters.rejected, 4);
  assert.equal(snapshot.events.filter((event) => event.code === "MESH_TAPBACK_INVALID").length, 4);
  assert.ok(snapshot.events.every((event) => !event.detail.includes("secret-invalid")));
});

test("mesh tapback target and REST failures are counted and never log payload content", async (t) => {
  const internals = newService(t);
  const pair = pairOf(internals);
  await internals.deliverMeshTapbackToDiscord({ discordChannelId: CHANNEL_A, from: 42, emoji: "secret-heart", packetId: 701, replyId: 999 });

  pair.replies.recordInbound(555, "deleted-target");
  pair.discordChannel = {
    send: async () => ({ id: "unexpected", reference: null }),
    messages: { fetch: async () => { throw new Error("secret-heart deleted body"); } },
  };
  await internals.deliverMeshTapbackToDiscord({ discordChannelId: CHANNEL_A, from: 42, emoji: "secret-heart", packetId: 702, replyId: 555 });

  const snapshot = internals.status.snapshot();
  assert.equal(snapshot.counters.failures, 2);
  assert.ok(snapshot.events.some((event) => event.code === "DISCORD_REACTION_TARGET_UNAVAILABLE"));
  assert.ok(snapshot.events.some((event) => event.code === "DISCORD_REACTION_DELIVERY_FAILED"));
  assert.ok(snapshot.events.every((event) => !event.detail.includes("secret-heart") && !event.detail.includes("deleted body")));
  assert.equal(pair.replies.discordTargetFor(702), "deleted-target");
});

test("mapped Unicode and custom Discord reactions send exact five-argument reply text", async (t) => {
  for (const fixture of [
    {
      target: "discord-origin",
      root: 500,
      emoji: { id: null, name: "❤️" },
      expected: [["Server Nick reacted with ❤️", "broadcast", true, 3, 500]],
      correlate: (replies: ReplyCorrelator) => replies.recordOutboundChunk("discord-origin", 0, 500),
    },
    {
      target: "bridge-bot-post",
      root: 600,
      emoji: { id: "custom-id", name: "lol" },
      expected: [["Server Nick reacted with :lol:", "broadcast", true, 3, 600]],
      correlate: (replies: ReplyCorrelator) => replies.recordInbound(600, "bridge-bot-post"),
    },
  ]) {
    await t.test(fixture.target, async (subtest) => {
      const internals = newService(subtest);
      const pair = pairOf(internals);
      const sends: unknown[][] = [];
      fixture.correlate(pair.replies);
      attachMesh(internals, async (...args) => {
        sends.push(args);
        return fixture.root + sends.length;
      });
      internals.discordToMesh.start((job) => internals.deliverOutbound(job));

      await internals.handleDiscordReaction(reaction(fixture.target, fixture.emoji), reactor);
      assert.equal(await internals.discordToMesh.drain(1_000), true);

      assert.deepEqual(sends, fixture.expected);
      assert.equal(sends[0]!.length, 5);
      assert.equal(pair.replies.meshRootFor(fixture.target), fixture.root);
      assert.equal(pair.replies.discordTargetFor(fixture.root + 1), fixture.target);
    });
  }
});

test("Discord reaction resolves partial users before routing and ignores bot and wrong-channel events", async (t) => {
  const internals = newService(t);
  const pair = pairOf(internals);
  const sends: unknown[][] = [];
  let partialFetches = 0;
  const fetchOrder: string[] = [];
  pair.replies.recordOutboundChunk("partial-target", 0, 800);
  attachMesh(internals, async (...args) => {
    sends.push(args);
    return 810 + sends.length;
  });
  internals.discordToMesh.start((job) => internals.deliverOutbound(job));

  await internals.handleDiscordReaction(reaction("ignored-bot", { id: null, name: "😀" }), { ...reactor, bot: true });
  await internals.handleDiscordReaction({
    ...reaction("ignored-channel", { id: null, name: "😀" }) as object,
    message: { channelId: "wrong-channel" },
  }, {
    ...reactor,
    partial: true,
    bot: null,
    fetch: async () => { throw new Error("wrong-channel user must not be fetched"); },
  });
  let botReactionFetches = 0;
  await internals.handleDiscordReaction({
    partial: true,
    message: { channelId: CHANNEL_A },
    fetch: async () => {
      botReactionFetches += 1;
      return reaction("ignored-partial-bot", { id: null, name: "😀" });
    },
  }, {
    ...reactor,
    partial: true,
    bot: null,
    fetch: async () => {
      fetchOrder.push("bot-user");
      return { ...reactor, bot: true };
    },
  });
  const full = reaction("partial-target", { id: null, name: "😀" }, "Fetched Nick") as {
    message: object;
  };
  await internals.handleDiscordReaction({
    partial: true,
    message: { channelId: CHANNEL_A },
    fetch: async () => {
      partialFetches += 1;
      fetchOrder.push("reaction");
      return { ...full, message: { ...full.message, partial: true, fetch: async () => {
        partialFetches += 1;
        fetchOrder.push("message");
        return { ...full.message, partial: false };
      } } };
    },
  }, {
    ...reactor,
    partial: true,
    fetch: async () => {
      partialFetches += 1;
      fetchOrder.push("user");
      return reactor;
    },
  });
  assert.equal(await internals.discordToMesh.drain(1_000), true);

  assert.equal(partialFetches, 3);
  assert.equal(botReactionFetches, 0);
  assert.deepEqual(fetchOrder, ["bot-user", "user", "reaction", "message"]);
  assert.equal(sends.length, 1);
  assert.equal(sends[0]![0], "Fetched Nick reacted with 😀");
});

test("uncorrelated Discord reaction sends one unthreaded excerpt packet", async (t) => {
  const internals = newService(t);
  const sends: unknown[][] = [];
  attachMesh(internals, async (...args) => {
    sends.push(args);
    return 901;
  });
  internals.discordToMesh.start((job) => internals.deliverOutbound(job));
  await internals.handleDiscordReaction(
    reaction("unknown-target", { id: null, name: "😀" }, "Server Nick", "**[Xandi]:** hello", true),
    reactor,
  );
  assert.equal(await internals.discordToMesh.drain(1_000), true);
  assert.deepEqual(sends, [['Server Nick reacted 😀 to "[Xandi]: hello"', "broadcast", true, 3, undefined]]);
  assert.equal(sends[0]!.length, 5);
});

test("empty uncorrelated target and ACK exhaustion fail clearly as 0/1", async (t) => {
  await t.test("empty target", async (subtest) => {
    const internals = newService(subtest);
    const pair = pairOf(internals);
    const reports: string[] = [];
    pair.discordChannel = {
      send: async (options) => {
        reports.push(String(options.content));
        return { id: "report", reference: null };
      },
    };
    internals.discordToMesh.start((job) => internals.deliverOutbound(job));
    await internals.handleDiscordReaction(reaction("unknown-target", { id: null, name: "😀" }, "Server Nick", ""), reactor);
    assert.equal(await internals.discordToMesh.drain(1_000), true);
    assert.deepEqual(reports, ["Mesh Bridge: reaction delivery failed; 0/1 packets acknowledged."]);
    assert.ok(internals.status.snapshot().events.some((event) => event.code === "MESH_REACTION_FORMAT_FAILED"));
  });

  await t.test("ACK exhaustion", async (subtest) => {
    const internals = newService(subtest, { ackRetries: 2 });
    const pair = pairOf(internals);
    const sends: unknown[][] = [];
    const reports: string[] = [];
    pair.replies.recordOutboundChunk("target", 0, 900);
    attachMesh(internals, async (...args) => {
      sends.push(args);
      throw new Error("secret reaction content");
    });
    pair.discordChannel = {
      send: async (options) => {
        reports.push(String(options.content));
        return { id: "report", reference: null };
      },
    };
    await internals.deliverDiscordReactionToMesh({
      discordChannelId: CHANNEL_A,
      targetDiscordId: "target",
      displayName: "Secret Reactor",
      emoji: "❤️",
      targetBody: "secret reaction content",
    });

    assert.deepEqual(sends, [
      ["Secret Reactor reacted with ❤️", "broadcast", true, 3, 900],
      ["Secret Reactor reacted with ❤️", "broadcast", true, 3, 900],
      ["Secret Reactor reacted with ❤️", "broadcast", true, 3, 900],
    ]);
    assert.ok(sends.every((args) => args.length === 5));
    assert.deepEqual(reports, ["Mesh Bridge: reaction delivery failed; 0/1 packets acknowledged."]);
    const snapshot = internals.status.snapshot();
    assert.deepEqual(snapshot.events.map(({ level, code, detail }) => ({ level, code, detail })), [
      { level: "warn", code: "MESH_REACTION_SEND_RETRY", detail: '{"referencedId":"target","attempt":1}' },
      { level: "warn", code: "MESH_REACTION_SEND_RETRY", detail: '{"referencedId":"target","attempt":2}' },
      { level: "error", code: "MESH_REACTION_DELIVERY_FAILED", detail: '{"delivered":0,"total":1}' },
    ]);
    assert.ok(snapshot.events.every((event) => !event.detail.includes("secret reaction content")));
  });
});

// ---------------------------------------------------------------------------
// Multi-pair isolation: a message received on one pair must never reach another.
// ---------------------------------------------------------------------------

test("multi-pair: a Discord message is relayed only to its own pair's mesh channel", async (t) => {
  const internals = newService(t, { channels: twoPairChannels });
  const sends: Array<{ channel: number; text: unknown }> = [];
  const sendText = async (...args: unknown[]): Promise<number> => {
    sends.push({ channel: args[3] as number, text: args[0] });
    return 900 + sends.length;
  };
  // One shared transmitter; each pair resolved to a distinct device index (A->3, B->4).
  internals.mesh = { device: { sendText }, localNode: 7, disconnected: new Promise<void>(() => undefined) };
  mapMeshChannel(internals, 3, CHANNEL_A);
  mapMeshChannel(internals, 4, CHANNEL_B);
  internals.discordToMesh.start((job) => internals.deliverOutbound(job));

  await internals.handleDiscordMessage(discordMessage("msg-a", "hello from A", CHANNEL_A));
  assert.equal(await internals.discordToMesh.drain(1_000), true);

  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.channel, 3);            // pair A's own mesh index
  assert.ok(sends.every((send) => send.channel !== 4)); // never pair B's index
});

test("multi-pair: a mesh packet is delivered only to its own pair's Discord channel", async (t) => {
  const internals = newService(t, { channels: twoPairChannels });
  const pairA = pairOf(internals, CHANNEL_A);
  const pairB = pairOf(internals, CHANNEL_B);
  const sentA: string[] = [];
  const sentB: string[] = [];
  pairA.discordChannel = { send: async (options) => { sentA.push(String(options.content)); return { id: "a", reference: null }; } };
  pairB.discordChannel = { send: async (options) => { sentB.push(String(options.content)); return { id: "b", reference: null }; } };
  mapMeshChannel(internals, 3, CHANNEL_A);
  mapMeshChannel(internals, 4, CHANNEL_B);
  internals.meshToDiscord.start((job) => internals.deliverInbound(job));

  internals.handleMeshPacket(meshTextPacket({ id: 700, from: 42, channel: 4, text: "packet for B" }), { channel: 4, localNode: 7 });
  assert.equal(await internals.meshToDiscord.drain(1_000), true);

  assert.equal(sentA.length, 0);
  assert.equal(sentB.length, 1);
  assert.ok(sentB[0]!.includes("packet for B"));
});

test("multi-pair: the same packet id on two mesh channels is not deduplicated across pairs", async (t) => {
  const internals = newService(t, { channels: twoPairChannels });
  const pairA = pairOf(internals, CHANNEL_A);
  const pairB = pairOf(internals, CHANNEL_B);
  const sentA: string[] = [];
  const sentB: string[] = [];
  pairA.discordChannel = { send: async (options) => { sentA.push(String(options.content)); return { id: "a", reference: null }; } };
  pairB.discordChannel = { send: async (options) => { sentB.push(String(options.content)); return { id: "b", reference: null }; } };
  mapMeshChannel(internals, 3, CHANNEL_A);
  mapMeshChannel(internals, 4, CHANNEL_B);
  internals.meshToDiscord.start((job) => internals.deliverInbound(job));

  // Identical packet id + sender, different mesh channels: pair-namespaced dedup keys keep both.
  internals.handleMeshPacket(meshTextPacket({ id: 700, from: 42, channel: 3, text: "same id on A" }), { channel: 3, localNode: 7 });
  internals.handleMeshPacket(meshTextPacket({ id: 700, from: 42, channel: 4, text: "same id on B" }), { channel: 4, localNode: 7 });
  assert.equal(await internals.meshToDiscord.drain(1_000), true);

  assert.equal(sentA.length, 1);
  assert.equal(sentB.length, 1);

  // A genuine duplicate on the SAME channel is still deduped, proving the guard is namespaced, not disabled.
  internals.handleMeshPacket(meshTextPacket({ id: 700, from: 42, channel: 3, text: "dup on A" }), { channel: 3, localNode: 7 });
  assert.equal(await internals.meshToDiscord.drain(1_000), true);
  assert.equal(sentA.length, 1);
});

test("multi-pair: each pair persists reply mappings to its own journal file", (t) => {
  const internals = newService(t, { channels: twoPairChannels });
  const pairA = pairOf(internals, CHANNEL_A);
  const pairB = pairOf(internals, CHANNEL_B);
  assert.notEqual(pairA.journal.file, pairB.journal.file);
  assert.ok(pairA.journal.file.includes(CHANNEL_A));
  assert.ok(pairB.journal.file.includes(CHANNEL_B));

  pairA.replies.recordInbound(401, "discord-a-msg");
  pairB.replies.recordInbound(402, "discord-b-msg");

  const textA = readFileSync(pairA.journal.file, "utf8");
  const textB = readFileSync(pairB.journal.file, "utf8");
  assert.ok(textA.includes("discord-a-msg") && !textA.includes("discord-b-msg"));
  assert.ok(textB.includes("discord-b-msg") && !textB.includes("discord-a-msg"));
});

test("multi-pair: reply correlation is isolated to the originating pair", (t) => {
  const internals = newService(t, { channels: twoPairChannels });
  const pairA = pairOf(internals, CHANNEL_A);
  const pairB = pairOf(internals, CHANNEL_B);
  pairA.replies.recordInbound(555, "discord-a-root");

  assert.equal(pairA.replies.discordTargetFor(555), "discord-a-root");
  assert.equal(pairA.replies.meshRootFor("discord-a-root"), 555);
  // Pair B shares neither direction of the correlation.
  assert.equal(pairB.replies.discordTargetFor(555), undefined);
  assert.equal(pairB.replies.meshRootFor("discord-a-root"), undefined);
});

test("multi-pair: an unresolved pair stays pending and receives no Mesh->Discord traffic", async (t) => {
  const internals = newService(t, { channels: twoPairChannels });
  const pairB = pairOf(internals, CHANNEL_B);
  const sentB: string[] = [];
  pairB.discordChannel = { send: async (options) => { sentB.push(String(options.content)); return { id: "b", reference: null }; } };
  // Only pair A resolves against the device; pair B's mesh name never resolves, so it stays pending.
  mapMeshChannel(internals, 3, CHANNEL_A);
  internals.status.connection({ channelPairs: internals.channelPairsStatus() });
  internals.meshToDiscord.start((job) => internals.deliverInbound(job));

  // No pairsByMeshChannel entry maps to pair B, so a packet on its would-be index (or any other) is ignored.
  internals.handleMeshPacket(meshTextPacket({ id: 700, from: 42, channel: 4, text: "for pending B" }), { channel: 4, localNode: 7 });
  internals.handleMeshPacket(meshTextPacket({ id: 701, from: 42, channel: 9, text: "for nobody" }), { channel: 9, localNode: 7 });
  assert.equal(await internals.meshToDiscord.drain(1_000), true);
  assert.equal(sentB.length, 0);

  const pairs = internals.status.snapshot().connections.channelPairs;
  assert.equal(pairs.find((entry) => entry.discordChannelId === CHANNEL_A)?.meshChannelIndex, 3);
  assert.equal(pairs.find((entry) => entry.discordChannelId === CHANNEL_B)?.meshChannelIndex, null);
});
