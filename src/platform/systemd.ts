export interface SystemdUnitInput {
  nodePath: string;
  servicePath: string;
  workingDirectory: string;
  envFile: string;
  description?: string;
}

export interface DesktopEntryInput {
  name: string;
  exec: string;
}

export function systemdUserUnit(input: SystemdUnitInput): string {
  return [
    "[Unit]",
    `Description=${input.description ?? "Mesh Bridge Discord to Meshtastic bridge"}`,
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${input.nodePath} ${input.servicePath}`,
    `WorkingDirectory=${input.workingDirectory}`,
    `EnvironmentFile=${input.envFile}`,
    "Restart=always",
    "RestartSec=10",
    "TimeoutStopSec=20",
    "KillSignal=SIGTERM",
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function desktopEntry(input: DesktopEntryInput): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${input.name}`,
    `Exec=${input.exec}`,
    "Terminal=true",
    "Categories=Utility;",
    "",
  ].join("\n");
}
