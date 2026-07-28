# Bridge Config — RAG Retrieval Map

Status: normative hub. Read this file first; follow the indexes below to load the correct
leaf. All normative content lives in the leaves under `docs/spec/bridge-config/`.

> **Config split in one line:** `.env` holds secrets only (`DISCORD_TOKEN`, `IPC_TOKEN`).
> `config.jsonc` holds everything else.

## Leaf Directory

| Leaf | Scope |
| ---- | ----- |
| [`bridge-config/config-schema.md`](bridge-config/config-schema.md) | config.jsonc structure, TypeScript interfaces, jsonc-parser rules |
| [`bridge-config/tuning-properties.md`](bridge-config/tuning-properties.md) | Defaults, ranges, semantics of the six global tuning knobs |
| [`bridge-config/channel-pairs.md`](bridge-config/channel-pairs.md) | channels array rules, 1:1 pairing, byte limits, rejected example |
| [`bridge-config/validation.md`](bridge-config/validation.md) | Fail-fast ordering, exact error message strings |
| [`bridge-config/legacy-env-cutover.md`](bridge-config/legacy-env-cutover.md) | DISCORD_CHANNEL_ID / MESHTASTIC_CHANNEL_NAME hard cutover |
| [`bridge-config/ipc-load-path.md`](bridge-config/ipc-load-path.md) | loadIpcConfig — TUI token+port without full bridge startup |
| [`bridge-config/routing-isolation.md`](bridge-config/routing-isolation.md) | Routing maps, isolation guarantee, graceful degradation, alerting, dedup namespacing |
| [`bridge-config/operational.md`](bridge-config/operational.md) | Reply journals, TUI/status format, version telemetry, operator notes |

---

## Direct Topic Index

| Topic | Leaf |
| ----- | ---- |
| config.jsonc annotated example | `config-schema.md` |
| TypeScript Config / ChannelPairConfig interfaces | `config-schema.md` |
| jsonc-parser, comments, unknown keys | `config-schema.md` |
| ipcPort, queueLimit, ackRetries defaults | `tuning-properties.md` |
| sendIntervalMs, configTimeoutMs, dedupTtlMs defaults | `tuning-properties.md` |
| channels array, snowflake format, 11-byte name limit | `channel-pairs.md` |
| 1:1 pairing, no fan-in / no fan-out | `channel-pairs.md` |
| Duplicate channel error example | `channel-pairs.md` |
| parseConfig validation order (steps 1–8) | `validation.md` |
| Exact error messages for every rule | `validation.md` |
| DISCORD_TOKEN / IPC_TOKEN placeholder check | `validation.md` |
| Legacy env hard cutover | `legacy-env-cutover.md` |
| DISCORD_CHANNEL_ID / MESHTASTIC_CHANNEL_NAME removal | `legacy-env-cutover.md` |
| loadIpcConfig | `ipc-load-path.md` |
| TUI token+port without full validation | `ipc-load-path.md` |
| pairsByDiscordId / pairsByMeshChannel maps | `routing-isolation.md` |
| Graceful degradation / loud alerting | `routing-isolation.md` |
| MESH_CHANNEL_UNRESOLVED / DISCORD_CHANNEL_UNRESOLVED | `routing-isolation.md` |
| Channel name collision startup failure | `routing-isolation.md` |
| Dedup key format | `routing-isolation.md` |
| ChannelJournal, ReplyCorrelator per pair | `operational.md` |
| journalDegraded aggregate status | `operational.md` |
| StatusSnapshot.connections.channelPairs | `operational.md` |
| service.version from package.json | `operational.md` |
| config.jsonc.example, gitignore | `operational.md` |

---

## Alias / Synonym Index

| Alias | Canonical term | Leaf |
| ----- | -------------- | ---- |
| .env secrets split | Two-source config separation | `config-schema.md` |
| JSONC, jsonc | jsonc-parser | `config-schema.md` |
| Bot token length | DISCORD_TOKEN min 30 chars | `validation.md` |
| IPC token length | IPC_TOKEN min 32 chars | `validation.md` |
| Snowflake | discordChannelId regex `^\d{17,20}$` | `channel-pairs.md` |
| Channel name | meshtasticChannelName ≤ 11 UTF-8 bytes | `channel-pairs.md` |
| Send interval | sendIntervalMs | `tuning-properties.md` |
| Dedup TTL | dedupTtlMs | `tuning-properties.md` |
| ACK retries | ackRetries | `tuning-properties.md` |
| Config timeout | configTimeoutMs | `tuning-properties.md` |
| Old env vars | Legacy environment variable cutover | `legacy-env-cutover.md` |
| TUI config load | loadIpcConfig / IPC-only load path | `ipc-load-path.md` |
| Pending channel | Unresolved meshtasticChannelName | `routing-isolation.md` |
| Degradation policy | Graceful degradation and loud alerting | `routing-isolation.md` |
| P3-001, P4-001 | MESH_CHANNEL_UNRESOLVED alert | `routing-isolation.md` |
| P3-002 | DISCORD_CHANNEL_UNRESOLVED alert | `routing-isolation.md` |
| Reply journal | ChannelJournal per pair | `operational.md` |

---

## Trigger-Phrase Index

