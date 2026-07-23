import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { spawnSync } from "node:child_process";

export interface Config {
  discordToken: string;
  discordChannelId: string;
  meshChannelName: string;
  ipcToken: string;
  ipcPort: number;
  queueLimit: number;
  ackRetries: number;
  sendIntervalMs: number;
  configTimeoutMs: number;
  dedupTtlMs: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value || /^(replace|change)[-_ ]?me$/i.test(value)) {
    throw new Error(`Missing required configuration: ${name}`);
  }
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const discordToken = required(env, "DISCORD_TOKEN");
  const discordChannelId = required(env, "DISCORD_CHANNEL_ID");
  const meshChannelName = required(env, "MESHTASTIC_CHANNEL_NAME");
  const ipcToken = required(env, "IPC_TOKEN");

  if (!/^\d{17,20}$/.test(discordChannelId)) throw new Error("DISCORD_CHANNEL_ID must be a Discord snowflake");
  const channelBytes = Buffer.byteLength(meshChannelName, "utf8");
  if (channelBytes > 11) throw new Error("MESHTASTIC_CHANNEL_NAME must be at most 11 UTF-8 bytes");
  if (ipcToken.length < 32) throw new Error("IPC_TOKEN must be at least 32 characters");
  if (discordToken.length < 30) throw new Error("DISCORD_TOKEN is too short to be a bot token");

  return {
    discordToken,
    discordChannelId,
    meshChannelName,
    ipcToken,
    ipcPort: integer(env, "IPC_PORT", 47_652, 1_024, 65_535),
    queueLimit: integer(env, "QUEUE_LIMIT", 100, 1, 1_000),
    ackRetries: integer(env, "MESH_ACK_RETRIES", 2, 0, 5),
    sendIntervalMs: integer(env, "MESH_SEND_INTERVAL_MS", 1_000, 250, 60_000),
    configTimeoutMs: integer(env, "MESH_CONFIG_TIMEOUT_MS", 30_000, 5_000, 120_000),
    dedupTtlMs: integer(env, "DEDUP_TTL_MS", 300_000, 10_000, 3_600_000),
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
  return parseConfig(process.env);
}

export function loadIpcConfig(): Pick<Config, "ipcToken" | "ipcPort"> {
  loadEnvironment();
  const ipcToken = required(process.env, "IPC_TOKEN");
  if (ipcToken.length < 32) throw new Error("IPC_TOKEN must be at least 32 characters");
  return { ipcToken, ipcPort: integer(process.env, "IPC_PORT", 47_652, 1_024, 65_535) };
}

export function unsafeEnvPermissions(envPath: string | undefined): string[] {
  if (!envPath || process.platform !== "win32") return [];
  const result = spawnSync("icacls.exe", [envPath], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return ["could not inspect .env ACLs"];
  const broad = /(?:Everyone|BUILTIN\\Users|Authenticated Users).*\((?:F|M|W|R|RX)\)/i;
  return result.stdout.split(/\r?\n/u).filter((line) => broad.test(line)).map((line) => line.trim());
}
