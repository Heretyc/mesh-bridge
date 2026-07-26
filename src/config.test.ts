import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig, parseIpcConfig } from "./config.js";

// Secrets live in the environment; everything else is config.jsonc source text passed as the second argument.
const validEnv: NodeJS.ProcessEnv = { DISCORD_TOKEN: "a".repeat(40), IPC_TOKEN: "b".repeat(64) };
const GOOD_ID = "123456789012345678";

// A minimal valid config.jsonc object; overrides merge onto the root before serialization.
function source(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    channels: [{ discordChannelId: GOOD_ID, meshtasticChannelName: "private" }],
    ...overrides,
  });
}

// N unique, valid channel pairs (18-digit snowflakes, short ASCII mesh names).
function channels(count: number): Array<{ discordChannelId: string; meshtasticChannelName: string }> {
  return Array.from({ length: count }, (_unused, index) => ({
    discordChannelId: `1000000000000000${String(10 + index)}`,
    meshtasticChannelName: `ch${index}`,
  }));
}

// Assert the thrown message is byte-for-byte the spec's exact string.
function expectError(fn: () => unknown, exact: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, exact);
    return true;
  });
}

// -------------------------- parseConfig: happy path --------------------------

test("valid config is fully populated with documented defaults", () => {
  const cfg = parseConfig(validEnv, source());
  assert.equal(cfg.discordToken, validEnv.DISCORD_TOKEN);
  assert.equal(cfg.ipcToken, validEnv.IPC_TOKEN);
  assert.equal(cfg.ipcPort, 47_652);
  assert.equal(cfg.queueLimit, 100);
  assert.equal(cfg.ackRetries, 2);
  assert.equal(cfg.sendIntervalMs, 1_000);
  assert.equal(cfg.configTimeoutMs, 30_000);
  assert.equal(cfg.dedupTtlMs, 300_000);
  assert.deepEqual(cfg.channels, [{ discordChannelId: GOOD_ID, meshtasticChannelName: "private" }]);
});

test("comments and trailing commas in the JSONC are accepted", () => {
  const jsonc = `{
    // Loopback IPC port
    "ipcPort": 50000, // inline comment
    "channels": [
      { "discordChannelId": "123456789012345678", "meshtasticChannelName": "private", },
    ],
  }`;
  const cfg = parseConfig(validEnv, jsonc);
  assert.equal(cfg.ipcPort, 50_000);
  assert.deepEqual(cfg.channels, [{ discordChannelId: GOOD_ID, meshtasticChannelName: "private" }]);
});

test("boundary counts and byte-exact names are accepted", () => {
  assert.equal(parseConfig(validEnv, source({ channels: channels(1) })).channels.length, 1);
  assert.equal(parseConfig(validEnv, source({ channels: channels(8) })).channels.length, 8);
  // 11 ASCII bytes is the inclusive ceiling.
  assert.deepEqual(
    parseConfig(validEnv, source({ channels: [{ discordChannelId: GOOD_ID, meshtasticChannelName: "12345678901" }] })).channels,
    [{ discordChannelId: GOOD_ID, meshtasticChannelName: "12345678901" }],
  );
});

// -------------------------- parseConfig: validation table --------------------------

test("missing config.jsonc file", () => {
  expectError(() => parseConfig(validEnv, undefined), "Missing required configuration file: config.jsonc");
});

test("JSONC parse error reports the symbolic code and offset", () => {
  assert.throws(() => parseConfig(validEnv, '{ "ipcPort": }'), (error: unknown) => {
    assert.ok(error instanceof Error);
    // Template: `Invalid config.jsonc: ${printParseErrorCode(code)} at offset ${offset}` — code is a jsonc-parser symbol.
    assert.match(error.message, /^Invalid config\.jsonc: [A-Za-z]+ at offset \d+$/u);
    return true;
  });
});

test("root that is not an object is rejected", () => {
  expectError(() => parseConfig(validEnv, "[]"), "config.jsonc must contain an object");
});

