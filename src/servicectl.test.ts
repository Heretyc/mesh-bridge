import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { runServiceCtl, type ServiceCtlDeps } from "./servicectl.js";

interface Call {
  command: string;
  args: string[];
  stdio: unknown;
}

function deps(exitCodes: number[] = [], stdout: string[] = []): ServiceCtlDeps & { calls: Call[]; writes: string[]; errors: string[] } {
  const calls: Call[] = [];
  const writes: string[] = [];
  const errors: string[] = [];
  const fakeSpawn = ((command: string, args: string[] = [], options: { stdio?: unknown } = {}) => {
    calls.push({ command, args: [...args], stdio: options.stdio });
    return {
      status: exitCodes.shift() ?? 0,
      signal: null,
      output: [],
      pid: 1,
      stdout: Buffer.from(stdout.shift() ?? ""),
      stderr: Buffer.from(""),
    };
  }) as unknown as ServiceCtlDeps["spawnSync"];
  return {
    calls,
    writes,
    errors,
    execPath: "/bin/node",
    cwd: () => "/repo",
    homedir: () => "/home/lexi",
    uid: () => 501,
    user: () => "lexi",
    stdout: (text) => { writes.push(text); },
    stderr: (text) => { errors.push(text); },
    spawnSync: fakeSpawn,
    writeFileSync: (path, data) => writes.push(`${path}:${String(data).split("\n")[0]}`),
    mkdirSync: () => undefined,
    rmSync: (path) => writes.push(`rm:${path}`),
    existsSync: () => true,
    chmod: async (path, mode) => { writes.push(`chmod:${path}:${mode.toString(8)}`); },
  } as ServiceCtlDeps & { calls: Call[]; writes: string[]; errors: string[] };
}

test("win32 maps service verbs to the existing PowerShell scripts", async () => {
  const d = deps([0, 0, 0, 3], ["", "", "", "NOT_INSTALLED"]);
  assert.equal(await runServiceCtl(["install"], "win32", d), 0);
  assert.equal(await runServiceCtl(["start"], "win32", d), 0);
  assert.equal(await runServiceCtl(["stop"], "win32", d), 0);
  assert.equal(await runServiceCtl(["status"], "win32", d), 3);
  assert.deepEqual(d.calls.map((call) => call.args.at(-1)), [
    "scripts/install.ps1",
    "scripts/start.ps1",
    "scripts/stop.ps1",
    "scripts/status.ps1",
  ]);
  assert.deepEqual(d.calls.map((call) => call.command), ["powershell", "powershell", "powershell", "powershell"]);
  assert.equal(d.writes.at(-1), "win32 installed=false running=false autostart=false\n");
});

test("linux install writes unit and launchers, then enables user service and linger", async () => {
  const d = deps();
  assert.equal(await runServiceCtl(["install"], "linux", d), 0);
  assert.deepEqual(d.calls.map((call) => [call.command, ...call.args]), [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", "mesh-bridge.service"],
    ["loginctl", "enable-linger", "lexi"],
  ]);
  assert.ok(d.writes.some((write) => write.startsWith("/home/lexi/.config/systemd/user/mesh-bridge.service:[Unit]")));
  assert.ok(d.writes.some((write) => write.startsWith("/home/lexi/.local/share/applications/mesh-bridge-attach.desktop:[Desktop Entry]")));
  assert.ok(d.writes.some((write) => write.startsWith("/home/lexi/.local/share/applications/mesh-bridge-restart.desktop:[Desktop Entry]")));
});

test("linux status reports OS service state only", async () => {
  const d = deps([0, 0], ["active", "enabled"]);
  assert.equal(await runServiceCtl(["status"], "linux", d), 0);
  assert.deepEqual(d.calls.map((call) => [call.command, ...call.args]), [
    ["systemctl", "--user", "is-active", "mesh-bridge.service"],
    ["systemctl", "--user", "is-enabled", "mesh-bridge.service"],
  ]);
  assert.deepEqual(d.writes, ["linux installed=true running=true autostart=true\n"]);
});

test("darwin maps launchd install, start, stop, status, and restart", async () => {
  const d = deps();
  assert.equal(await runServiceCtl(["install"], "darwin", d), 0);
  assert.equal(await runServiceCtl(["start"], "darwin", d), 0);
  assert.equal(await runServiceCtl(["stop"], "darwin", d), 0);
  assert.equal(await runServiceCtl(["restart"], "darwin", d), 0);
  assert.equal(await runServiceCtl(["status"], "darwin", d), 0);
  assert.deepEqual(d.calls.map((call) => [call.command, ...call.args]), [
    ["launchctl", "bootstrap", "gui/501", "/home/lexi/Library/LaunchAgents/dev.meshbridge.plist"],
    ["launchctl", "kickstart", "-k", "gui/501/dev.meshbridge"],
    ["launchctl", "bootout", "gui/501/dev.meshbridge"],
    ["launchctl", "kickstart", "-k", "gui/501/dev.meshbridge"],
    ["launchctl", "print", "gui/501/dev.meshbridge"],
  ]);
  assert.ok(d.writes.includes("darwin installed=true running=true autostart=true\n"));
});

test("unknown verbs and unsupported platforms fail closed", async () => {
  const d = deps();
  assert.equal(await runServiceCtl(["bogus"], "linux", d), 2);
  assert.equal(await runServiceCtl(["status"], "freebsd" as NodeJS.Platform, d), 2);
  assert.deepEqual(d.calls, []);
  assert.deepEqual(d.errors, ["Unknown service verb: bogus\n", "Unsupported platform: freebsd\n"]);
});
