import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "./config.js";
import {
  BoundedQueue,
  MESHTASTIC_TEXT_BYTES,
  TtlDedup,
  discoverMeshtasticPath,
  formatMeshForDiscord,
  resolveEncryptedChannel,
  retry,
  safeAttachmentName,
  shouldForwardDiscord,
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

test("UTF-8 chunks include stable numbering and attribution inside 233 bytes", () => {
  const url = `https://example.test/${"path/".repeat(35)}end?x=1&y=2`;
  const body = `hello 😀 ${url} ${"word ".repeat(100)}`;
  const chunks = splitDiscordForMesh("Display 😀", body);
  assert.ok(chunks.length > 1);
  const reconstructed: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    assert.ok(Buffer.byteLength(chunk, "utf8") <= MESHTASTIC_TEXT_BYTES);
    const marker = `Display 😀: (${index + 1}/${chunks.length}) `;
    assert.ok(chunk.startsWith(marker));
    reconstructed.push(chunk.slice(marker.length));
  }
  assert.equal(reconstructed.join(""), body);
  assert.equal(splitDiscordForMesh("A", "short")[0], "A: short");
  assert.equal(Buffer.byteLength(splitDiscordForMesh("A", "x".repeat(230))[0]!, "utf8"), MESHTASTIC_TEXT_BYTES);
  assert.match(splitDiscordForMesh("A", "x".repeat(231))[0]!, /^A: \(1\/2\) /u);
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
