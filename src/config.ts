import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { spawnSync } from "node:child_process";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

export interface ChannelPairConfig {
  discordChannelId: string;
  meshtasticChannelName: string;
}

export interface Config {
  discordToken: string;
  ipcToken: string;
  ipcPort: number;
  queueLimit: number;
  ackRetries: number;
  sendIntervalMs: number;
  configTimeoutMs: number;
  dedupTtlMs: number;
  channels: ChannelPairConfig[];
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value || /^(replace|change)[-_ ]?me$/i.test(value)) {
    throw new Error(`Missing required configuration: ${name}`);
  }
  return value;
}

function integerProp(root: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
  const raw = root[name];
  const value = raw === undefined ? fallback : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`config.jsonc ${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

// Legacy env cutover check — presence at any value (including "") is fatal.
// Shared by the full and IPC-only load paths so the cutover cannot drift.
function checkLegacyEnv(env: NodeJS.ProcessEnv): void {
  const legacy = ["DISCORD_CHANNEL_ID", "MESHTASTIC_CHANNEL_NAME"].filter((name) => env[name] !== undefined);
  if (legacy.length > 0) {
    throw new Error(`Legacy environment variables ${legacy.join(", ")} are no longer supported; move channel pairs into config.jsonc`);
  }
}

// IPC_TOKEN length rule, shared so both paths emit the identical message.
function requireIpcTokenLength(ipcToken: string): void {
  if (ipcToken.length < 32) throw new Error("IPC_TOKEN must be at least 32 characters");
}

// File existence, JSONC parse, and root-type check. Returns the validated root
// object. Shared so the full and IPC-only paths cannot drift on these messages.
function parseConfigSource(source: string | undefined): Record<string, unknown> {
  if (source === undefined) throw new Error("Missing required configuration file: config.jsonc");
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
  const [first] = errors;
  if (first !== undefined) {
    throw new Error(`Invalid config.jsonc: ${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config.jsonc must contain an object");
  }
  return parsed as Record<string, unknown>;
}

