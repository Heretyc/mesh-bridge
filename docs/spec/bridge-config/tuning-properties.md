# Bridge Config — Tuning Properties

Load when: checking default values, valid ranges, or semantics of the six global tuning knobs
(`ipcPort`, `queueLimit`, `ackRetries`, `sendIntervalMs`, `configTimeoutMs`, `dedupTtlMs`).
Do not load when: you need the schema structure (→ `config-schema.md`) or validation error
messages (→ `validation.md`).

All tuning properties are **global only**. There are no per-channel overrides.

## Property Reference

| Property          | Default  | Range         | Description                        |
| ----------------- | -------- | ------------- | ---------------------------------- |
| `ipcPort`         | `47652`  | 1024–65535    | Loopback IPC listener port         |
| `queueLimit`      | `100`    | 1–1000        | Total queued jobs per direction    |
| `ackRetries`      | `2`      | 0–5           | Mesh send ACK retry count          |
| `sendIntervalMs`  | `1000`   | 250–60000     | Radio-wide minimum send interval   |
| `configTimeoutMs` | `30000`  | 5000–120000   | Meshtastic config probe timeout    |
| `dedupTtlMs`      | `300000` | 10000–3600000 | Dedup cache entry lifetime         |

## Semantics

- `queueLimit` is a total per direction, **not** multiplied by pair count. Global state
  (one queue per direction) is shared across all pairs.
- One send clock (`sendIntervalMs`) governs the single shared radio transmitter.
- Any non-`undefined` value that is not a safe integer or is outside the stated range
  triggers the corresponding validation error (→ `validation.md`).
