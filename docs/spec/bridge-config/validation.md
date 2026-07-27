# Bridge Config — Fail-Fast Validation

Load when: implementing or reviewing `parseConfig`, pinning exact error message strings,
or debugging any startup failure involving configuration.
Do not load when: you only need defaults/ranges (→ `tuning-properties.md`) or the legacy
env behavior in isolation (→ `legacy-env-cutover.md`).

Validation is performed by hand inside `parseConfig`. Fail on the **first** violation in
the exact order below. Offending string values are rendered with `JSON.stringify(value)`.

## Ordering

1. Legacy env cutover check
2. Required secrets and token-length checks
3. File existence, JSONC parse, and root-type check
4. Global integer properties (in order: `ipcPort`, `queueLimit`, `ackRetries`,
   `sendIntervalMs`, `configTimeoutMs`, `dedupTtlMs`)
5. Channel array presence and count
6. Per-entry shape, ID format, name byte length (in array order)
7. Duplicate Discord ID check (in array order)
8. Duplicate Meshtastic name check (in array order)

If the Ordering list and the table below ever disagree, **the Ordering list is authoritative**.

## Validation Table

| Rule | Exact error message |
| ---- | ------------------- |
| `DISCORD_CHANNEL_ID` or `MESHTASTIC_CHANNEL_NAME` present in env | `` `Legacy environment variables ${legacy.join(", ")} are no longer supported; move channel pairs into config.jsonc` `` (legacy ordered `DISCORD_CHANNEL_ID` then `MESHTASTIC_CHANNEL_NAME`; include only those not `undefined`) |
| `DISCORD_TOKEN` missing, blank, or placeholder | `Missing required configuration: DISCORD_TOKEN` |
| `IPC_TOKEN` missing, blank, or placeholder | `Missing required configuration: IPC_TOKEN` |
| `DISCORD_TOKEN` shorter than 30 UTF-16 code units | `DISCORD_TOKEN is too short to be a bot token` |
| `IPC_TOKEN` shorter than 32 UTF-16 code units | `IPC_TOKEN must be at least 32 characters` |
| `config.jsonc` absent from repo root | `Missing required configuration file: config.jsonc` |
| First JSONC parser error | `` `Invalid config.jsonc: ${printParseErrorCode(first.error)} at offset ${first.offset}` `` |
| Root is null, array, or non-object | `config.jsonc must contain an object` |
| `ipcPort` invalid or out of range | `config.jsonc ipcPort must be an integer from 1024 to 65535` |
| `queueLimit` invalid or out of range | `config.jsonc queueLimit must be an integer from 1 to 1000` |
| `ackRetries` invalid or out of range | `config.jsonc ackRetries must be an integer from 0 to 5` |
| `sendIntervalMs` invalid or out of range | `config.jsonc sendIntervalMs must be an integer from 250 to 60000` |
| `configTimeoutMs` invalid or out of range | `config.jsonc configTimeoutMs must be an integer from 5000 to 120000` |
| `dedupTtlMs` invalid or out of range | `config.jsonc dedupTtlMs must be an integer from 10000 to 3600000` |
| `channels` absent or non-array | `config.jsonc channels must be an array` |
| `channels` length 0 or > 8 | `` `config.jsonc must define 1 to 8 channel pairs; found ${channels.length}` `` |
| Entry at index `i` not an object | `` `config.jsonc channels[${index}] must be an object` `` |
| `discordChannelId` not a string or not matching `^\d{17,20}$` | `` `config.jsonc channels[${index}].discordChannelId ${JSON.stringify(value)} must match ^\d{17,20}$` `` (rendered message contains a single backslash) |
| `meshtasticChannelName` not a string, empty, or > 11 UTF-8 bytes | `` `config.jsonc channels[${index}].meshtasticChannelName ${JSON.stringify(value)} must be 1 to 11 UTF-8 bytes` `` |
| Duplicate `discordChannelId` | `` `Duplicate discordChannelId ${JSON.stringify(value)} in config.jsonc` `` |
| Duplicate `meshtasticChannelName` | `` `Duplicate meshtasticChannelName ${JSON.stringify(value)} in config.jsonc` `` |

## Notes

- **Placeholder detection:** trimmed value matches `/^(replace|change)[-_ ]?me$/i`
  case-insensitively.
- **`printParseErrorCode`** yields the jsonc-parser symbolic code name
  (e.g. `InvalidSymbol`, `UnexpectedEndOfString`).
- Global integer properties use a default when omitted or `undefined`. Any non-`undefined`
  value that is not a safe integer or is outside the stated range triggers the error.