test("legacy DISCORD_CHANNEL_ID in env is fatal", () => {
  expectError(
    () => parseConfig({ ...validEnv, DISCORD_CHANNEL_ID: GOOD_ID }, source()),
    "Legacy environment variables DISCORD_CHANNEL_ID are no longer supported; move channel pairs into config.jsonc",
  );
});

test("legacy MESHTASTIC_CHANNEL_NAME in env is fatal even when set to an empty string", () => {
  expectError(
    () => parseConfig({ ...validEnv, MESHTASTIC_CHANNEL_NAME: "" }, source()),
    "Legacy environment variables MESHTASTIC_CHANNEL_NAME are no longer supported; move channel pairs into config.jsonc",
  );
});

test("both legacy env vars present are reported in fixed order", () => {
  expectError(
    () => parseConfig({ ...validEnv, DISCORD_CHANNEL_ID: GOOD_ID, MESHTASTIC_CHANNEL_NAME: "x" }, source()),
    "Legacy environment variables DISCORD_CHANNEL_ID, MESHTASTIC_CHANNEL_NAME are no longer supported; move channel pairs into config.jsonc",
  );
});

test("missing, placeholder, and too-short secrets", () => {
  expectError(() => parseConfig({ IPC_TOKEN: validEnv.IPC_TOKEN }, source()), "Missing required configuration: DISCORD_TOKEN");
  expectError(() => parseConfig({ ...validEnv, DISCORD_TOKEN: "change-me" }, source()), "Missing required configuration: DISCORD_TOKEN");
  expectError(() => parseConfig({ ...validEnv, IPC_TOKEN: "  " }, source()), "Missing required configuration: IPC_TOKEN");
  expectError(() => parseConfig({ ...validEnv, DISCORD_TOKEN: "a".repeat(29) }, source()), "DISCORD_TOKEN is too short to be a bot token");
  expectError(() => parseConfig({ ...validEnv, IPC_TOKEN: "b".repeat(31) }, source()), "IPC_TOKEN must be at least 32 characters");
});

test("channels array presence and count", () => {
  expectError(() => parseConfig(validEnv, JSON.stringify({})), "config.jsonc channels must be an array");
  expectError(() => parseConfig(validEnv, source({ channels: "nope" })), "config.jsonc channels must be an array");
  expectError(() => parseConfig(validEnv, source({ channels: [] })), "config.jsonc must define 1 to 8 channel pairs; found 0");
  expectError(() => parseConfig(validEnv, source({ channels: channels(9) })), "config.jsonc must define 1 to 8 channel pairs; found 9");
});

test("per-entry shape and discordChannelId format", () => {
  expectError(() => parseConfig(validEnv, source({ channels: [null] })), "config.jsonc channels[0] must be an object");
  expectError(
    () => parseConfig(validEnv, source({ channels: [{ discordChannelId: "abc", meshtasticChannelName: "private" }] })),
    'config.jsonc channels[0].discordChannelId "abc" must match ^\\d{17,20}$',
  );
});

test("empty mesh name is rejected", () => {
  expectError(
    () => parseConfig(validEnv, source({ channels: [{ discordChannelId: GOOD_ID, meshtasticChannelName: "" }] })),
    'config.jsonc channels[0].meshtasticChannelName "" must be 1 to 11 UTF-8 bytes',
  );
});

test("mesh name over 11 UTF-8 bytes is rejected even when its .length is <= 11", () => {
  // "日本語日本" is 5 UTF-16 code units (.length === 5) but 15 UTF-8 bytes: a naive .length check would wrongly pass.
  const multibyte = "日本語日本";
  assert.ok(multibyte.length <= 11);
  assert.ok(Buffer.byteLength(multibyte, "utf8") > 11);
  expectError(
    () => parseConfig(validEnv, source({ channels: [{ discordChannelId: GOOD_ID, meshtasticChannelName: multibyte }] })),
    'config.jsonc channels[0].meshtasticChannelName "日本語日本" must be 1 to 11 UTF-8 bytes',
  );
});

test("duplicate discordChannelId is rejected", () => {
  expectError(
    () => parseConfig(validEnv, source({ channels: [
      { discordChannelId: GOOD_ID, meshtasticChannelName: "alpha" },
      { discordChannelId: GOOD_ID, meshtasticChannelName: "bravo" },
    ] })),
    `Duplicate discordChannelId "${GOOD_ID}" in config.jsonc`,
  );
});

