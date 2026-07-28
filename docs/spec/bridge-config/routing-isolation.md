# Bridge Config — Routing, Isolation, and Graceful Degradation

Load when: reviewing message routing between Discord and Meshtastic pairs, the isolation
guarantee, graceful-degradation behavior, alerting codes and cadence, the channel-name
collision startup failure, or dedup key namespacing.
Do not load when: you only need config loading or validation rules (→ `validation.md`,
`config-schema.md`).

## Routing Lookup Maps

```ts
pairsByDiscordId:   Map<string, PairState>  // keyed by discordChannelId
pairsByMeshChannel: Map<number, PairState>  // keyed by resolved numeric index
```

**Discord → Mesh:** `message.channelId` / `reaction.message.channelId` is looked up in
`pairsByDiscordId` before any body work or partial fetch. No entry → ignore. The accepted
job stores `discordChannelId` as a durable route tag; the worker re-resolves the pair from
the tag at delivery time.

**Mesh → Discord:** After radio configuration, each `meshtasticChannelName` resolves to a
numeric index populating `pairsByMeshChannel`. `packet.channel` is looked up before decode
or dedup. No entry → ignore.

If a `meshtasticChannelName` does not resolve to a device channel index (name absent from
device channel list or device not yet seen), that pair stays pending and receives no
Mesh → Discord traffic; the TUI and `status` command display it as `(index pending)`.

## Isolation Guarantee

A message received on one pair must **never** be relayed to another pair. Route-tag-based
delivery is mandatory even with global FIFO queues. The worker must never infer a job's
destination from which connection or channel is active at queue-front time.

## Graceful Degradation and Loud Alerting

Durability and uptime take priority over hard fail-close. The service **MUST** start and
keep bridging every pair that resolves, and **MUST NOT** refuse to start over one
misconfigured channel.

| Event | Alert code | Behavior |
| ----- | ---------- | -------- |
| Meshtastic channel name unresolved (P3-001/P4-001) | `MESH_CHANNEL_UNRESOLVED` | Error-level event on each successful device connect; repeats every 2 minutes while any name is still pending |
| Meshtastic channel resolved | `MESH_CHANNEL_RESOLVED` | Logs recovery; alerting stops for that name |
| Discord channel unresolvable (P3-002) | `DISCORD_CHANNEL_UNRESOLVED` | Error-level event; retry loop re-reads `config.jsonc` every 2 minutes and re-attempts resolution (no restart required) |
| Discord channel resolved | `DISCORD_CHANNEL_RESOLVED` | Logs recovery |

Channel-level failures (Unknown Channel, Missing Access, not sendable, missing permissions)
are **never** fatal. Only an invalid token stays fatal.

## Meshtastic Channel Name Collision — Startup Failure

If two configured `meshtasticChannelName` values resolve to the **same** device channel
index, startup fails immediately:

```
Meshtastic channel name collision: "alpha" and "bravo" both resolve to device channel index 3
```

Template:

```
`Meshtastic channel name collision: ${JSON.stringify(nameA)} and ${JSON.stringify(nameB)} both resolve to device channel index ${index}`
```

`nameA` and `nameB` are the conflicting names in config array order; `index` is the shared
numeric index.

## Dedup Key Namespacing

Dedup keys include `discordChannelId` to prevent collision across pairs:

| Event | Key format |
| ----- | ---------- |
| Discord message | `discord:${discordChannelId}:${message.id}` |
| Mesh packet (nonzero ID) | `mesh:${discordChannelId}:${packet.from}:${packet.id}` |
| Mesh packet (ID zero) | `mesh:${discordChannelId}:${packet.from}:0:${packet.rxTime}:${sha256PayloadPrefix}` |

`sha256PayloadPrefix` = first 16 lowercase hex characters of the SHA-256 of the decoded
packet payload bytes.

Global state (one queue per direction, one send clock, one Discord client, one Meshtastic
device, one telemetry sink, one IPC server, global counters) is shared across all pairs.
`queueLimit` governs the total per direction, not per pair.