| If you see / hear… | Load |
| ------------------- | ---- |
| "config.jsonc schema" / "config structure" | `config-schema.md` |
| "change a default" / "adjust timeout" / "queue size" | `tuning-properties.md` |
| "add a channel pair" / "pairing rule" | `channel-pairs.md` |
| "validation fails" / "error message" / "parseConfig" | `validation.md` |
| "legacy env" / "DISCORD_CHANNEL_ID in env" | `legacy-env-cutover.md` |
| "TUI won't start" / "IPC token" / "loadIpcConfig" | `ipc-load-path.md` |
| "message goes to wrong channel" / "routing" / "isolation" | `routing-isolation.md` |
| "channel pending" / "MESH_CHANNEL_UNRESOLVED" | `routing-isolation.md` |
| "degradation" / "alerting cadence" / "Discord channel missing" | `routing-isolation.md` |
| "reply journal" / "ReplyCorrelator" / "StatusSnapshot" | `operational.md` |
| "version telemetry" / "package.json version" | `operational.md` |

---

## Task-to-Document Map

| Task | Load |
| ---- | ---- |
| Implement / audit `parseConfig` | `validation.md` + `config-schema.md` |
| Implement `loadIpcConfig` | `ipc-load-path.md` + `validation.md` |
| Change a default value or range | `tuning-properties.md` + `validation.md` |
| Add or remove a channel pair | `channel-pairs.md` + `config-schema.md` |
| Debug startup failure | `validation.md` + `legacy-env-cutover.md` |
| Change graceful-degradation or alerting | `routing-isolation.md` |
| Change reply journal or correlator | `operational.md` |
| Change TUI status display | `operational.md` |
| Operator deployment setup | `operational.md` + `config-schema.md` |

---

## Symptom / Error-to-Document Map

| Symptom or error | Load |
| ---------------- | ---- |
| `Missing required configuration: DISCORD_TOKEN` | `validation.md` |
| `Missing required configuration: IPC_TOKEN` | `validation.md` |
| `DISCORD_TOKEN is too short to be a bot token` | `validation.md` |
| `IPC_TOKEN must be at least 32 characters` | `validation.md` |
| `Missing required configuration file: config.jsonc` | `validation.md` |
| `Invalid config.jsonc: … at offset …` | `validation.md` |
| `config.jsonc must contain an object` | `validation.md` |
| `config.jsonc <property> must be an integer from …` | `validation.md` |
| `config.jsonc channels must be an array` | `validation.md` |
| `config.jsonc must define 1 to 8 channel pairs` | `validation.md` + `channel-pairs.md` |
| `Duplicate discordChannelId` / `Duplicate meshtasticChannelName` | `validation.md` + `channel-pairs.md` |
| `Legacy environment variables … are no longer supported` | `legacy-env-cutover.md` |
| `Meshtastic channel name collision: … both resolve to device channel index …` | `routing-isolation.md` |
| Channel stuck as `(index pending)` | `routing-isolation.md` |
| `MESH_CHANNEL_UNRESOLVED` / `DISCORD_CHANNEL_UNRESOLVED` event | `routing-isolation.md` |

---

## Failure-Mode Map

| Failure mode | Fatal? | Leaf |
| ------------ | ------ | ---- |
| Invalid / missing `DISCORD_TOKEN` | Yes | `validation.md` |
| Invalid / missing `IPC_TOKEN` | Yes | `validation.md` |
| `config.jsonc` absent or unparseable | Yes | `validation.md` |
| Malformed channel entry (shape, ID, name bytes) | Yes | `validation.md` |
| Duplicate channel IDs or names | Yes | `validation.md` |
| Legacy env vars present | Yes | `legacy-env-cutover.md` |
| Two channel names resolve to same device index | Yes | `routing-isolation.md` |
| Meshtastic channel name unresolved (no device index yet) | No — degrades loudly | `routing-isolation.md` |
| Discord channel unresolvable (permissions / wrong ID) | No — degrades loudly | `routing-isolation.md` |
| Journal file error | No — tracked per pair | `operational.md` |

---

## "Load This When…" Rule for Every Leaf

- **`config-schema.md`** — touching config.jsonc structure, TypeScript types, or
  jsonc-parser behavior.
- **`tuning-properties.md`** — changing or verifying any default value, valid range, or
  semantic of the six global knobs.
- **`channel-pairs.md`** — changing channel pairing rules, snowflake format, or name byte
  limit.
- **`validation.md`** — implementing, auditing, or debugging any `parseConfig` validation
  step or exact error message.
- **`legacy-env-cutover.md`** — `DISCORD_CHANNEL_ID` or `MESHTASTIC_CHANNEL_NAME` appears
  in any startup or env context.
- **`ipc-load-path.md`** — working on `loadIpcConfig` or the TUI-only startup path.
- **`routing-isolation.md`** — message routing, pair isolation, graceful degradation,
  alerting cadence, or dedup key format.
- **`operational.md`** — reply journals, TUI status display, version telemetry, or operator
  deployment notes.

---

## When to Stop and Ask for More Context

Pause and confirm with the operator before proceeding if:

- A change would alter a normative error message string (exact text is contractual).
- A change would make the fatal-failure list longer (new hard-abort conditions require
  explicit owner approval).
- A proposed change conflicts with the durability-first policy (graceful degradation takes
  precedence over fail-close except for the explicitly fatal cases in the failure-mode map
  above).
- The channels array size limit (8) or name byte limit (11) is being changed (both match
  hardware limits).
