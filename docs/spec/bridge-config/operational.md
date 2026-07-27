# Bridge Config — Reply Journals, TUI/Status, Telemetry, and Operational Notes

Load when: working on per-pair reply mapping journal setup, TUI/status display format,
version telemetry sourcing, or operator deployment notes (`config.jsonc.example`, gitignore,
`.env` separation).
Do not load when: you need routing or degradation behavior (→ `routing-isolation.md`) or
validation rules (→ `validation.md`).

## Reply Mapping Journals

One `ChannelJournal` instance is created per configured pair, keyed by `discordChannelId`.

Journal file path (format specified in `docs/spec/mapping-journal.md`):

```
<journalDir>/<discordChannelId>.reply-mapping.jsonl
```

- Each pair also owns one `ReplyCorrelator` backed by its journal.
- Journal and correlator instances must **never** be shared across pairs.
- On shutdown the implementation must close every pair's journal explicitly.
- Journal degradation is tracked per pair; aggregate `journalDegraded` status clears only
  when **all** pairs' journals have recovered.

## TUI and Status Display

The TUI `Configured pairs` section and the `status` command must list every configured pair
and each pair's resolved Meshtastic channel index (or `pending` if not yet resolved).

Format per entry:

```
Discord <discordChannelId> <-> Meshtastic <meshtasticChannelName> (index <number|pending>)
```

`StatusSnapshot` carries a `connections.channelPairs` array with one entry per configured
pair, updated on connect and cleared to pending on disconnect.

## Version Telemetry

`service.version` is read from `package.json` at startup using `readFileSync` and
`JSON.parse`. The version must **not** be hardcoded or duplicated. No `package.json`
changes are required; the file is already present in the runtime image.

## Operational Notes

| Topic | Note |
| ----- | ---- |
| `config.jsonc.example` | Committed to the repo; working commented example. Operators copy to `config.jsonc` and fill in real values. |
| `config.jsonc` | Gitignored; must never be committed. |
| `.env` | Must contain only `DISCORD_TOKEN` and `IPC_TOKEN`; all other configuration is in `config.jsonc`. `.env.example` must document this separation. |
| `jsonc-parser` | Runtime dependency; no JSON Schema package or generated validator used. |
| Config file path | Not configurable; always resolved relative to the process working directory (repo root). |
