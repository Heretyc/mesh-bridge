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
  mesh: { device: { sendText: (...args: unknown[]) => Promise<number> }; channel: number; localNode: number; disconnected: Promise<void> } | undefined;
  discordChannel: { send: (options: Record<string, unknown>) => Promise<{ id: string; reference: { messageId: string } | null }> } | undefined;
  deliverDiscordToMesh(job: { id: string; chunks: string[]; replyToDiscordId: string | undefined }): Promise<void>;
  deliverMeshToDiscord(job: { from: number; text: string; packetId: number; replyId: number }): Promise<void>;
}

function newService(t: TestContext): Internals {
  const internals = new BridgeService(config) as unknown as Internals;
  t.after(() => internals.abort.abort(new Error("test finished"))); // clears each send's 65s ACK timer
  return internals;
}

function warnings(internals: Internals): string[] {
  return internals.status.snapshot().events.filter((event) => event.code === "REPLY_TARGET_UNAVAILABLE").map((event) => event.detail);
}

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
