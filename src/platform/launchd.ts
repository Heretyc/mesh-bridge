export interface LaunchdPlistInput {
  label: string;
  nodePath: string;
  servicePath: string;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
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

export function launchAgentPlist(input: LaunchdPlistInput): string {
  return [
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
  ].join("\n");
}

export function commandFile(input: CommandFileInput): string {
  const args = [input.scriptPath, ...(input.args ?? [])].map((part) => `'${part.replace(/'/gu, `'\\''`)}'`).join(" ");
  return `#!/bin/sh\nexec '${input.nodePath.replace(/'/gu, `'\\''`)}' ${args}\n`;
}
