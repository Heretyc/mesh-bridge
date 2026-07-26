# Mesh Bridge

Headless Discord ↔ Meshtastic USB serial bridge for Windows, Linux, macOS, and Docker. The Discord bot must be named exactly **Mesh Bridge**. A separate read-only terminal UI attaches over authenticated loopback IPC; there is no GUI, HTTP server, database, MQTT, BLE, or telemetry.

## Requirements

- Windows 10/11 x64 with PowerShell 5.1+, Linux with systemd user services, macOS with launchd LaunchAgents, or Docker on Linux
- Node.js 22 or newer
- Exactly one Meshtastic USB serial device connected; unrelated USB serial devices may remain connected
- Between one and eight enabled, encrypted Meshtastic channels, each with a unique name of at most 11 UTF-8 bytes
- Administrator access only for Windows service installation and control; Linux/macOS install as user services

The bridge uses the latest published official Node serial pairing: `@meshtastic/transport-node-serial@0.0.2` with `@meshtastic/core@2.6.7`. These are also the versions in Meshtastic Web release `v2.7.1`. The active Meshtastic main branch contains an unreleased replacement SDK; this project does not depend on unreleased source.

## Discord setup

1. In the Discord Developer Portal, create an application and bot named literally `Mesh Bridge`.
2. On **Bot → Privileged Gateway Intents**, enable **Message Content Intent**. The bridge also uses the non-privileged Guild Message Reactions intent; no Presence or Server Members intent is used.
3. Install the app to the server with the `bot` scope and only these channel permissions:
   - View Channel
   - Send Messages
   - Read Message History
   - Add Reactions
4. Apply those permissions to each bridge channel; record each channel ID for entry in `config.jsonc`.

The bot validates its username, channel visibility, and these four permissions at startup. Read Message History is required so native replies and mesh tapbacks can find earlier messages; Add Reactions is required for native mesh tapbacks. It does not need Manage Messages, Mention Everyone, attachments, embeds, commands, or administrator access. Discord posts use `allowedMentions.parse = []`.

## Meshtastic setup

Configure each desired channel on the radio first. Put its exact, case-sensitive name in `config.jsonc` under the appropriate channel pair; the PSK remains on the radio and is never stored by this service. Startup fails closed if any configured name is missing, duplicated, disabled, unencrypted, or outside channel indexes 0–7. The local node number and node long names are learned during device configuration.

USB discovery is platform-aware: Windows probes USB-backed COM ports, Linux probes `/dev/ttyUSB*` and `/dev/ttyACM*`, and macOS opens only `/dev/cu.*` devices. Candidates are probed sequentially with the official Meshtastic configuration handshake, and forwarding activates only after exactly one radio responds. Locked and non-Meshtastic ports are rejected; zero or multiple responsive radios fail closed and retry with exponential backoff.

## Install and configure

```powershell
npm ci
Copy-Item .env.example .env
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
notepad .env
Copy-Item config.jsonc.example config.jsonc
notepad config.jsonc
npm run typecheck
npm run build
npm test
```

In `.env`, set `IPC_TOKEN` to the generated value and set `DISCORD_TOKEN` to the bot token. In `config.jsonc`, populate the `channels` array with one entry per Discord–Meshtastic pair: each entry takes a `discordChannelId` (Discord snowflake) and a `meshtasticChannelName` (exact channel name as configured on the radio). Between 1 and 8 pairs are supported. Tuning values (`ipcPort`, `queueLimit`, `ackRetries`, `sendIntervalMs`, `configTimeoutMs`, `dedupTtlMs`) are optional; defaults and accepted ranges are documented in `config.jsonc.example`.

The bridge resolves `config.jsonc` from the process working directory. The service installer sets the working directory to the project root on all supported platforms (systemd, launchd, and WinSW), so the installed service finds `config.jsonc` automatically. Docker requires an explicit bind mount; see the Docker section.

If `DISCORD_CHANNEL_ID` or `MESHTASTIC_CHANNEL_NAME` remain in `.env` from an earlier install, the bridge fails at startup and names the offending variables. Remove them from `.env` and move the channel pair to `config.jsonc`.

