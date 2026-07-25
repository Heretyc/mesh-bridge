import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandFile, launchAgentPlist } from "./platform/launchd.js";
import { desktopEntry, systemdUserUnit } from "./platform/systemd.js";

function assertWellFormedXml(source: string): void {
  const stack: string[] = [];
  for (const match of source.matchAll(/<\/?([A-Za-z][\w.-]*)(?:\s[^>]*)?>/gu)) {
    const tag = match[1];
    if (tag === undefined) throw new Error(`Malformed XML tag: ${match[0]}`);
    const raw = match[0];
    if (raw.startsWith("<?") || raw.startsWith("<!")) continue;
    if (raw.endsWith("/>")) continue;
    if (raw.startsWith("</")) assert.equal(stack.pop(), tag);
    else stack.push(tag);
  }
  assert.deepEqual(stack, []);
}

test("systemd user unit contains the required service directives", () => {
  const unit = systemdUserUnit({
    nodePath: "/usr/bin/node",
    servicePath: "/opt/mesh/dist/service.js",
    workingDirectory: "/opt/mesh",
    envFile: "/opt/mesh/.env",
  });
  for (const line of [
    "Description=Mesh Bridge Discord to Meshtastic bridge",
    "After=network-online.target",
    "Type=simple",
    "ExecStart=/usr/bin/node /opt/mesh/dist/service.js",
    "WorkingDirectory=/opt/mesh",
    "EnvironmentFile=/opt/mesh/.env",
    "Restart=always",
    "RestartSec=10",
    "TimeoutStopSec=20",
    "KillSignal=SIGTERM",
    "StandardOutput=journal",
    "StandardError=journal",
    "WantedBy=default.target",
  ]) assert.match(unit, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"));
});

test("launchd plist is well-formed and escapes interpolated values", () => {
  const plist = launchAgentPlist({
    label: "dev.meshbridge",
    nodePath: "/usr/local/bin/node",
    servicePath: "/Users/Lexi/Mesh & Bridge/dist/service.js",
    workingDirectory: "/Users/Lexi/Mesh & Bridge",
    stdoutPath: "/Users/Lexi/Library/Logs/Mesh Bridge/service.out.log",
    stderrPath: "/Users/Lexi/Library/Logs/Mesh Bridge/service.err.log",
  });
  assert.match(plist, /<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1.0\/\/EN"/u);
  assertWellFormedXml(plist);
  for (const required of [
    "<key>Label</key>",
    "<string>dev.meshbridge</string>",
    "<key>RunAtLoad</key>\n  <true/>",
    "<key>KeepAlive</key>\n  <true/>",
    "<key>ProcessType</key>\n  <string>Background</string>",
    "<key>ThrottleInterval</key>\n  <integer>10</integer>",
    "Library/Logs/Mesh Bridge/service.out.log",
    "Library/Logs/Mesh Bridge/service.err.log",
    "/Users/Lexi/Mesh &amp; Bridge/dist/service.js",
  ]) assert.ok(plist.includes(required), required);
});

test("install.ps1 pins the audited WinSW binary and Windows service fields", () => {
  // The test runs from dist/platform.test.js, so walk up to the repo root.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const installScript = readFileSync(join(repoRoot, "scripts", "install.ps1"), "utf8");
  for (const required of [
    "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe",
    "05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA",
    "<id>MeshBridge</id>",
    "<name>Mesh Bridge</name>",
    "<domain>NT AUTHORITY</domain>",
    "<user>LocalService</user>",
    "<startmode>Automatic</startmode>",
    "<delayedAutoStart/>",
    "<stoptimeout>20 sec</stoptimeout>",
    '<onfailure action="restart" delay="10 sec" />',
  ]) assert.ok(installScript.includes(required), required);
});

test("install.ps1 provisions the ProgramData state root for LocalService without broadening access", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const installScript = readFileSync(join(repoRoot, "scripts", "install.ps1"), "utf8");
  // Creates the ProgramData state root plus its Logs and journal subfolders,
  // resolved the same way src/paths.ts does for win32.
  assert.match(installScript, /\$env:ProgramData/u);
  assert.match(installScript, /Join-Path \$programData 'Mesh Bridge'/u);
  assert.match(installScript, /Join-Path \$stateRoot 'Logs'/u);
  assert.match(installScript, /Join-Path \$stateRoot 'journal'/u);
  assert.match(
    installScript,
    /New-Item -ItemType Directory -Force -Path \$stateRoot, \$stateLogs, \$stateJournal/u,
  );
  // Grants exactly LocalService (SID S-1-5-19) modify on the state root, applied
  // recursively (/T) to its subfolders.
  assert.ok(
    installScript.includes("& icacls.exe $stateRoot /grant '*S-1-5-19:(OI)(CI)(M)' /T /C"),
    "LocalService modify grant on the ProgramData state root",
  );
  // Never widens access to broad principals: the files hold full message bodies.
  for (const forbidden of [
    "Everyone",
    "BUILTIN\\Users",
    "Authenticated Users",
    "*S-1-1-0",
    "*S-1-5-32-545",
    "*S-1-5-11",
  ]) {
    assert.ok(!installScript.includes(forbidden), `install.ps1 must not grant ${forbidden}`);
  }
});

test("native launcher builders emit terminal attach and restart commands", () => {
  assert.equal(desktopEntry({ name: "Mesh Bridge Attach", exec: "/usr/bin/node /opt/mesh/dist/tui.js" }), `[Desktop Entry]
Type=Application
Name=Mesh Bridge Attach
Exec=/usr/bin/node /opt/mesh/dist/tui.js
Terminal=true
Categories=Utility;
`);
  assert.equal(commandFile({ nodePath: "/usr/local/bin/node", scriptPath: "/opt/mesh/dist/servicectl.js", args: ["restart"] }), `#!/bin/sh
exec '/usr/local/bin/node' '/opt/mesh/dist/servicectl.js' 'restart'
`);
});
