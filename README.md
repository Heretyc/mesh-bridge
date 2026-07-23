# Mesh Bridge

Windows-only, headless Discord ↔ Meshtastic USB serial bridge. The Discord bot must be named exactly **Mesh Bridge**. A separate read-only terminal UI attaches over authenticated loopback IPC; there is no GUI, HTTP server, database, MQTT, BLE, or telemetry.

## Requirements

- Windows 10/11 x64 and PowerShell 5.1+
- Node.js 22 or newer
- Exactly one Meshtastic USB serial device connected; unrelated USB serial devices may remain connected
- One enabled, encrypted Meshtastic channel with a unique name of at most 11 UTF-8 bytes
- Administrator access only for Windows service installation and control

The bridge uses the latest published official Node serial pairing: `@meshtastic/transport-node-serial@0.0.2` with `@meshtastic/core@2.6.7`. These are also the versions in Meshtastic Web release `v2.7.1`. The active Meshtastic main branch contains an unreleased replacement SDK; this project does not depend on unreleased source.

## Discord setup

1. In the Discord Developer Portal, create an application and bot named literally `Mesh Bridge`.
2. On **Bot → Privileged Gateway Intents**, enable **Message Content Intent**. No Presence or Server Members intent is used.
3. Install the app to the server with the `bot` scope and only these channel permissions:
   - View Channel
   - Send Messages
4. Apply those permissions only to the bridge channel, then copy that channel ID into `.env`.

The bot validates its username, channel visibility, and these two permissions at startup. It does not need Manage Messages, Read Message History, Mention Everyone, attachments, embeds, commands, or administrator access. Discord posts use `allowedMentions.parse = []`.

## Meshtastic setup

Configure the desired channel on the radio first. Put its exact, case-sensitive name in `MESHTASTIC_CHANNEL_NAME`; the PSK remains on the radio and is never stored by this service. Startup fails closed if the name is missing, duplicated, disabled, unencrypted, or outside channel indexes 0–7. The local node number and node long names are learned during device configuration.

USB discovery considers Windows serial ports backed by USB metadata, probes them sequentially with the official Meshtastic configuration handshake, and activates forwarding only after exactly one radio responds. Locked and non-Meshtastic ports are rejected; zero or multiple responsive radios fail closed and retry with exponential backoff.

## Install and configure

```powershell
npm ci
Copy-Item .env.example .env
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
notepad .env
npm run typecheck
npm run build
npm test
```

Set the generated value as `IPC_TOKEN`, then set `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID`, and `MESHTASTIC_CHANNEL_NAME`. Optional values in `.env.example` bound queues, retries, pacing, configuration timeout, deduplication lifetime, and the loopback IPC port.

The service warns if `.env` inherits readable permissions for broad Windows groups. To restrict it to the current user, SYSTEM, and the service account, run this from elevated PowerShell in the project directory:

```powershell
icacls.exe .env /inheritance:r /grant:r "${env:USERNAME}:(F)" "*S-1-5-18:(R)" "*S-1-5-19:(R)"
```

## Windows service

The installer downloads the pinned WinSW 2.12.0 x64 binary from the official release and verifies SHA-256 `05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA`. It installs `Mesh Bridge` as `LocalService`, Automatic (delayed start), with restart-on-failure. It survives logoff and reboot.

Run service operations from elevated PowerShell:

```powershell
npm run service:install
npm run service:start
npm run service:status
npm run service:stop
npm run service:uninstall
```

Uninstall removes the Windows service registration but deliberately retains `.env`, logs, and the downloaded wrapper.

## Read-only TUI

From a normal terminal in the project directory:

```powershell
npm run tui
```

The TUI shows link states, serial port, local node ID, resolved channel index, queue depths, counters, and the last 25 sanitized events. It binds only to the service's raw TCP listener on `127.0.0.1`, authenticates with `IPC_TOKEN`, and has no command protocol. Any post-auth client input closes the connection. This is local IPC, not an HTTP/web server.

## Routing behavior

Discord → Mesh accepts only ordinary user messages (including replies, but not referenced reply content) in `DISCORD_CHANNEL_ID`. Bots, webhooks, system messages, duplicate Discord IDs, embeds, stickers, and empty messages are ignored. Plain message text and URLs are unchanged; attachment URLs and bodies are ignored, while each safe filename and extension is appended.

