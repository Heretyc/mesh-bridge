# Bridge Configuration

Status: normative for configuration loading, channel pairing, and validation.

The bridge uses two configuration sources with strictly separated concerns:

- `.env` — secrets only: `DISCORD_TOKEN` and `IPC_TOKEN`. No other values are
  read from the environment, now or as fallbacks.
- `config.jsonc` — all non-sensitive configuration: IPC port, global tuning
  knobs, and the channel pair list. This file lives at the repo root, is
  gitignored, and must be created by the operator before startup.

## config.jsonc Schema

The file is parsed by the `jsonc-parser` npm package. Comments and trailing
commas are permitted. Unknown properties are ignored. All numeric properties are
optional; each receives the default shown below when absent or `undefined`. The
`channels` property is required and has no default.

```jsonc
{
  // Loopback-only read-only status IPC. Integer, 1024..65535.
  "ipcPort": 47652,

  // Global limits/tuning shared by every channel pair.
  "queueLimit": 100,        // Integer, 1..1000; total queued jobs per direction.
  "ackRetries": 2,          // Integer, 0..5.
  "sendIntervalMs": 1000,   // Integer, 250..60000; one radio-wide send clock.
  "configTimeoutMs": 30000, // Integer, 5000..120000.
  "dedupTtlMs": 300000,     // Integer, 10000..3600000.

  // Required: 1..8 strict one-to-one pairs.
  "channels": [
    {
      "discordChannelId": "123456789012345678",
      "meshtasticChannelName": "private"
    }
  ]
}
```

### TypeScript types

```ts
export interface ChannelPairConfig {
  discordChannelId: string;
  meshtasticChannelName: string;
}

export interface Config {
  discordToken: string;
  ipcToken: string;
  ipcPort: number;
  queueLimit: number;
  ackRetries: number;
  sendIntervalMs: number;
  configTimeoutMs: number;
  dedupTtlMs: number;
  channels: ChannelPairConfig[];
}
```

The parsed `Config` is fully populated. The JSONC root is validated as
`unknown`; validation is performed by hand inside `parseConfig` — do not
introduce a JSON-Schema object, a generated validator, or any additional
exported `Config`-shaped type or schema class beyond the single `Config`
interface. Only consumed properties are validated; unrecognised keys have no
effect.

## Tuning Properties

All tuning properties are **global only**. There are no per-channel overrides.

| Property        | Default   | Range              | Description                          |
| --------------- | --------- | ------------------ | ------------------------------------ |
| `ipcPort`       | `47652`   | 1024–65535         | Loopback IPC listener port           |
| `queueLimit`    | `100`     | 1–1000             | Total queued jobs per direction      |
| `ackRetries`    | `2`       | 0–5                | Mesh send ACK retry count            |
| `sendIntervalMs`| `1000`    | 250–60000          | Radio-wide minimum send interval     |
| `configTimeoutMs`| `30000`  | 5000–120000        | Meshtastic config probe timeout      |
| `dedupTtlMs`    | `300000`  | 10000–3600000      | Dedup cache entry lifetime           |

`queueLimit` is a total per direction, not multiplied by pair count. One send
clock (`sendIntervalMs`) governs the single shared radio transmitter.

## Channel Pairs

`channels` must be a non-empty array of between 1 and 8 entries inclusive. Each
entry must be an object with exactly two fields:

- `discordChannelId` — a Discord snowflake string matching `^\d{17,20}$`.
- `meshtasticChannelName` — a non-empty string of at most **11 UTF-8 bytes**
  (bytes, not characters). The 11-byte ceiling matches the Meshtastic device
  channel-name field limit.

The 8-pair ceiling matches the Meshtastic device channel-slot limit.

### Strict 1:1 pairing

Every `discordChannelId` must be globally unique across all entries. Every
`meshtasticChannelName` must be globally unique across all entries. The bridge
enforces no fan-in and no fan-out: one Discord channel pairs with exactly one
Meshtastic channel and vice versa.

#### Rejected example

The following config is invalid because two entries share the same
`meshtasticChannelName`:

```jsonc
{
  "channels": [
    { "discordChannelId": "111111111111111111", "meshtasticChannelName": "private" },
    { "discordChannelId": "222222222222222222", "meshtasticChannelName": "private" }
  ]
}
```

Rejection message:

```
Duplicate meshtasticChannelName "private" in config.jsonc
```

## Fail-Fast Validation

The implementation must apply validations in the exact order given here and fail
on the first violation. Error messages are exact string templates; offending
string values must be rendered with `JSON.stringify(value)` so empty strings,
whitespace, controls, and Unicode remain identifiable.

### Ordering

