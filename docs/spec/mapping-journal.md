# Reply Mapping Journal

Status: normative for reply-correlation persistence.

The bridge persists reply correlation in one append-only JSONL file per
validated Discord channel id:

```text
<journalDir>/<discord-channel-id>.reply-mapping.jsonl
```

The channel id must match `/^\d{17,20}$/` before it is used in the filename.
No unvalidated id is interpolated into a path.

Each line is one direction-tagged mapping record:

```json
{"dir":"discordIdByMeshId","k":123,"v":"123456789012345678","at":1900000000000}
```

`meshRootByDiscordId` maps a Discord message id to its canonical mesh root
packet id. `discordIdByMeshId` maps every correlated mesh packet id, including
chunks and aliases, to the Discord message id.

Bounds are fixed, not configured:

- 10,000 live entries per direction.
- A rolling 30-day lifetime per entry.
- Immediate logical expiry: reads return no value once an entry reaches 30 days
  old, even if compaction has not run.
- Insertion-order eviction is applied independently per direction.

Startup replays the channel file in order and reconstructs both directions with
the same TTL and capacity rules used at runtime. Malformed or torn JSONL lines
are skipped without failing startup.

Compaction runs once at startup and then daily at local 02:00. It atomically
rewrites the file with only live entries, sorted by ascending timestamp. The
rewrite preserves the union of both directions, so a live mesh alias is not lost
just because the reverse canonical-root entry was independently evicted.

Compaction is gated on a successful startup replay. If the startup read fails
for any non-missing-file reason, the in-memory maps stay empty but the on-disk
file is still recoverable, so compaction becomes a no-op for the process
lifetime: neither the daily 02:00 timer nor `close()` may rewrite the file. This
prevents an empty rebuild from clobbering recoverable data, letting a later
healthy restart replay the intact file. Each skipped compaction logs one stderr
warning. Appends still fail open.

Canonical-root-versus-alias semantics match `ReplyCorrelator`:

- `recordOutboundChunk` maps every nonzero mesh chunk id to the Discord message.
- Only outbound chunk index 0 sets that Discord message's canonical mesh root.
- `recordInbound` sets both directions.
- `aliasMeshPacket` maps an extra mesh id to an existing Discord message without
  replacing its canonical root.
- Mesh packet id 0 is never correlated.

The journal is local JSONL only: no database, no exporter, and no new
dependency. Filesystem errors fail open. The relay keeps its in-memory
correlation, the TUI status snapshot marks the journal degraded, and stderr gets
one warning on the ok-to-degraded transition. Recovery clears the status quietly.
