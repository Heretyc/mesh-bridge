# Bridge Config — Config.jsonc Schema

Load when: inspecting the config.jsonc file structure, TypeScript `Config`/`ChannelPairConfig`
interfaces, the two-source (`.env` + `config.jsonc`) split, or `jsonc-parser` usage rules.
Do not load when: you only need tuning defaults (→ `tuning-properties.md`), channel-pair rules
(→ `channel-pairs.md`), or validation error messages (→ `validation.md`).

The bridge uses two strictly separated configuration sources:

- `.env` — secrets only: `DISCORD_TOKEN` and `IPC_TOKEN`. No other values are read from the
  environment, now or as fallbacks.
- `config.jsonc` — all non-sensitive configuration: IPC port, global tuning knobs, and the
  channel pair list. Lives at the repo root, is gitignored, must be created by the operator
  before startup.

## config.jsonc Annotated Example

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

## TypeScript Interfaces

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

The parsed `Config` is fully populated before use.

## Parser and Validation Constraints

- Parsed by `jsonc-parser` (runtime dependency). Comments and trailing commas are permitted.
- Unknown properties are ignored. Only consumed properties are validated.
- All numeric properties are optional; each uses the default when absent or `undefined`.
- The `channels` property is required and has no default.
- The root is validated as `unknown`; hand-validated inside `parseConfig` — no JSON-Schema
  object, generated validator, or additional exported `Config`-shaped type or schema class
  beyond the single `Config` interface.
- There is no configurable config file path. `config.jsonc` is always resolved relative to
  the process working directory (repo root in all supported deployment paths).