The service warns if `.env` inherits readable permissions for broad Windows groups. To restrict it to the current user, SYSTEM, and the service account, run this from elevated PowerShell in the project directory:

```powershell
icacls.exe .env /inheritance:r /grant:r "${env:USERNAME}:(F)" "*S-1-5-18:(R)" "*S-1-5-19:(R)"
```

## Service operation

The service verbs are the same on Windows, Linux, and macOS:

```bash
npm run service:install
npm run service:start
npm run service:status
npm run service:stop
npm run service:uninstall
npm run service:attach
npm run service:restart
```

Windows shells the existing audited PowerShell scripts. The installer downloads the pinned WinSW 2.12.0 x64 binary from the official release and verifies SHA-256 `05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA`. It installs `Mesh Bridge` as `LocalService`, Automatic (delayed start), with restart-on-failure. It survives logoff and reboot. Because the service runs as `LocalService`, the installer also provisions the `%ProgramData%\Mesh Bridge` state root and its `Logs` and `journal` subfolders, breaks inherited permissions on that root, and restricts access to SYSTEM, Administrators, and LocalService because telemetry and reply journals contain full message bodies.

Linux installs a systemd user unit at `~/.config/systemd/user/mesh-bridge.service`, enables it with `systemctl --user enable --now mesh-bridge.service`, and enables linger with `loginctl enable-linger "$USER"` so it survives logout and reboot. Install also creates attach and restart `.desktop` launchers under `~/.local/share/applications`.

macOS installs a launchd LaunchAgent at `~/Library/LaunchAgents/dev.meshbridge.plist` with `RunAtLoad` and `KeepAlive`. Install also creates attach and restart `.command` launchers under `~/Applications`.

Uninstall removes the OS service registration but deliberately retains `.env`, logs, and local state. More detail is in `docs/spec/cross-platform-service.md`.

## Read-only TUI

From a normal terminal in the project directory:

```bash
npm run tui
```

The TUI shows link states, serial port, local node ID, resolved channel index, queue depths, counters, and the last 25 sanitized events. It binds only to the service's raw TCP listener on `127.0.0.1`, authenticates with `IPC_TOKEN`, and has no command protocol. Any post-auth client input closes the connection. This is local IPC, not an HTTP/web server.

## Routing behavior

Discord → Mesh accepts only ordinary user messages (including replies, but not referenced reply content) in the configured Discord channels. Messages in unconfigured channels are ignored. Bots, webhooks, system messages, duplicate Discord IDs, embeds, stickers, and empty messages are ignored. Exactly three forms are rewritten in the message text: `<@id>` and `<@!id>` become `@` plus that guild member's display name, falling back to the mentioned user's display name, and `<@&id>` becomes `@` plus the role name. Every other byte is passed through, including plain text, URLs, mentions whose id the message does not resolve, `@everyone`/`@here`, channel mentions, slash-command mentions, custom emoji, and timestamps. Substitution is positional, so a mention written inside a URL is rewritten there too. Attachment URLs and bodies are ignored, while each safe filename and extension is appended.

Native replies are translated in both directions. A Discord reply is relayed with the Meshtastic `reply_id` of the referenced message's first mesh chunk, set only on chunk 1; continuation chunks carry no reply id. A mesh reply is posted as a real Discord reply with `failIfNotExists: false` and the same disabled mentions. The first mesh chunk of a Discord message is the canonical reply root, while every chunk maps back to that Discord message, so a mesh reply to any chunk threads onto the original. When the referenced message is unknown, expired, or deleted, the message is relayed unthreaded and `REPLY_TARGET_UNAVAILABLE` is emitted with only the direction and referenced id.

