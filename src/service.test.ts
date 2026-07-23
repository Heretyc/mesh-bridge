import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Config } from "./config.js";
import { ReplyCorrelator, splitDiscordForMesh } from "./logic.js";
import { BridgeService } from "./service.js";
import type { StatusStore } from "./status.js";

const config: Config = {
  discordToken: "t".repeat(40),
  discordChannelId: "123456789012345678",
  meshChannelName: "private",
  ipcToken: "i".repeat(64),
  ipcPort: 47_999, // never listened on: these tests drive delivery methods directly, never run().
  queueLimit: 10,
  ackRetries: 0,
  sendIntervalMs: 0,
  configTimeoutMs: 5_000,
  dedupTtlMs: 60_000,
};

interface Internals {
  status: StatusStore;
  replies: ReplyCorrelator;
  abort: AbortController;
  discordToMesh: {
    start(worker: (job: ReactionJob) => Promise<void>): void;
    drain(timeoutMs: number): Promise<boolean>;
  };
  meshToDiscord: {
    start(worker: (job: MeshTapbackJob) => Promise<void>): void;
    drain(timeoutMs: number): Promise<boolean>;
  };
  mesh: { device: { sendText: (...args: unknown[]) => Promise<number> }; channel: number; localNode: number; disconnected: Promise<void> } | undefined;
  discordChannel: {
    send: (options: Record<string, unknown>) => Promise<{ id: string; reference: { messageId: string } | null }>;
    messages?: { fetch: (id: string) => Promise<{ react: (emoji: string) => Promise<unknown> }> };
  } | undefined;
  deliverOutbound(job: ReactionJob): Promise<void>;
  deliverInbound(job: MeshTapbackJob): Promise<void>;
  deliverDiscordToMesh(job: { id: string; chunks: string[]; replyToDiscordId: string | undefined }): Promise<void>;
  deliverMeshToDiscord(job: { from: number; text: string; packetId: number; replyId: number }): Promise<void>;
  deliverDiscordReactionToMesh(job: ReactionJob): Promise<void>;
  deliverMeshTapbackToDiscord(job: MeshTapbackJob): Promise<void>;
  handleDiscordReaction(reaction: unknown, user: unknown): Promise<void>;
  handleMeshPacket(packet: unknown, session: unknown): void;
}

interface ReactionJob {
  targetDiscordId: string;
  tapback: string;
  codepoint: number;
  replyText: string;
}

interface MeshTapbackJob {
  from: number;
  emoji: string;
  packetId: number;
  replyId: number;
}

function newService(t: TestContext, overrides: Partial<Config> = {}): Internals {
  const internals = new BridgeService({ ...config, ...overrides }) as unknown as Internals;
  t.after(() => internals.abort.abort(new Error("test finished"))); // clears each send's 65s ACK timer
  return internals;
}

function warnings(internals: Internals): string[] {
  return internals.status.snapshot().events.filter((event) => event.code === "REPLY_TARGET_UNAVAILABLE").map((event) => event.detail);
}

function meshSession(sendText: (...args: unknown[]) => Promise<number>) {
  return {
    device: { sendText },
    channel: 3,
    localNode: 7,
    disconnected: new Promise<void>(() => undefined),
  };
}