export function parseConfig(env: NodeJS.ProcessEnv, source: string | undefined): Config {
  // 1. Legacy env cutover check — presence at any value (including "") is fatal.
  checkLegacyEnv(env);

  // 2. Required secrets and token-length checks. Presence is checked for both
  //    secrets before either length check, per the spec ordering.
  const discordToken = required(env, "DISCORD_TOKEN");
  const ipcToken = required(env, "IPC_TOKEN");
  if (discordToken.length < 30) throw new Error("DISCORD_TOKEN is too short to be a bot token");
  requireIpcTokenLength(ipcToken);

  // 3. File existence, JSONC parse, and root-type check.
  const root = parseConfigSource(source);

  // 4. Global integer properties (in fixed order).
  const ipcPort = integerProp(root, "ipcPort", 47_652, 1_024, 65_535);
  const queueLimit = integerProp(root, "queueLimit", 100, 1, 1_000);
  const ackRetries = integerProp(root, "ackRetries", 2, 0, 5);
  const sendIntervalMs = integerProp(root, "sendIntervalMs", 1_000, 250, 60_000);
  const configTimeoutMs = integerProp(root, "configTimeoutMs", 30_000, 5_000, 120_000);
  const dedupTtlMs = integerProp(root, "dedupTtlMs", 300_000, 10_000, 3_600_000);

  // 5. Channel array presence and count.
  const channels = root["channels"];
  if (!Array.isArray(channels)) throw new Error("config.jsonc channels must be an array");
  if (channels.length === 0 || channels.length > 8) {
    throw new Error(`config.jsonc must define 1 to 8 channel pairs; found ${channels.length}`);
  }

  // 6. Per-entry shape, ID format, name byte length (in array order).
  const pairs: ChannelPairConfig[] = [];
  for (let index = 0; index < channels.length; index += 1) {
    const entry = channels[index] as unknown;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`config.jsonc channels[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const discordChannelId = record["discordChannelId"];
    if (typeof discordChannelId !== "string" || !/^\d{17,20}$/.test(discordChannelId)) {
      throw new Error(`config.jsonc channels[${index}].discordChannelId ${JSON.stringify(discordChannelId)} must match ^\\d{17,20}$`);
    }
    const meshtasticChannelName = record["meshtasticChannelName"];
    const nameBytes = typeof meshtasticChannelName === "string" ? Buffer.byteLength(meshtasticChannelName, "utf8") : -1;
    if (typeof meshtasticChannelName !== "string" || nameBytes < 1 || nameBytes > 11) {
      throw new Error(`config.jsonc channels[${index}].meshtasticChannelName ${JSON.stringify(meshtasticChannelName)} must be 1 to 11 UTF-8 bytes`);
    }
    pairs.push({ discordChannelId, meshtasticChannelName });
  }

  // 7. Duplicate Discord ID check (in array order).
  const seenIds = new Set<string>();
  for (const { discordChannelId } of pairs) {
    if (seenIds.has(discordChannelId)) {
      throw new Error(`Duplicate discordChannelId ${JSON.stringify(discordChannelId)} in config.jsonc`);
    }
    seenIds.add(discordChannelId);
  }

  // 8. Duplicate Meshtastic name check (in array order).
  const seenNames = new Set<string>();
  for (const { meshtasticChannelName } of pairs) {
    if (seenNames.has(meshtasticChannelName)) {
      throw new Error(`Duplicate meshtasticChannelName ${JSON.stringify(meshtasticChannelName)} in config.jsonc`);
    }
    seenNames.add(meshtasticChannelName);
  }

  return {
    discordToken,
    ipcToken,
    ipcPort,
    queueLimit,
    ackRetries,
    sendIntervalMs,
    configTimeoutMs,
    dedupTtlMs,
    channels: pairs,
  };
}

export function loadEnvironment(): string | undefined {
  const envPath = resolve(".env");
  if (existsSync(envPath)) {
    loadEnvFile(envPath);
    return envPath;
  }
  return undefined;
}

export function loadConfig(): Config {
  loadEnvironment();
  const configPath = resolve("config.jsonc");
  const source = existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined;
  return parseConfig(process.env, source);
}

// IPC-only load path: validates only what the TUI uses (IPC_TOKEN + ipcPort).
// It reuses the same shared helpers as parseConfig, so presence, placeholder,
// length, file, parse, root-type, and ipcPort-range messages are identical. It
// deliberately does NOT read DISCORD_TOKEN, does NOT read IPC_PORT or any other
// env value, and does NOT require a valid channels array.
export function parseIpcConfig(env: NodeJS.ProcessEnv, source: string | undefined): Pick<Config, "ipcToken" | "ipcPort"> {
  // 1. Legacy env cutover check — still fatal on this path.
  checkLegacyEnv(env);

  // 2. IPC_TOKEN presence, placeholder, and length (same rules as the full path).
  const ipcToken = required(env, "IPC_TOKEN");
  requireIpcTokenLength(ipcToken);

  // 3. File existence, JSONC parse, and root-type check.
  const root = parseConfigSource(source);

  // 4. Only the ipcPort integer/range rule; channels are intentionally ignored.
  const ipcPort = integerProp(root, "ipcPort", 47_652, 1_024, 65_535);

  return { ipcToken, ipcPort };
}

export function loadIpcConfig(): Pick<Config, "ipcToken" | "ipcPort"> {
  loadEnvironment();
  const configPath = resolve("config.jsonc");
  const source = existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined;
  return parseIpcConfig(process.env, source);
}

export function unsafeEnvPermissions(envPath: string | undefined): string[] {
  if (!envPath || process.platform !== "win32") return [];
  const result = spawnSync("icacls.exe", [envPath], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return ["could not inspect .env ACLs"];
  const broad = /(?:Everyone|BUILTIN\\Users|Authenticated Users).*\((?:F|M|W|R|RX)\)/i;
  return result.stdout.split(/\r?\n/u).filter((line) => broad.test(line)).map((line) => line.trim());
}