1. Legacy env cutover check
2. Required secrets and token-length checks
3. File existence, JSONC parse, and root-type check
4. Global integer properties (in order: `ipcPort`, `queueLimit`, `ackRetries`, `sendIntervalMs`, `configTimeoutMs`, `dedupTtlMs`)
5. Channel array presence and count
6. Per-entry shape, ID format, name byte length (in array order)
7. Duplicate Discord ID check (in array order)
8. Duplicate Meshtastic name check (in array order)

### Validation table

| Rule | Exact error message |
| ---- | ------------------- |
| `DISCORD_CHANNEL_ID` or `MESHTASTIC_CHANNEL_NAME` present in env | `` `Legacy environment variables ${legacy.join(", ")} are no longer supported; move channel pairs into config.jsonc` `` where `legacy` is ordered `DISCORD_CHANNEL_ID` then `MESHTASTIC_CHANNEL_NAME`, including only those whose values are not `undefined` |
| `DISCORD_TOKEN` missing, blank, or placeholder (trimmed value matches `/^(replace|change)[-_ ]?me$/i`, case-insensitively) | `Missing required configuration: DISCORD_TOKEN` |
| `IPC_TOKEN` missing, blank, or placeholder (trimmed value matches `/^(replace|change)[-_ ]?me$/i`, case-insensitively) | `Missing required configuration: IPC_TOKEN` |
| `DISCORD_TOKEN` shorter than 30 UTF-16 code units (`String.prototype.length`) | `DISCORD_TOKEN is too short to be a bot token` |
| `IPC_TOKEN` shorter than 32 UTF-16 code units (`String.prototype.length`) | `IPC_TOKEN must be at least 32 characters` |
| `config.jsonc` absent from repo root | `Missing required configuration file: config.jsonc` |
| First JSONC parser error | `` `Invalid config.jsonc: ${printParseErrorCode(first.error)} at offset ${first.offset}` `` (`printParseErrorCode` yields the jsonc-parser symbolic code name, e.g. `InvalidSymbol`, `UnexpectedEndOfString`) |
| Root is null, array, or non-object | `config.jsonc must contain an object` |
| `channels` absent or non-array | `config.jsonc channels must be an array` |
| `ipcPort` invalid or out of range | `config.jsonc ipcPort must be an integer from 1024 to 65535` |
| `queueLimit` invalid or out of range | `config.jsonc queueLimit must be an integer from 1 to 1000` |
| `ackRetries` invalid or out of range | `config.jsonc ackRetries must be an integer from 0 to 5` |
| `sendIntervalMs` invalid or out of range | `config.jsonc sendIntervalMs must be an integer from 250 to 60000` |
| `configTimeoutMs` invalid or out of range | `config.jsonc configTimeoutMs must be an integer from 5000 to 120000` |
| `dedupTtlMs` invalid or out of range | `config.jsonc dedupTtlMs must be an integer from 10000 to 3600000` |
| `channels` length is 0 or greater than 8 | `` `config.jsonc must define 1 to 8 channel pairs; found ${channels.length}` `` |
| Entry at index `i` is null, array, or non-object | `` `config.jsonc channels[${index}] must be an object` `` |
| `discordChannelId` at index `i` is not a string or does not match `^\d{17,20}$` | `` `config.jsonc channels[${index}].discordChannelId ${JSON.stringify(value)} must match ^\\d{17,20}$` `` (template literal; rendered message contains a single backslash, e.g. `... must match ^\d{17,20}$`) |
| `meshtasticChannelName` at index `i` is not a string, is empty, or exceeds 11 UTF-8 bytes | `` `config.jsonc channels[${index}].meshtasticChannelName ${JSON.stringify(value)} must be 1 to 11 UTF-8 bytes` `` |
| Duplicate `discordChannelId` value | `` `Duplicate discordChannelId ${JSON.stringify(value)} in config.jsonc` `` |
| Duplicate `meshtasticChannelName` value | `` `Duplicate meshtasticChannelName ${JSON.stringify(value)} in config.jsonc` `` |

Global integer properties use a default when omitted or `undefined`. Any
non-`undefined` value that is not a safe integer or is outside the stated range
must trigger the corresponding error.

## Hard Cutover from Legacy Environment Variables

Presence of `DISCORD_CHANNEL_ID` or `MESHTASTIC_CHANNEL_NAME` in the
environment — at any value, including the empty string — is a startup failure.
The implementation must check for these names before reading any value and must
never use them as fallbacks.

The exact error for one or both present is:

```
Legacy environment variables DISCORD_CHANNEL_ID, MESHTASTIC_CHANNEL_NAME are no longer supported; move channel pairs into config.jsonc
```

(Include only the names whose values are not `undefined`; preserve the order
`DISCORD_CHANNEL_ID` then `MESHTASTIC_CHANNEL_NAME`.)

Operators must remove these variables from `.env` and all deployment
environments. Pointing operators to `config.jsonc.example` in the error message
is encouraged but the exact text above is the normative form.

## IPC-Only Load Path

