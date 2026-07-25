# Local OTel-Shaped Telemetry

Mesh Bridge writes local-only telemetry to one JSONL file. There is no exporter,
no collector, no HTTP endpoint, and no network transmission of log records.

## Paths

`MESH_BRIDGE_STATE_DIR` overrides all platform defaults. When set, logs are in
`<root>/Logs/telemetry.jsonl` and journal state is in `<root>/journal`.

Default paths:

| Platform | Telemetry file | Journal state |
|---|---|---|
| Windows | `%ProgramData%\Mesh Bridge\Logs\telemetry.jsonl` | `%ProgramData%\Mesh Bridge\journal` |
| Linux | `${XDG_STATE_HOME:-$HOME/.local/state}/mesh-bridge/logs/telemetry.jsonl` | `${XDG_STATE_HOME:-$HOME/.local/state}/mesh-bridge/journal` |
| macOS | `$HOME/Library/Logs/Mesh Bridge/telemetry.jsonl` | `$HOME/Library/Application Support/Mesh Bridge/journal` |

Directories are created with mode `0700` where the platform honors POSIX modes.
The JSONL file is opened with mode `0600`.

On Windows the service runs as `NT AUTHORITY\LocalService`, so `scripts/install.ps1`
pre-creates the `%ProgramData%\Mesh Bridge` state root with its `Logs` and `journal`
subfolders, resets stale descendant ACLs, breaks inherited permissions on the state
root, and grants only SYSTEM full control, Administrators full control, and
LocalService modify rights. These files contain full message bodies, so inherited
access from `%ProgramData%` is not retained.

## Record Shape

Each line is one OTel-shaped log record using OTLP/JSON field spelling:

| Field | Meaning |
|---|---|
| `timeUnixNano`, `observedTimeUnixNano` | Unix nanoseconds as decimal strings |
| `severityNumber`, `severityText` | INFO `9`, WARN `13`, ERROR `17` |
| `eventName` | Stable event code, or `message` for body records |
| `body.stringValue` | Full logged body or event code |
| `attributes[]` | OTel KeyValue array, string values only |
| `resource.attributes[]` | Service, version, OS, and host attributes |
| `instrumentationScope` | The local Mesh Bridge instrumentation scope |

OTLP defines no file format. This project's JSONL framing is not an OTLP wire
export: it writes one LogRecord-like object per line, without a `resourceLogs`
envelope.

Trace fields such as `traceId` and `spanId` are omitted because the bridge does
not run a tracer.

## Retention

There is exactly one active file: `telemetry.jsonl`. Mesh Bridge prunes once on
startup and then daily at local 02:00. Pruning keeps records whose
`timeUnixNano` is within the last 24 hours and skips malformed lines without
throwing. Because pruning runs daily, physical retention can approach 48 hours.

The prune rewrite is atomic: write a temp file in the same directory, fsync it,
then rename over the destination. It never unlinks the destination first.

## Privacy And Failure Behavior

Full Discord and Mesh text bodies are written locally. The TUI and IPC snapshot
remain sanitized and do not expose message bodies.

Before anything reaches disk, Mesh Bridge exact-token redacts the literal
`discordToken` and `ipcToken` values from configuration. Empty values and values
shorter than eight characters are ignored so a trivial secret cannot blank the
file. Redaction is applied to every string in the record and again to the final
serialized line.

Telemetry is fail-open. Filesystem errors in the telemetry path never stop relay
traffic. The first failure marks `logDegraded`, emits one TUI warning and one
stderr warning, and drops telemetry records silently until a later write
succeeds. On recovery, the TUI and stderr receive one recovery notice.
