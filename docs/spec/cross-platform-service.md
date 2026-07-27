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

On stop, WinSW first runs `scripts/send-shutdown.ps1` (`stopexecutable`), which sends the authenticated `shutdown` command over the local IPC port so the bridge exits through its graceful shutdown path in a few seconds. WinSW cannot deliver Ctrl+C to the Node child on Windows, so without this hook every stop waits out the full `stoptimeout` and ends in a force kill. The script is best effort and always exits 0. WinSW 2.12 does not enforce `stoptimeout` around a `stopexecutable`, so the script itself owns the kill deadline: after the IPC send (whether or not it succeeds) it polls up to 15 seconds for the bridge Node process to exit and then force-kills any process still running `dist\service.js` under this repo root. The `stoptimeout` therefore only bounds the no-`stopexecutable` path.

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

Install writes a launchd LaunchDaemon to the system domain at:

```text
/Library/LaunchDaemons/dev.meshbridge.plist
```

It is a system-domain LaunchDaemon, not a per-user GUI LaunchAgent, so the bridge survives logout and reboot without a login session. All service verbs (`install`, `start`, `stop`, `restart`, `uninstall`) mutate the system domain and therefore require root; `servicectl` fails closed with an explicit "must run as root — re-run with sudo" error when the effective uid is not 0. `status` and `attach` do not need root.

The daemon drops privileges to a dedicated unprivileged account. Provision it once before installing (a role account with no login shell), and its matching group:

```bash
sudo sysadminctl -addUser _meshbridge -fullName "Mesh Bridge" -shell /usr/bin/false -home /var/empty
sudo dseditgroup -o create _meshbridge
```

The plist sets `UserName`/`GroupName` to `_meshbridge` and pins `MESH_BRIDGE_STATE_DIR=/Library/Application Support/Mesh Bridge` so writable state and logs live in a system directory that account owns rather than any user's home. The sudo install creates that directory (and its `Logs`) so the account can write there.

Autostart uses `RunAtLoad` and `KeepAlive`. Verb semantics are distinct:

- `install`: `launchctl bootstrap system /Library/LaunchDaemons/dev.meshbridge.plist`.
- `start`: `bootstrap` the plist when the label is unloaded, otherwise `launchctl kickstart system/dev.meshbridge`.
- `stop`: `launchctl bootout system/dev.meshbridge` — unloads the job only; it deletes no artifacts, so a later `start` re-bootstraps it.
- `restart`: `launchctl kickstart -k system/dev.meshbridge` when loaded, otherwise `bootstrap`.
- `uninstall`: `bootout`, then remove the plist and both `.command` launchers.
- `status`: `launchctl print system/dev.meshbridge`.

Install also writes `.command` launchers for attach and restart under the invoking user's `~/Applications`; `uninstall` removes them.

Logs live under `/Library/Application Support/Mesh Bridge/Logs`. Reply journals live under `/Library/Application Support/Mesh Bridge/journal`. Setting `MESH_BRIDGE_STATE_DIR` overrides the root, with logs at `<root>/Logs` and journals at `<root>/journal`.

USB serial devices commonly appear twice on macOS: `/dev/tty.*` and `/dev/cu.*`. Mesh Bridge opens only `/dev/cu.*`; opening the `tty.*` twin can block waiting for carrier detect.

## Graceful Shutdown

Shutdown runs in three ordered phases regardless of platform:

1. **Ingress stop** — the `stopping` signal fires. The Discord and Meshtastic
   reconnect loops unblock and return without tearing down their live transports,
   leaving Discord and Meshtastic online for the drain that follows.

2. **Drain** — both outbound queues (Discord→Mesh and Mesh→Discord) drain
   concurrently under one shared 15-second wall-clock deadline (`SHUTDOWN_DRAIN_MS`).
   The live transports remain open during this window so accepted work is actually
   delivered. A single `AbortController` fires after 15 seconds; both queues race
   against that shared signal rather than each running an independent timer. If the
   deadline elapses first, remaining queued work is abandoned and shutdown continues.
   After a fatal error the transport signal is already aborted, so workers bail and
   the drain returns immediately without waiting.

3. **Abort and close** — the `abort` signal fires, cancelling any in-flight sends.
   Discord client (`client.destroy()`), Meshtastic session (`session.close()`), and
   IPC server are closed in parallel.

The 15-second drain budget is chosen to fit within WinSW's 20-second `stoptimeout`
with headroom for the transport teardown that follows.

### IPC server shutdown

`IpcServer.close()` destroys every accepted socket — including any still in the
middle of authentication — before waiting for the server to close. This guarantees
`server.close()` is never held open by a pre-auth connection that never completes
the handshake.

Authentication uses an absolute 5-second deadline (`IPC_AUTH_TIMEOUT_MS`) set at
socket accept time, not a resettable inactivity timeout. A client that dribbles
token bytes cannot extend this bound, so a pre-auth socket can never outlast the
shutdown drain budget.
