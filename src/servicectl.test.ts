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

test("win32 status reports a stopped installed service as not running", async () => {
  const d = deps([1], ["Stopped"]);
  assert.equal(await runServiceCtl(["status"], "win32", d), 1);
  assert.equal(d.writes.at(-1), "win32 installed=true running=false autostart=true\n");
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

// launchctl double that tracks loaded/unloaded state in the system domain, so
// verb sequencing (start-after-stop, restart, uninstall) is exercised for real.
// Runs as root (uid 0) because system-domain daemon control requires it.
function darwinDeps(): ServiceCtlDeps & { calls: Call[]; writes: string[]; errors: string[]; loaded: () => boolean } {
  const calls: Call[] = [];
  const writes: string[] = [];
  const errors: string[] = [];
  let loaded = false;
  const fakeSpawn = ((command: string, args: string[] = [], options: { stdio?: unknown } = {}) => {
    calls.push({ command, args: [...args], stdio: options.stdio });
    let status = 0;
    if (command === "launchctl") {
      const sub = args[0];
      if (sub === "print") status = loaded ? 0 : 1;
      else if (sub === "bootstrap") { status = loaded ? 1 : 0; loaded = true; }
      else if (sub === "bootout") { status = loaded ? 0 : 1; loaded = false; }
      else if (sub === "kickstart") status = loaded ? 0 : 1;
    }
    return { status, signal: null, output: [], pid: 1, stdout: Buffer.from(""), stderr: Buffer.from("") };
  }) as unknown as ServiceCtlDeps["spawnSync"];
  return {
    calls,
    writes,
    errors,
    loaded: () => loaded,
    execPath: "/bin/node",
    cwd: () => "/repo",
    homedir: () => "/Users/lexi",
    uid: () => 0,
    user: () => "lexi",
    stdout: (text) => { writes.push(text); },
    stderr: (text) => { errors.push(text); },
    spawnSync: fakeSpawn,
    writeFileSync: (path, data) => writes.push(`${path}:${String(data).split("\n")[0]}`),
    mkdirSync: () => undefined,
    rmSync: (path) => writes.push(`rm:${path}`),
    existsSync: () => true,
    chmod: async (path, mode) => { writes.push(`chmod:${path}:${mode.toString(8)}`); },
  } as ServiceCtlDeps & { calls: Call[]; writes: string[]; errors: string[]; loaded: () => boolean };
}

test("darwin installs a system LaunchDaemon and drives distinct verb semantics", async () => {
  const d = darwinDeps();
  const label = "dev.meshbridge";
  const plist = "/Library/LaunchDaemons/dev.meshbridge.plist";

  // install: bootstrap into the system domain, writing the plist there.
  assert.equal(await runServiceCtl(["install"], "darwin", d), 0);
  assert.deepEqual(d.calls.at(-1), { command: "launchctl", args: ["bootstrap", "system", plist], stdio: "inherit" });
  assert.ok(d.writes.some((w) => w.startsWith(`${plist}:<?xml`)), "writes plist to /Library/LaunchDaemons");
  assert.ok(d.loaded());

  // start while loaded: plain kickstart (no -k), not another bootstrap.
  assert.equal(await runServiceCtl(["start"], "darwin", d), 0);
  assert.deepEqual(d.calls.at(-1), { command: "launchctl", args: ["kickstart", `system/${label}`], stdio: "inherit" });

  // stop: bootout only — no artifact deletion.
  assert.equal(await runServiceCtl(["stop"], "darwin", d), 0);
  assert.deepEqual(d.calls.at(-1), { command: "launchctl", args: ["bootout", `system/${label}`], stdio: "inherit" });
  assert.ok(!d.loaded());
  assert.ok(!d.writes.some((w) => w.startsWith("rm:")), "stop must not remove artifacts");

  // start after stop: label is unloaded, so it must bootstrap again (P4-008).
  const before = d.calls.length;
  assert.equal(await runServiceCtl(["start"], "darwin", d), 0);
  assert.deepEqual(d.calls.slice(before).map((c) => [c.command, ...c.args]), [
    ["launchctl", "print", `system/${label}`],
    ["launchctl", "bootstrap", "system", plist],
  ]);
  assert.ok(d.loaded());

  // restart while loaded: kickstart -k.
  assert.equal(await runServiceCtl(["restart"], "darwin", d), 0);
  assert.deepEqual(d.calls.at(-1), { command: "launchctl", args: ["kickstart", "-k", `system/${label}`], stdio: "inherit" });

  // status: print the system target.
  assert.equal(await runServiceCtl(["status"], "darwin", d), 0);
  assert.ok(d.writes.includes("darwin installed=true running=true autostart=true\n"));
});

test("darwin uninstall boots out and removes the plist and both launchers", async () => {
  const d = darwinDeps();
  await runServiceCtl(["install"], "darwin", d);
  const start = d.calls.length;
  assert.equal(await runServiceCtl(["uninstall"], "darwin", d), 0);
  assert.deepEqual(d.calls.slice(start).map((c) => [c.command, ...c.args]), [
    ["launchctl", "bootout", "system/dev.meshbridge"],
  ]);
  assert.ok(d.writes.includes("rm:/Library/LaunchDaemons/dev.meshbridge.plist"));
  assert.ok(d.writes.includes("rm:/Users/lexi/Applications/Mesh Bridge Attach.command"));
  assert.ok(d.writes.includes("rm:/Users/lexi/Applications/Mesh Bridge Restart.command"));
  assert.ok(!d.loaded());
});

test("darwin refuses privileged verbs without root and makes sudo explicit", async () => {
  const d = darwinDeps();
  d.uid = () => 501;
  for (const verb of ["install", "start", "stop", "restart", "uninstall"]) {
    assert.equal(await runServiceCtl([verb], "darwin", d), 1);
  }
  assert.deepEqual(d.calls, [], "no launchctl calls when unprivileged");
  assert.ok(d.errors.every((e) => /must run as root|sudo/u.test(e)));
  assert.equal(d.errors.length, 5);
});

test("unknown verbs and unsupported platforms fail closed", async () => {
  const d = deps();
  assert.equal(await runServiceCtl(["bogus"], "linux", d), 2);
  assert.equal(await runServiceCtl(["status"], "freebsd" as NodeJS.Platform, d), 2);
  assert.deepEqual(d.calls, []);
  assert.deepEqual(d.errors, ["Unknown service verb: bogus\n", "Unsupported platform: freebsd\n"]);
});
