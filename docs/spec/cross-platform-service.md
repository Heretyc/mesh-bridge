# Cross-Platform Service Operation

Mesh Bridge uses one command surface on every supported platform:

```bash
npm run service:install
npm run service:start
npm run service:stop
npm run service:status
npm run service:uninstall
npm run service:attach
npm run service:restart
```

`service:status` reports only the operating-system service state. Bridge health, links, queues, counters, and sanitized events stay in the read-only TUI; there is no HTTP endpoint, web server, or extra port.

## Windows

Windows keeps the audited PowerShell and WinSW path. `servicectl` shells `scripts/install.ps1`, `start.ps1`, `stop.ps1`, `status.ps1`, and `uninstall.ps1`.

The installer downloads pinned WinSW 2.12.0 x64, verifies its SHA-256, and installs service `MeshBridge` as `NT AUTHORITY\LocalService` with Automatic delayed start, `stoptimeout` 20 seconds, and restart on failure after 10 seconds. Service control requires elevated PowerShell.

On stop, WinSW first runs `scripts/send-shutdown.ps1` (`stopexecutable`), which sends the authenticated `shutdown` command over the local IPC port so the bridge exits through its graceful shutdown path in a few seconds. WinSW cannot deliver Ctrl+C to the Node child on Windows, so without this hook every stop waits out the full `stoptimeout` and ends in a force kill. The script is best effort and always exits 0; if IPC is unreachable, the stop falls back to the `stoptimeout` kill.

Because the service runs as `NT AUTHORITY\LocalService` (SID `S-1-5-19`), the installer also creates the `%ProgramData%\Mesh Bridge` state root and its `Logs` and `journal` subfolders. It resets stale descendant ACLs, breaks inherited permissions on the state root, and grants only SYSTEM full control, Administrators full control, and LocalService modify (`(OI)(CI)(M)`) so telemetry and the reply-mapping journal can be written without exposing the full message bodies they contain. Uninstall removes the service registration and retains `.env`, the wrapper, and the `%ProgramData%\Mesh Bridge` state (logs and journal) on disk.

Logs live under `%ProgramData%\Mesh Bridge\Logs`. Reply journals live under `%ProgramData%\Mesh Bridge\journal` unless `MESH_BRIDGE_STATE_DIR` is set, in which case logs use `<root>\Logs` and journals use `<root>\journal`.

USB discovery keeps the Windows rule: serial ports with `vendorId`, or `pnpId` beginning with `USB`, are probed.

## Linux

Install writes a systemd user unit to:

```text
~/.config/systemd/user/mesh-bridge.service
```

Autostart uses:

```bash
systemctl --user enable --now mesh-bridge.service
loginctl enable-linger "$USER"
```

The unit is intentionally a user unit, not a system unit, because the default log and journal paths are in the user's XDG state directory. Linger lets the user unit survive logout and reboot.

`service:start`, `service:stop`, and `service:restart` call `systemctl --user start|stop|restart mesh-bridge.service`. `service:uninstall` disables the user unit, removes it, and reloads the user daemon.

Install also writes terminal `.desktop` launchers for attach and restart under `~/.local/share/applications`.

Logs live under `${XDG_STATE_HOME:-$HOME/.local/state}/mesh-bridge/logs`. Reply journals live under `${XDG_STATE_HOME:-$HOME/.local/state}/mesh-bridge/journal`. With `MESH_BRIDGE_STATE_DIR`, logs use `<root>/Logs` and journals use `<root>/journal`.

USB discovery probes `/dev/ttyUSB*` and `/dev/ttyACM*`. The service user must be allowed to open the device. Most Debian/Ubuntu systems use `dialout`; some distributions use `uucp`. Add the user to the right group and log out and back in before starting the service.

## macOS

Install writes a launchd LaunchAgent to:

```text
~/Library/LaunchAgents/dev.meshbridge.plist
```

Autostart uses `RunAtLoad` and `KeepAlive`. `servicectl` installs with `launchctl bootstrap gui/<uid> <plist>`, stops or uninstalls with `launchctl bootout gui/<uid>/dev.meshbridge`, checks status with `launchctl print gui/<uid>/dev.meshbridge`, and starts or restarts with `launchctl kickstart -k gui/<uid>/dev.meshbridge`.

The service is a LaunchAgent, not a LaunchDaemon, because a daemon would run as root and could not own `~/Library/Logs/Mesh Bridge`.

Install also writes `.command` launchers for attach and restart under `~/Applications`.

Logs live under `~/Library/Logs/Mesh Bridge`. Reply journals live under `~/Library/Application Support/Mesh Bridge/journal`. With `MESH_BRIDGE_STATE_DIR`, logs use `<root>/Logs` and journals use `<root>/journal`.

USB serial devices commonly appear twice on macOS: `/dev/tty.*` and `/dev/cu.*`. Mesh Bridge opens only `/dev/cu.*`; opening the `tty.*` twin can block waiting for carrier detect.
