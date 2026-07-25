import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  handleDiscordMessage(message: unknown): Promise<void>;
  handleMeshPacket(packet: unknown, session: unknown): void;
  telemetry: { close(): void };
  stateDir: string;
}

interface ReactionJob {
  targetDiscordId: string;
  displayName: string;
  emoji: string;
  targetBody: string;
}

interface MeshTapbackJob {
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
    if (previous === undefined) delete process.env.MESH_BRIDGE_STATE_DIR;
    else process.env.MESH_BRIDGE_STATE_DIR = previous;
    rmSync(stateDir, { recursive: true, force: true });
  });
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

function discordMessage(id: string, content: string): unknown {
  return {
    id,
    type: 0,
    channelId: config.discordChannelId,
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
): unknown {
  return {
    partial: false,
    emoji,
    message: {
      partial: false,
      id: targetDiscordId,
      channelId: config.discordChannelId,
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

const reactor = {
  partial: false,
  bot: false,
  id: "reactor-id",
  globalName: "Global Name",
  username: "username",
};

test("service telemetry writes full traffic bodies to disk without leaking configured tokens or TUI details", async (t) => {
  const internals = newService(t);
  const sends: unknown[][] = [];
  const reactions: string[] = [];
  internals.mesh = meshSession(async (...args) => {
    sends.push(args);
    return 900 + sends.length;
  });
  internals.discordChannel = {
    send: async (options) => ({ id: `discord-${String(options.content).length}`, reference: null }),
    messages: { fetch: async () => ({ react: async (emoji) => { reactions.push(emoji); } }) },
  };

  await internals.handleDiscordMessage(discordMessage("discord-body", `discord visible ${config.discordToken}`));
  await internals.deliverDiscordToMesh({ id: "chunk-body", chunks: [`chunk visible ${config.discordToken}`], replyToDiscordId: undefined });
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
        payload: new TextEncoder().encode(`mesh visible ${config.ipcToken}`),
        replyId: 0,
        emoji: 0,
      },
    },
  }, { channel: 3, localNode: 7 });
  await internals.deliverMeshToDiscord({ from: 42, text: `discord post ${config.ipcToken}`, packetId: 701, replyId: 0 });
  internals.replies.recordOutboundChunk("reaction-target", 0, 901);
  await internals.deliverDiscordReactionToMesh({
    targetDiscordId: "reaction-target",
    displayName: "Reactor",
    emoji: "heart",
    targetBody: `target visible ${config.discordToken}`,
  });
  internals.replies.recordInbound(555, "tap-target");
  await internals.deliverMeshTapbackToDiscord({ from: 42, emoji: "heart", packetId: 702, replyId: 555 });

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
        emoji: 1,
      },
    },
  }, { channel: 3, localNode: 7 });
  assert.equal(await internals.meshToDiscord.drain(1_000), true);

  assert.deepEqual(reactions, ["❤️"]);
  assert.deepEqual(textSends, []);
  assert.equal(internals.replies.discordTargetFor(700), "discord-target");
  assert.equal(internals.replies.meshRootFor("discord-target"), 555);
});

test("invalid mesh tapbacks are rejected without text delivery or payload logging", async (t) => {
  const internals = newService(t);
  const delivered: string[] = [];
  internals.replies.recordOutboundChunk("discord-target", 0, 555);
  internals.discordChannel = {
    send: async (options) => {
      delivered.push(String(options.content));
      return { id: "unexpected", reference: null };
    },
    messages: { fetch: async () => ({ react: async (emoji) => { delivered.push(emoji); } }) },
  };
  internals.meshToDiscord.start((job) => internals.deliverInbound(job));

  for (const [index, [payload, replyId]] of ([
    ["", 555],
    ["\u0000", 555],
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

test("mapped Unicode and custom Discord reactions send exact five-argument reply text", async (t) => {
  for (const fixture of [
    {
      target: "discord-origin",
      root: 500,
      emoji: { id: null, name: "❤️" },
      expected: [["Server Nick reacted with ❤️", "broadcast", true, 3, 500]],
      correlate: (internals: Internals) => internals.replies.recordOutboundChunk("discord-origin", 0, 500),
    },
    {
      target: "bridge-bot-post",
      root: 600,
      emoji: { id: "custom-id", name: "lol" },
      expected: [["Server Nick reacted with :lol:", "broadcast", true, 3, 600]],
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
      assert.equal(sends[0]!.length, 5);
      assert.equal(internals.replies.meshRootFor(fixture.target), fixture.root);
      assert.equal(internals.replies.discordTargetFor(fixture.root + 1), fixture.target);
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
  assert.equal(sends.length, 1);
  assert.equal(sends[0]![0], "Fetched Nick reacted with 😀");
});

test("uncorrelated Discord reaction sends one unthreaded excerpt packet", async (t) => {
  const internals = newService(t);
  const sends: unknown[][] = [];
  internals.mesh = meshSession(async (...args) => {
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
    const reports: string[] = [];
    internals.discordChannel = {
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
    const sends: unknown[][] = [];
    const reports: string[] = [];
    internals.replies.recordOutboundChunk("target", 0, 900);
    internals.mesh = meshSession(async (...args) => {
      sends.push(args);
      throw new Error("secret reaction content");
    });
    internals.discordChannel = {
      send: async (options) => {
        reports.push(String(options.content));
        return { id: "report", reference: null };
      },
    };
    await internals.deliverDiscordReactionToMesh({
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