Reaction additions are translated in both directions. A non-bot Discord reaction in the configured channel sends one retried, ACK-requested text packet: `<Display name> reacted with <emoji>` as a native reply when the target has a mesh mapping, otherwise `<Display name> reacted <emoji> to "<excerpt>"` unthreaded. Unicode emoji remain glyphs and custom emoji become `:name:`; excerpts are capped at 40 grapheme clusters and shortened further, with `...`, to fit one mesh packet. A mesh `TEXT_MESSAGE_APP` packet with nonzero `emoji` and `reply_id` still becomes a native Discord reaction and is never posted as message text. Reaction packet ids alias to the same Discord target without replacing its canonical mesh root.

A message that fits one mesh packet is formatted as `[Display name]: text`. Split messages use `[Display name]: (i/n) text` on every chunk. Chunks are split on whitespace where possible and otherwise at Unicode grapheme boundaries. Resolved mention text, brackets, attribution, and numbering all count against the 232-byte UTF-8 text ceiling: current firmware permits a 239-byte encoded `Data` envelope after the 16-byte radio header, and the text port plus required bitfield consume seven encoded bytes. Sends are paced, request ACKs, and use bounded retries. Queue rejection and partial/final delivery failures are reported to Discord and the TUI without repeating message content.

Mesh → Discord accepts only decoded `TEXT_MESSAGE_APP` packets on configured Meshtastic channels; each packet routes to its paired Discord channel. Broadcasts and direct messages are both forwarded; local-node echoes and bounded-TTL duplicates are suppressed. Output is `**[Mesh long name]:** text`, with Discord Markdown escaped inside the name and `Unknown !nodeid` used only when the radio has not supplied a long name. Mentions are disabled.

## Reliability and logs

- Discord.js handles gateway reconnects; initial/invalidated sessions are supervised with backoff.
- USB serial discovery/configuration reconnects with backoff. A channel resolution error is fatal instead of falling back to another channel.
- Both directions use bounded in-memory queues. Full queues increment rejection/failure counters and emit visible events; nothing is silently discarded.
- Shutdown stops intake, drains queues for up to 15 seconds, disconnects both links, and closes IPC.
- Local telemetry is one OTel-shaped JSONL file named `telemetry.jsonl`: `%ProgramData%\Mesh Bridge\Logs` on Windows, `${XDG_STATE_HOME:-$HOME/.local/state}/mesh-bridge/logs` on Linux, and `$HOME/Library/Logs/Mesh Bridge` on macOS. `MESH_BRIDGE_STATE_DIR` overrides the root for tests and portable installs.
- The telemetry file is local-only: there is no exporter, collector, HTTP endpoint, or new dependency. Full Discord and Mesh message bodies are written to disk, with exact `DISCORD_TOKEN` and `IPC_TOKEN` value redaction before write. The TUI and IPC snapshot stay sanitized and do not show message bodies.
- There is exactly one active telemetry file. Startup and the daily local 02:00 prune atomically rewrite it to keep records from the last 24 hours, skip malformed lines, and allow near-48-hour physical retention. A telemetry filesystem failure never stops relay traffic; the TUI and stderr report the degraded state once and report recovery once.
- Reply correlation is persisted in one local JSONL journal per configured Discord channel ID under the state journal directory. It is capped at 10,000 live entries per direction with a rolling 30-day lifetime, replays at startup, tolerates malformed lines, and compacts atomically at startup and daily local 02:00. A journal filesystem failure never stops relay traffic; in-memory reply correlation continues and the TUI/stderr report the degraded state once.

WinSW wrapper output remains under the Windows service wrapper log path.

## Docker

The Docker image targets Node 22 LTS on `node:22-bookworm-slim`. Production Compose uses `restart: unless-stopped`, reads `.env`, bind-mounts `./config.jsonc` read-only at `/app/config.jsonc`, mounts a named state volume at `/var/lib/mesh-bridge`, maps `/dev/ttyUSB0`, adds the `dialout` group, and publishes no ports.

```bash
docker build -t mesh-bridge .
docker compose up -d
```

For disposable container testing without `.env` or serial devices:

```bash
docker compose -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from mesh-bridge-test
docker compose -f docker-compose.test.yml down --volumes
```