function reaction(
  targetDiscordId: string,
  emoji: { id: string | null; name: string | null },
  displayName = "Server Nick",
): unknown {
  return {
    partial: false,
    emoji,
    message: {
      partial: false,
      id: targetDiscordId,
      channelId: config.discordChannelId,
      guild: { members: { fetch: async () => ({ displayName }) } },
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

test("Discord to Mesh sends the mesh root only on a reply's first chunk and maps chunks only once ACKed", async (t) => {
  const internals = newService(t);
  const sends: unknown[][] = [];
  const atCall: Array<{ root: number | undefined; own: string | undefined }> = [];
  let owner = "root-msg";
  internals.mesh = {
    device: {
      sendText: async (...args: unknown[]): Promise<number> => {
        const packetId = 900 + sends.length;
        sends.push(args);
        atCall.push({ root: internals.replies.meshRootFor(owner), own: internals.replies.discordTargetFor(packetId) });
        return packetId;
      },
    },
    channel: 3,
    localNode: 7,
    disconnected: new Promise<void>(() => undefined),
  };

  const chunks = splitDiscordForMesh("Ada", "word ".repeat(120).trim());
  assert.ok(chunks.length > 1);
  await internals.deliverDiscordToMesh({ id: owner, chunks, replyToDiscordId: undefined });
  const rootSends = sends.length;
  owner = "reply-msg";
  await internals.deliverDiscordToMesh({ id: owner, chunks, replyToDiscordId: "root-msg" });

  // Fifth argument (replyId) is explicitly passed on every send.
  for (const args of sends) assert.equal(args.length, 5);
  for (const args of sends.slice(0, rootSends)) assert.equal(args[4], undefined);
  assert.equal(sends[rootSends]![4], 900); // canonical root = first chunk of the replied-to message
  for (const args of sends.slice(rootSends + 1)) assert.equal(args[4], undefined);

  // Mappings appear only after a send resolves: no chunk sees its own id, and the root appears only from chunk 2 on.
  assert.deepEqual(atCall[0], { root: undefined, own: undefined });
  assert.deepEqual(atCall[1], { root: 900, own: undefined });
  assert.deepEqual(atCall[rootSends], { root: undefined, own: undefined });

  assert.equal(internals.replies.meshRootFor("root-msg"), 900);
  assert.equal(internals.replies.meshRootFor("reply-msg"), 900 + rootSends);
  for (let index = 0; index < sends.length; index += 1) {
    assert.equal(internals.replies.discordTargetFor(900 + index), index < rootSends ? "root-msg" : "reply-msg");
  }
});

test("Mesh to Discord replies natively and warns once per unavailable target without re-sending", async (t) => {
  const internals = newService(t);
  const sent: Array<Record<string, unknown>> = [];
  let reference: { messageId: string } | null = { messageId: "discord-root" };
  internals.discordChannel = {
    send: async (options: Record<string, unknown>) => {
      sent.push(options);
      return { id: `sent-${sent.length}`, reference };
    },
  };
  internals.replies.recordOutboundChunk("discord-root", 0, 555);

  await internals.deliverMeshToDiscord({ from: 42, text: "mesh secret body", packetId: 700, replyId: 555 });
  assert.deepEqual(sent[0]!.reply, { messageReference: "discord-root", failIfNotExists: false });
  assert.deepEqual(sent[0]!.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(internals.replies.discordTargetFor(700), "sent-1");
  assert.deepEqual(warnings(internals), []);

  // Unmapped nonzero reply: exactly one unthreaded send and one sanitized warning.
  reference = null;
  await internals.deliverMeshToDiscord({ from: 42, text: "mesh secret body", packetId: 701, replyId: 999 });
  assert.equal(sent.length, 2);
  assert.equal("reply" in sent[1]!, false);
  assert.equal(warnings(internals).length, 1);
  assert.deepEqual(JSON.parse(warnings(internals)[0]!), { direction: "meshToDiscord", referencedId: 999 });

  // Discord dropped the reference (failIfNotExists): warn once, never re-send.
  await internals.deliverMeshToDiscord({ from: 42, text: "mesh secret body", packetId: 702, replyId: 555 });
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[2]!.reply, { messageReference: "discord-root", failIfNotExists: false });
  assert.equal(warnings(internals).length, 2);
  assert.deepEqual(JSON.parse(warnings(internals)[1]!), { direction: "meshToDiscord", referencedId: 555 });
  assert.ok(warnings(internals).every((detail) => !detail.includes("mesh secret body")));
});

test("mesh heart tapback reacts natively, never sends text, and aliases its packet to the Discord target", async (t) => {
  const internals = newService(t);
  const reactions: string[] = [];
  const textSends: unknown[] = [];
  internals.replies.recordOutboundChunk("discord-target", 0, 555);
  internals.discordChannel = {
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
        emoji: 0x2764,
      },
    },
  }, { channel: 3, localNode: 7 });
  assert.equal(await internals.meshToDiscord.drain(1_000), true);

  assert.deepEqual(reactions, ["❤️"]);
  assert.deepEqual(textSends, []);
  assert.equal(internals.replies.discordTargetFor(700), "discord-target");
  assert.equal(internals.replies.meshRootFor("discord-target"), 555);
});

test("mesh tapback target and REST failures are counted and never log payload content", async (t) => {
  const internals = newService(t);
  await internals.deliverMeshTapbackToDiscord({ from: 42, emoji: "secret-heart", packetId: 701, replyId: 999 });

  internals.replies.recordInbound(555, "deleted-target");
  internals.discordChannel = {
    send: async () => ({ id: "unexpected", reference: null }),
    messages: { fetch: async () => { throw new Error("secret-heart deleted body"); } },
  };
  await internals.deliverMeshTapbackToDiscord({ from: 42, emoji: "secret-heart", packetId: 702, replyId: 555 });

  const snapshot = internals.status.snapshot();
  assert.equal(snapshot.counters.failures, 2);
  assert.ok(snapshot.events.some((event) => event.code === "DISCORD_REACTION_TARGET_UNAVAILABLE"));
  assert.ok(snapshot.events.some((event) => event.code === "DISCORD_REACTION_DELIVERY_FAILED"));
  assert.ok(snapshot.events.every((event) => !event.detail.includes("secret-heart") && !event.detail.includes("deleted body")));
  assert.equal(internals.replies.discordTargetFor(702), "deleted-target");
});