test("duplicate meshtasticChannelName is rejected", () => {
  expectError(
    () => parseConfig(validEnv, source({ channels: [
      { discordChannelId: "111111111111111111", meshtasticChannelName: "private" },
      { discordChannelId: "222222222222222222", meshtasticChannelName: "private" },
    ] })),
    'Duplicate meshtasticChannelName "private" in config.jsonc',
  );
});

test("each of the six global integer properties is range-checked", () => {
  const cases: Array<{ prop: string; bad: unknown; message: string }> = [
    { prop: "ipcPort", bad: 1023, message: "config.jsonc ipcPort must be an integer from 1024 to 65535" },
    { prop: "queueLimit", bad: 0, message: "config.jsonc queueLimit must be an integer from 1 to 1000" },
    { prop: "ackRetries", bad: 6, message: "config.jsonc ackRetries must be an integer from 0 to 5" },
    { prop: "sendIntervalMs", bad: 249, message: "config.jsonc sendIntervalMs must be an integer from 250 to 60000" },
    { prop: "configTimeoutMs", bad: 4_999, message: "config.jsonc configTimeoutMs must be an integer from 5000 to 120000" },
    { prop: "dedupTtlMs", bad: 9_999, message: "config.jsonc dedupTtlMs must be an integer from 10000 to 3600000" },
  ];
  for (const { prop, bad, message } of cases) {
    expectError(() => parseConfig(validEnv, source({ [prop]: bad })), message);
    // A non-integer value is rejected with the identical message.
    expectError(() => parseConfig(validEnv, source({ [prop]: 1.5 })), message);
  }
});

// -------------------------- parseIpcConfig: narrowed path --------------------------

test("parseIpcConfig succeeds regardless of channels or DISCORD_TOKEN", () => {
  // channels absent
  assert.deepEqual(parseIpcConfig(validEnv, JSON.stringify({ ipcPort: 50_000 })), { ipcToken: validEnv.IPC_TOKEN, ipcPort: 50_000 });
  // channels empty
  assert.deepEqual(parseIpcConfig(validEnv, JSON.stringify({ channels: [] })), { ipcToken: validEnv.IPC_TOKEN, ipcPort: 47_652 });
  // channels malformed
  assert.deepEqual(parseIpcConfig(validEnv, JSON.stringify({ channels: "nope" })), { ipcToken: validEnv.IPC_TOKEN, ipcPort: 47_652 });
  // DISCORD_TOKEN absent — the IPC path never reads it.
  assert.deepEqual(parseIpcConfig({ IPC_TOKEN: validEnv.IPC_TOKEN }, source()), { ipcToken: validEnv.IPC_TOKEN, ipcPort: 47_652 });
});

test("parseIpcConfig still fails with the spec-exact message for its own concerns", () => {
  // Missing file
  expectError(() => parseIpcConfig(validEnv, undefined), "Missing required configuration file: config.jsonc");
  // Parse error
  assert.throws(() => parseIpcConfig(validEnv, '{ "ipcPort": }'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^Invalid config\.jsonc: [A-Za-z]+ at offset \d+$/u);
    return true;
  });
  // Out-of-range ipcPort
  expectError(() => parseIpcConfig(validEnv, JSON.stringify({ ipcPort: 80 })), "config.jsonc ipcPort must be an integer from 1024 to 65535");
  // Bad IPC_TOKEN (missing and too short)
  expectError(() => parseIpcConfig({}, source()), "Missing required configuration: IPC_TOKEN");
  expectError(() => parseIpcConfig({ IPC_TOKEN: "b".repeat(31) }, source()), "IPC_TOKEN must be at least 32 characters");
  // Legacy env var still fatal on this path
  expectError(
    () => parseIpcConfig({ ...validEnv, DISCORD_CHANNEL_ID: GOOD_ID }, source()),
    "Legacy environment variables DISCORD_CHANNEL_ID are no longer supported; move channel pairs into config.jsonc",
  );
});