The TUI uses `loadIpcConfig` to obtain a token and port without starting the
full bridge. The spec's prohibition on non-token environment reads applies here:

- `loadIpcConfig` must read `ipcPort` from `config.jsonc` through the same
  `parseConfig` pipeline.
- `loadIpcConfig` must **not** read `IPC_PORT` from the environment; the port
  value must come from `config.jsonc` only.
- The only environment variable `loadIpcConfig` may read is `IPC_TOKEN` (via
  the `.env` load performed by `loadEnvironment`).

## Reply Mapping Journals

One `ChannelJournal` instance is created per configured pair, keyed and filed by
`discordChannelId`. The journal file path follows the format specified in
`docs/spec/mapping-journal.md`:

```
<journalDir>/<discordChannelId>.reply-mapping.jsonl
```

Each pair also owns one `ReplyCorrelator` backed by its journal. Journal and
correlator instances must never be shared across pairs.

On shutdown the implementation must close every pair's journal explicitly.
Journal degradation is tracked per pair; the aggregate `journalDegraded` status
clears only when all pairs' journals have recovered.

## Routing and Isolation Guarantee

A message received on one pair must never be relayed to another pair. The
implementation must enforce this guarantee through two lookup maps:

```ts
pairsByDiscordId:  Map<string, PairState>   // keyed by discordChannelId
pairsByMeshChannel: Map<number, PairState>  // keyed by resolved numeric index
```

**Discord → Mesh:** `message.channelId` or `reaction.message.channelId` is
looked up in `pairsByDiscordId` before any body work or partial fetch. No entry
means ignore. The accepted job stores the `discordChannelId` as a durable route
tag. The worker re-resolves the pair from the tag at delivery time.

**Mesh → Discord:** After radio configuration, each configured
`meshtasticChannelName` resolves to a numeric index and populates
`pairsByMeshChannel`. `packet.channel` is looked up in `pairsByMeshChannel`
before decode or dedup. No entry means ignore.

If a configured `meshtasticChannelName` does not resolve to a device channel
index (name absent from the device channel list or device not yet seen), that
pair stays pending and receives no Mesh → Discord traffic; the TUI and
`status` command display it as `(index pending)`.

If two configured `meshtasticChannelName` values resolve to the same device
channel index, startup fails immediately with:

```
Meshtastic channel name collision: ${JSON.stringify(nameA)} and ${JSON.stringify(nameB)} both resolve to device channel index ${index}
```

where `nameA` and `nameB` are the conflicting names in config array order and
`index` is the shared numeric index.

### Dedup key namespacing

Dedup keys include the pair's `discordChannelId` to prevent collision across
pairs:

| Event | Key |
| ----- | --- |
| Discord message | `discord:${discordChannelId}:${message.id}` |
| Mesh packet (nonzero ID) | `mesh:${discordChannelId}:${packet.from}:${packet.id}` |
| Mesh packet (ID zero) | `mesh:${discordChannelId}:${packet.from}:0:${packet.rxTime}:${sha256PayloadPrefix}` (`sha256PayloadPrefix` is the first 16 lowercase hex characters of the SHA-256 of the decoded packet payload bytes) |

Global state (one queue per direction, one send clock, one Discord client, one
Meshtastic device, one telemetry sink, one IPC server, global counters) is
shared across all pairs. `queueLimit` governs the total per direction, not per
pair.

Job route tagging is mandatory even with global FIFO queues. The worker must
never infer a job's destination from which connection or channel is active when
the job reaches the front of the queue.

## Version Telemetry

`service.version` is read from `package.json` at startup using `readFileSync`
and `JSON.parse`. The version must not be hardcoded or duplicated. No
`package.json` changes are required; the file is already present in the runtime
image.

## TUI and Status

The TUI `Configured pairs` section and the `status` command output must list
every configured pair and each pair's resolved Meshtastic channel index (or
`pending` if not yet resolved). The format per entry is:

```
Discord <discordChannelId> <-> Meshtastic <meshtasticChannelName> (index <number|pending>)
```

The `StatusSnapshot` carries a `connections.channelPairs` array with one entry
per configured pair, updated on connect and cleared to pending on disconnect.

## Operational Notes

- `config.jsonc.example` is committed to the repository and must contain a
  working commented example. Operators copy it to `config.jsonc` and fill in
  real values.
- `config.jsonc` (without `.example`) is gitignored and must never be committed.
- `.env` must contain only `DISCORD_TOKEN` and `IPC_TOKEN`. All other
  configuration has moved to `config.jsonc`. The `.env.example` file must
  document this separation.
- The `jsonc-parser` package is a runtime dependency. No JSON Schema package or
  generated validator is used; validation is performed manually inside
  `parseConfig`.
- There is no configurable config file path. The bridge always resolves
  `config.jsonc` relative to the process working directory, which is the repo
  root in all supported deployment paths.
