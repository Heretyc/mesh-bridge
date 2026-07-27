# Bridge Config — IPC-Only Load Path

Load when: implementing or reviewing `loadIpcConfig`, understanding what the TUI loads
without starting the full bridge, or debugging IPC token/port errors outside the full
validation path.
Do not load when: you need full bridge validation (→ `validation.md`) or legacy env
cutover details (→ `legacy-env-cutover.md`).

## Purpose

The TUI uses `loadIpcConfig` to obtain `IPC_TOKEN` and `ipcPort` without starting the
full bridge.

## What `loadIpcConfig` Does

| Step | Detail |
| ---- | ------ |
| Reads `IPC_TOKEN` from `.env` | Via `loadEnvironment`; same presence, placeholder (`/^(replace\|change)[-_ ]?me$/i`), and length (≥ 32 UTF-16 code units) rules as the full path |
| Reads `ipcPort` from `config.jsonc` | Same JSONC parse and range rule (integer 1024–65535) as the full path; identical error messages for missing file, parse error, or out-of-range value |
| Legacy env check | `DISCORD_CHANNEL_ID` / `MESHTASTIC_CHANNEL_NAME` present → startup failure (same as full path) |

## What `loadIpcConfig` Must NOT Do

- Must **not** read `DISCORD_TOKEN`.
- Must **not** require a valid `channels` array — a malformed, empty, or absent `channels`
  array must not prevent `loadIpcConfig` from returning `ipcToken` and `ipcPort`.
- Must **not** read `IPC_PORT` or any other value from the environment.
