import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface MeshBridgePaths {
  stateRoot: string;
  logDir: string;
  journalDir: string;
}

type Env = Record<string, string | undefined>;

function pathApi(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === "win32" ? win32 : posix;
}

export function resolveMeshBridgePaths(platform: NodeJS.Platform, env: Env, home: string): MeshBridgePaths {
  const override = env.MESH_BRIDGE_STATE_DIR?.trim();
  const p = pathApi(platform);
  if (override) {
    return {
      stateRoot: override,
      logDir: p.join(override, "Logs"),
      journalDir: p.join(override, "journal"),
    };
  }

  if (platform === "win32") {
    const root = p.join(env.ProgramData ?? "C:\\ProgramData", "Mesh Bridge");
    return { stateRoot: root, logDir: p.join(root, "Logs"), journalDir: p.join(root, "journal") };
  }

  if (platform === "darwin") {
    const state = p.join(home, "Library", "Application Support", "Mesh Bridge");
    return {
      stateRoot: state,
      logDir: p.join(home, "Library", "Logs", "Mesh Bridge"),
      journalDir: p.join(state, "journal"),
    };
  }

  const stateBase = env.XDG_STATE_HOME?.trim() || p.join(home, ".local", "state");
  const root = p.join(stateBase, "mesh-bridge");
  return { stateRoot: root, logDir: p.join(root, "logs"), journalDir: p.join(root, "journal") };
}

export function stateRoot(): string {
  return resolveMeshBridgePaths(process.platform, process.env, homedir()).stateRoot;
}

export function logDir(): string {
  return resolveMeshBridgePaths(process.platform, process.env, homedir()).logDir;
}

export function journalDir(): string {
  return resolveMeshBridgePaths(process.platform, process.env, homedir()).journalDir;
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