test("supported and custom Discord reactions produce exact ordered tapback and reply packets", async (t) => {
  for (const fixture of [
    {
      target: "discord-origin",
      root: 500,
      emoji: { id: null, name: "❤️" },
      expected: [
        ["❤️", "broadcast", true, 3, 500, 0x2764],
        ["❤️[Server Nick]: Reacted with ❤️", "broadcast", true, 3, 500],
      ],
      correlate: (internals: Internals) => internals.replies.recordOutboundChunk("discord-origin", 0, 500),
    },
    {
      target: "bridge-bot-post",
      root: 600,
      emoji: { id: "custom-id", name: "lol" },
      expected: [
        ["✳️", "broadcast", true, 3, 600, 0x2733],
        ["✳️[Server Nick]: Reacted with :lol:", "broadcast", true, 3, 600],
      ],
      correlate: (internals: Internals) => internals.replies.recordInbound(600, "bridge-bot-post"),
    },
  ]) {
    await t.test(fixture.target, async (subtest) => {
      const internals = newService(subtest);
      const sends: unknown[][] = [];
      fixture.correlate(internals);
      internals.mesh = meshSession(async (...args) => {
        sends.push(args);
        return fixture.root + sends.length;
      });
      internals.discordToMesh.start((job) => internals.deliverOutbound(job));

      await internals.handleDiscordReaction(reaction(fixture.target, fixture.emoji), reactor);
      assert.equal(await internals.discordToMesh.drain(1_000), true);

      assert.deepEqual(sends, fixture.expected);
      assert.equal(internals.replies.meshRootFor(fixture.target), fixture.root);
      assert.equal(internals.replies.discordTargetFor(fixture.root + 1), fixture.target);
      assert.equal(internals.replies.discordTargetFor(fixture.root + 2), fixture.target);
    });
  }
});

test("Discord reaction resolves partial users before routing and ignores bot and wrong-channel events", async (t) => {
  const internals = newService(t);
  const sends: unknown[][] = [];
  let partialFetches = 0;
  const fetchOrder: string[] = [];
  internals.replies.recordOutboundChunk("partial-target", 0, 800);
  internals.mesh = meshSession(async (...args) => {
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
    message: { channelId: config.discordChannelId },
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
    message: { channelId: config.discordChannelId },
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
  assert.equal(sends.length, 2);
  assert.equal(sends[1]![0], "😀[Fetched Nick]: Reacted with 😀");
});

test("uncorrelated Discord reaction reports 0/2, and first-leg failure still attempts the reply without logging content", async (t) => {
  await t.test("uncorrelated", async (subtest) => {
    const internals = newService(subtest);
    const reports: string[] = [];
    internals.discordChannel = {
      send: async (options) => {
        reports.push(String(options.content));
        return { id: "report", reference: null };
      },
    };
    internals.discordToMesh.start((job) => internals.deliverOutbound(job));
    await internals.handleDiscordReaction(reaction("unknown-target", { id: null, name: "😀" }), reactor);
    assert.equal(await internals.discordToMesh.drain(1_000), true);
    assert.deepEqual(reports, ["Mesh Bridge: reaction delivery failed; 0/2 packets acknowledged."]);
  });

  await t.test("first leg failure", async (subtest) => {
    const internals = newService(subtest, { ackRetries: 2 });
    const sends: unknown[][] = [];
    const reports: string[] = [];
    internals.replies.recordOutboundChunk("target", 0, 900);
    internals.mesh = meshSession(async (...args) => {
      sends.push(args);
      if (args.length === 6) throw new Error("secret reaction content");
      return 902;
    });
    internals.discordChannel = {
      send: async (options) => {
        reports.push(String(options.content));
        return { id: "report", reference: null };
      },
    };
    await internals.deliverDiscordReactionToMesh({
      targetDiscordId: "target",
      tapback: "❤️",
      codepoint: 0x2764,
      replyText: "secret reaction content",
    });

    assert.deepEqual(sends, [
      ["❤️", "broadcast", true, 3, 900, 0x2764],
      ["❤️", "broadcast", true, 3, 900, 0x2764],
      ["❤️", "broadcast", true, 3, 900, 0x2764],
      ["secret reaction content", "broadcast", true, 3, 900],
    ]);
    assert.deepEqual(reports, ["Mesh Bridge: reaction delivery partially failed; 1/2 packets acknowledged."]);
    const snapshot = internals.status.snapshot();
    assert.deepEqual(snapshot.events.map(({ level, code, detail }) => ({ level, code, detail })), [
      { level: "warn", code: "MESH_REACTION_SEND_RETRY", detail: '{"leg":1}' },
      { level: "warn", code: "MESH_REACTION_SEND_RETRY", detail: '{"leg":1}' },
      { level: "error", code: "MESH_REACTION_DELIVERY_PARTIAL", detail: '{"delivered":1,"total":2}' },
    ]);
    assert.ok(snapshot.events.every((event) => !event.detail.includes("secret reaction content")));
  });
});
