export interface LaunchdPlistInput {
  label: string;
  nodePath: string;
  servicePath: string;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  // Set for a system-domain LaunchDaemon so the job drops to a dedicated
  // unprivileged account instead of running as root. Omit for a plain agent.
  userName?: string;
  groupName?: string;
  // Pins MESH_BRIDGE_STATE_DIR for the job so a daemon account writes state
  // to a system location it owns, not a specific user's home.
  stateDir?: string;
}

export interface CommandFileInput {
  nodePath: string;
  scriptPath: string;
  args?: string[];
}

function xml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

// Builds a launchd property list. With no `userName`/`stateDir` it is a plain
// per-user agent; supplying them turns it into a system-domain LaunchDaemon
// that drops privileges to a dedicated account and writes state to a system dir.
export function launchAgentPlist(input: LaunchdPlistInput): string {
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${xml(input.label)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${xml(input.nodePath)}</string>`,
    `    <string>${xml(input.servicePath)}</string>`,
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${xml(input.workingDirectory)}</string>`,
  ];
  if (input.userName !== undefined) {
    lines.push(
      `  <key>UserName</key>`,
      `  <string>${xml(input.userName)}</string>`,
      `  <key>GroupName</key>`,
      `  <string>${xml(input.groupName ?? input.userName)}</string>`,
    );
  }
  if (input.stateDir !== undefined) {
    lines.push(
      `  <key>EnvironmentVariables</key>`,
      `  <dict>`,
      `    <key>MESH_BRIDGE_STATE_DIR</key>`,
      `    <string>${xml(input.stateDir)}</string>`,
      `  </dict>`,
    );
  }
  lines.push(
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>ProcessType</key>`,
    `  <string>Background</string>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>10</integer>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xml(input.stdoutPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xml(input.stderrPath)}</string>`,
    `</dict>`,
    `</plist>`,
    "",
  );
  return lines.join("\n");
}

export function commandFile(input: CommandFileInput): string {
  const args = [input.scriptPath, ...(input.args ?? [])].map((part) => `'${part.replace(/'/gu, `'\\''`)}'`).join(" ");
  return `#!/bin/sh\nexec '${input.nodePath.replace(/'/gu, `'\\''`)}' ${args}\n`;
}
