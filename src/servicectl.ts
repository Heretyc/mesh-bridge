import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { commandFile, launchAgentPlist } from "./platform/launchd.js";
import { desktopEntry, systemdUserUnit } from "./platform/systemd.js";

type Verb = "install" | "start" | "stop" | "status" | "uninstall" | "attach" | "restart";
type Platform = "win32" | "linux" | "darwin";

export interface ServiceCtlDeps {
  spawnSync: typeof spawnSync;
  writeFileSync: typeof writeFileSync;
  mkdirSync: typeof mkdirSync;
  rmSync: typeof rmSync;
  existsSync: typeof existsSync;
  chmod: typeof chmod;
  cwd: () => string;
  homedir: () => string;
  uid: () => number;
  user: () => string;
  execPath: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const verbs = new Set<Verb>(["install", "start", "stop", "status", "uninstall", "attach", "restart"]);
const serviceName = "mesh-bridge.service";
const launchLabel = "dev.meshbridge";
// macOS runs as a system-domain LaunchDaemon (survives logout/reboot), not a
// per-user GUI agent. It drops privileges to this dedicated account and writes
// state under a system directory that account owns.
const darwinDomain = "system";
const darwinTarget = `${darwinDomain}/${launchLabel}`;
const darwinAccount = "_meshbridge";

function defaultDeps(): ServiceCtlDeps {
  return {
    spawnSync,
    writeFileSync,
    mkdirSync,
    rmSync,
    existsSync,
    chmod,
    cwd: () => process.cwd(),
    homedir,
    uid: () => process.getuid?.() ?? 0,
    user: () => userInfo().username,
    execPath: process.execPath,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

function run(deps: ServiceCtlDeps, command: string, args: string[], stdio: "inherit" | "pipe" = "inherit"): SpawnSyncReturns<Buffer> {
  return deps.spawnSync(command, args, { stdio, encoding: "buffer" }) as SpawnSyncReturns<Buffer>;
}

function code(result: SpawnSyncReturns<Buffer>): number {
  if (result.error) return 1;
  return result.status ?? 1;
}

function text(buffer: Buffer | string | null | undefined): string {
  return Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer ?? "");
}

function script(name: string): string {
  return `scripts/${name}.ps1`;
}

function win(deps: ServiceCtlDeps, verb: Verb): number {
  if (verb === "attach") return code(run(deps, deps.execPath, [join("dist", "tui.js")]));
  if (verb === "restart") {
    const stopped = win(deps, "stop");
    return stopped === 0 ? win(deps, "start") : stopped;
  }
  const result = run(deps, "powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script(verb)], verb === "status" ? "pipe" : "inherit");
  const exitCode = code(result);
  if (verb !== "status") return exitCode;
  const output = `${text(result.stdout)}${text(result.stderr)}`;
  const installed = exitCode !== 3 && !/NOT_INSTALLED|not installed/iu.test(output);
  const running = installed && (exitCode === 0 || /running|started/iu.test(output));
  deps.stdout(`win32 installed=${installed} running=${running} autostart=${installed}\n`);
  return running ? 0 : installed ? 1 : 3;
}

function linuxPaths(deps: ServiceCtlDeps) {
  const home = deps.homedir();
  const cwd = deps.cwd();
  return {
    unit: posix.join(home, ".config", "systemd", "user", serviceName),
    attachDesktop: posix.join(home, ".local", "share", "applications", "mesh-bridge-attach.desktop"),
    restartDesktop: posix.join(home, ".local", "share", "applications", "mesh-bridge-restart.desktop"),
    service: posix.join(cwd, "dist", "service.js"),
    tui: posix.join(cwd, "dist", "tui.js"),
    ctl: posix.join(cwd, "dist", "servicectl.js"),
    cwd,
  };
}

function linuxInstall(deps: ServiceCtlDeps): number {
  const p = linuxPaths(deps);
  deps.mkdirSync(posix.dirname(p.unit), { recursive: true });
  deps.writeFileSync(p.unit, systemdUserUnit({
    nodePath: deps.execPath,
    servicePath: p.service,
    workingDirectory: p.cwd,
    envFile: posix.join(p.cwd, ".env"),
  }));
  deps.mkdirSync(posix.dirname(p.attachDesktop), { recursive: true });
  deps.writeFileSync(p.attachDesktop, desktopEntry({ name: "Mesh Bridge Attach", exec: `${deps.execPath} ${p.tui}` }));
  deps.writeFileSync(p.restartDesktop, desktopEntry({ name: "Mesh Bridge Restart", exec: `${deps.execPath} ${p.ctl} restart` }));
  let result = run(deps, "systemctl", ["--user", "daemon-reload"]);
  if (code(result) !== 0) return code(result);
  result = run(deps, "systemctl", ["--user", "enable", "--now", serviceName]);
  if (code(result) !== 0) return code(result);
  result = run(deps, "loginctl", ["enable-linger", deps.user()]);
  return code(result);
}

function linuxStatus(deps: ServiceCtlDeps): number {
  const active = run(deps, "systemctl", ["--user", "is-active", serviceName], "pipe");
  const enabled = run(deps, "systemctl", ["--user", "is-enabled", serviceName], "pipe");
  const enabledText = text(enabled.stdout).trim();
  const running = code(active) === 0 && text(active.stdout).trim() === "active";
  const installed = !/not-found|No such file/iu.test(`${text(enabled.stdout)}${text(enabled.stderr)}`) && enabledText !== "";
  const autostart = code(enabled) === 0 && enabledText === "enabled";
  deps.stdout(`linux installed=${installed} running=${running} autostart=${autostart}\n`);
  return running ? 0 : installed ? 1 : 3;
}

function linux(deps: ServiceCtlDeps, verb: Verb): number {
  if (verb === "attach") return code(run(deps, deps.execPath, [join("dist", "tui.js")]));
  if (verb === "install") return linuxInstall(deps);
  if (verb === "status") return linuxStatus(deps);
  if (verb === "uninstall") {
    const disabled = run(deps, "systemctl", ["--user", "disable", "--now", serviceName]);
    if (code(disabled) !== 0) return code(disabled);
    deps.rmSync(linuxPaths(deps).unit, { force: true });
    return code(run(deps, "systemctl", ["--user", "daemon-reload"]));
  }
  const action = verb === "restart" ? "restart" : verb;
  return code(run(deps, "systemctl", ["--user", action, serviceName]));
}

function darwinPaths(deps: ServiceCtlDeps) {
  const home = deps.homedir();
  const cwd = deps.cwd();
  // System-domain daemon: plist and writable state live outside any user home
  // so the job survives logout and its unprivileged account can own them.
  const stateRoot = posix.join("/", "Library", "Application Support", "Mesh Bridge");
  const logDir = posix.join(stateRoot, "Logs");
  return {
    plist: posix.join("/", "Library", "LaunchDaemons", `${launchLabel}.plist`),
    stateRoot,
    logDir,
    // Interactive helpers stay in the invoking user's ~/Applications.
    attach: posix.join(home, "Applications", "Mesh Bridge Attach.command"),
    restart: posix.join(home, "Applications", "Mesh Bridge Restart.command"),
    service: posix.join(cwd, "dist", "service.js"),
    tui: posix.join(cwd, "dist", "tui.js"),
    ctl: posix.join(cwd, "dist", "servicectl.js"),
    cwd,
  };
}

// Loading/booting a system-domain daemon requires root. Fail closed with an
// explicit, actionable message instead of surfacing a raw launchctl error.
function darwinRequireRoot(deps: ServiceCtlDeps, verb: Verb): boolean {
  if (deps.uid() === 0) return true;
  deps.stderr(`service:${verb} manages the system LaunchDaemon ${launchLabel} and must run as root. Re-run with sudo.\n`);
  return false;
}

function darwinLoaded(deps: ServiceCtlDeps): boolean {
  return code(run(deps, "launchctl", ["print", darwinTarget], "pipe")) === 0;
}

async function darwinInstall(deps: ServiceCtlDeps): Promise<number> {
  const p = darwinPaths(deps);
  deps.mkdirSync(posix.dirname(p.plist), { recursive: true });
  deps.mkdirSync(p.logDir, { recursive: true });
  deps.writeFileSync(p.plist, launchAgentPlist({
    label: launchLabel,
    nodePath: deps.execPath,
    servicePath: p.service,
    workingDirectory: p.cwd,
    stdoutPath: posix.join(p.logDir, "service.out.log"),
    stderrPath: posix.join(p.logDir, "service.err.log"),
    userName: darwinAccount,
    stateDir: p.stateRoot,
  }));
  deps.mkdirSync(posix.dirname(p.attach), { recursive: true });
  deps.writeFileSync(p.attach, commandFile({ nodePath: deps.execPath, scriptPath: p.tui }));
  deps.writeFileSync(p.restart, commandFile({ nodePath: deps.execPath, scriptPath: p.ctl, args: ["restart"] }));
  await deps.chmod(p.attach, 0o755);
  await deps.chmod(p.restart, 0o755);
  return code(run(deps, "launchctl", ["bootstrap", darwinDomain, p.plist]));
}

function darwinUninstall(deps: ServiceCtlDeps): number {
  const p = darwinPaths(deps);
  // Unload first (best effort — it may already be unloaded), then delete every
  // generated artifact: the plist and both .command launchers.
  run(deps, "launchctl", ["bootout", darwinTarget]);
  deps.rmSync(p.plist, { force: true });
  deps.rmSync(p.attach, { force: true });
  deps.rmSync(p.restart, { force: true });
  return 0;
}

function darwinStatus(deps: ServiceCtlDeps): number {
  const result = run(deps, "launchctl", ["print", darwinTarget], "pipe");
  const installed = deps.existsSync(darwinPaths(deps).plist);
  const running = code(result) === 0;
  deps.stdout(`darwin installed=${installed} running=${running} autostart=${installed}\n`);
  return running ? 0 : installed ? 1 : 3;
}

async function darwin(deps: ServiceCtlDeps, verb: Verb): Promise<number> {
  if (verb === "attach") return code(run(deps, deps.execPath, [join("dist", "tui.js")]));
  if (verb === "status") return darwinStatus(deps);
  if (!darwinRequireRoot(deps, verb)) return 1;
  if (verb === "install") return darwinInstall(deps);
  if (verb === "uninstall") return darwinUninstall(deps);
  // stop = unload the job WITHOUT deleting any artifacts, so a later start can
  // re-bootstrap it. (Previously stop and uninstall both booted out, and start
  // always kickstarted — so start after stop failed on an unloaded label.)
  if (verb === "stop") return code(run(deps, "launchctl", ["bootout", darwinTarget]));
  // start = bootstrap when the label is unloaded, else kickstart the loaded job.
  if (verb === "start") {
    if (darwinLoaded(deps)) return code(run(deps, "launchctl", ["kickstart", darwinTarget]));
    return code(run(deps, "launchctl", ["bootstrap", darwinDomain, darwinPaths(deps).plist]));
  }
  // restart = kickstart -k (stop+start in one) when loaded, else bootstrap.
  if (darwinLoaded(deps)) return code(run(deps, "launchctl", ["kickstart", "-k", darwinTarget]));
  return code(run(deps, "launchctl", ["bootstrap", darwinDomain, darwinPaths(deps).plist]));
}

export async function runServiceCtl(argv: string[], platform: NodeJS.Platform = process.platform, deps: ServiceCtlDeps = defaultDeps()): Promise<number> {
  const verb = argv[0];
  if (!verbs.has(verb as Verb)) {
    deps.stderr(`Unknown service verb: ${verb ?? "(missing)"}\n`);
    return 2;
  }
  if (platform === "win32") return win(deps, verb as Verb);
  if (platform === "linux") return linux(deps, verb as Verb);
  if (platform === "darwin") return darwin(deps, verb as Verb);
  deps.stderr(`Unsupported platform: ${platform}\n`);
  return 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runServiceCtl(process.argv.slice(2));
}