A message that fits one mesh packet is formatted as `Display name: text`. Split messages use `Display name: (i/n) text` on every chunk. Chunks are split on whitespace where possible and otherwise at Unicode grapheme boundaries. Attribution and numbering count against the official 233-byte Meshtastic data-payload limit. Sends are paced, request ACKs, and use bounded retries. Queue rejection and partial/final delivery failures are reported to Discord and the TUI without repeating message content.

Mesh → Discord accepts only decoded `TEXT_MESSAGE_APP` packets on the resolved channel. Broadcasts and direct messages are both forwarded; local-node echoes and bounded-TTL duplicates are suppressed. Output is `**[Mesh long name]:** text`, with Discord Markdown escaped inside the name and `Unknown !nodeid` used only when the radio has not supplied a long name. Mentions are disabled.

## Reliability and logs

- Discord.js handles gateway reconnects; initial/invalidated sessions are supervised with backoff.
- USB serial discovery/configuration reconnects with backoff. A channel resolution error is fatal instead of falling back to another channel.
- Both directions use bounded in-memory queues. Full queues increment rejection/failure counters and emit visible events; nothing is silently discarded.
- Shutdown stops intake, drains queues for up to 15 seconds, disconnects both links, and closes IPC.
- `logs\mesh-bridge.jsonl` is structured JSONL, rotates at 1 MiB with five copies, and redacts token/secret/content/message/text/payload/PSK/key fields. WinSW wrapper output is also under `logs\`.

No message contents or secrets are written to the structured log. Message text exists only in bounded in-memory queues while being delivered.

## Recovery

- **Missing configuration:** run `node dist\service.js` interactively; the fatal error names the missing/invalid variable.
- **Zero or multiple Meshtastic radios:** connect exactly one configured radio and watch `npm run tui`; unrelated or locked USB serial ports are reported as rejected and retry is automatic.
- **Channel failure:** correct the exact encrypted channel name on the radio and in `.env`, then restart the service.
- **Discord failure:** confirm the bot is named `Mesh Bridge`, Message Content Intent is enabled, the channel ID is correct, and only View Channel + Send Messages are granted.
- **Service will not start:** inspect `logs\MeshBridge.wrapper.log` and `logs\mesh-bridge.jsonl`, then run `node dist\service.js` interactively after stopping the service.
- **TUI cannot attach:** verify `IPC_TOKEN` and `IPC_PORT` match the service `.env`; only one service instance can own the port.

## Known limitations

- Discovery probes accessible USB serial ports sequentially, so an unrelated responsive port can delay startup by up to `CONFIG_TIMEOUT_MS`. It never picks the first port and still fails closed if zero or multiple Meshtastic radios answer.
- The official Meshtastic packages publish incomplete declaration aliases. Application code remains strict TypeScript, while `skipLibCheck` is enabled only for dependency declaration files.
- The official core ACK timeout is 60 seconds. With the default two retries, a final radio failure can take about three minutes.
- State, deduplication, names, and pending work are memory-only and reset on service restart.
- A node that has not advertised its long name uses `Unknown !nodeid` until NodeInfo arrives.

## Primary references

- [Meshtastic Web v2.7.1 Node serial transport](https://github.com/meshtastic/web/tree/v2.7.1/packages/transport-node-serial)
- [Meshtastic Web v2.7.1 core](https://github.com/meshtastic/web/tree/v2.7.1/packages/core)
- [Meshtastic firmware payload constant](https://github.com/meshtastic/firmware/blob/master/src/mesh/generated/meshtastic/mesh.pb.h)
- [Discord Gateway intents and Message Content](https://docs.discord.com/developers/events/gateway#gateway-intents)
- [Discord OAuth2 scopes and permissions](https://docs.discord.com/developers/platform/oauth2-and-permissions)
- [Discord.js 14.27.0 Client](https://discord.js.org/docs/packages/discord.js/14.27.0/Client:Class)
- [Discord.js 14.27.0 Message](https://discord.js.org/docs/packages/discord.js/14.27.0/Message:Class)
- [Discord.js message send options / allowed mentions](https://discord.js.org/docs/packages/discord.js/14.27.0/MessageCreateOptions:Interface)
- [WinSW official usage and license](https://github.com/winsw/winsw)
- [WinSW XML service configuration](https://github.com/winsw/winsw/blob/v2.12.0/doc/xmlConfigFile.md)
