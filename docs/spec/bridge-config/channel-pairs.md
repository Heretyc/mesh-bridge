# Bridge Config — Channel Pairs

Load when: configuring the `channels` array, understanding 1:1 strict pairing, Discord
snowflake format, Meshtastic channel name byte limits, or seeing the rejected-duplicate
example.
Do not load when: you need runtime routing behavior (→ `routing-isolation.md`) or
validation error messages (→ `validation.md`).

## Requirements

`channels` must be a non-empty array of 1–8 entries. (The 8-pair ceiling matches the
Meshtastic device channel-slot limit.)

Each entry is an object with exactly two fields:

| Field                    | Type   | Constraint                                                  |
| ------------------------ | ------ | ----------------------------------------------------------- |
| `discordChannelId`       | string | Snowflake matching `^\d{17,20}$`                            |
| `meshtasticChannelName`  | string | Non-empty; at most **11 UTF-8 bytes** (the Meshtastic device channel-name field limit) |

## Strict 1:1 Pairing

Every `discordChannelId` must be globally unique across all entries.
Every `meshtasticChannelName` must be globally unique across all entries.

The bridge enforces **no fan-in and no fan-out**: one Discord channel pairs with exactly one
Meshtastic channel and vice versa.

## Rejected Example — Duplicate Meshtastic Name

The following config is invalid because two entries share the same `meshtasticChannelName`:

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