The primary target is `linux/amd64`; build arm64 on arm64 hardware so native serial bits compile for the right ABI. More detail is in `docs/spec/docker.md`.

## Recovery

- **Missing configuration:** run `node dist\service.js` interactively; the startup error names the missing secret, invalid setting, or absent `config.jsonc`.
- **Zero or multiple Meshtastic radios:** connect exactly one configured radio and watch `npm run tui`; unrelated or locked USB serial ports are reported as rejected and retry is automatic.
- **Channel failure:** correct the exact encrypted channel name on the radio and in `config.jsonc`, then restart the service.
- **Discord failure:** confirm the bot is named `Mesh Bridge`, Message Content Intent is enabled, the channel IDs in `config.jsonc` are correct, and only View Channel + Send Messages + Read Message History + Add Reactions are granted.
- **Replies arrive unthreaded:** expected when the referenced message predates the 30-day reply journal window, was evicted from the 10,000-entry direction cap, or when the Discord target was deleted. The bridge relays the text unthreaded and records `REPLY_TARGET_UNAVAILABLE` with only the direction and referenced id; no action is needed.
- **Reaction reports 0/1:** the single ACK-requested reaction text exhausted its retry budget or could not fit safely. Check the sanitized TUI event and link state; an unavailable target mapping falls back to an unthreaded excerpt.
- **Service will not start:** inspect the WinSW wrapper log and local `telemetry.jsonl`, then run `node dist\service.js` interactively after stopping the service.
- **TUI cannot attach:** verify `IPC_TOKEN` in `.env` and `ipcPort` in `config.jsonc` match the running service; only one service instance can own the port.

## Known limitations

- Discovery probes accessible USB serial ports sequentially, so an unrelated responsive port can delay startup by up to `configTimeoutMs` (default 30 seconds). It never picks the first port and still fails closed if zero or multiple Meshtastic radios answer.
- The official Meshtastic packages publish incomplete declaration aliases. Application code remains strict TypeScript, while `skipLibCheck` is enabled only for dependency declaration files.
- The official core ACK timeout is 60 seconds. With the default two retries, a final radio failure can take about three minutes.
- Deduplication, node names, queues, and pending work are memory-only and reset on service restart.
- Reply correlation survives restart through the per-channel journal. It is bounded by 10,000 entries per direction and a rolling 30-day window; older correlations are logically expired immediately and their replies relay unthreaded.
- Discord reaction removals are intentionally ignored because the official Meshtastic core/protobuf API exposes no tapback-removal operation.
- A node that has not advertised its long name uses `Unknown !nodeid` until NodeInfo arrives.

## Primary references

- [Meshtastic Web v2.7.1 Node serial transport](https://github.com/meshtastic/web/tree/v2.7.1/packages/transport-node-serial)
- [Meshtastic Web v2.7.1 core](https://github.com/meshtastic/web/tree/v2.7.1/packages/core)
- [Meshtastic firmware encoded-payload size check](https://github.com/meshtastic/firmware/blob/master/src/mesh/Router.cpp#L593-L631)
- [Meshtastic firmware radio payload and header constants](https://github.com/meshtastic/firmware/blob/master/src/mesh/RadioInterface.h#L20-L22)
- [Discord Gateway intents and Message Content](https://docs.discord.com/developers/events/gateway#gateway-intents)
- [Discord OAuth2 scopes and permissions](https://docs.discord.com/developers/platform/oauth2-and-permissions)
- [Discord.js 14.27.0 Client](https://discord.js.org/docs/packages/discord.js/14.27.0/Client:Class)
- [Discord.js 14.27.0 Message](https://discord.js.org/docs/packages/discord.js/14.27.0/Message:Class)
- [Discord.js message send options / allowed mentions](https://discord.js.org/docs/packages/discord.js/14.27.0/MessageCreateOptions:Interface)
- [WinSW official usage and license](https://github.com/winsw/winsw)
- [WinSW XML service configuration](https://github.com/winsw/winsw/blob/v2.12.0/doc/xmlConfigFile.md)
