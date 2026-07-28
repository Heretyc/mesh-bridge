# Bridge Config — Legacy Environment Variable Cutover

Load when: `DISCORD_CHANNEL_ID` or `MESHTASTIC_CHANNEL_NAME` appears in any `.env` or
deployment context, or when pinning the exact error text for this startup check.
Do not load when: you need the full validation ordering (→ `validation.md`) or the
IPC-only load path (→ `ipc-load-path.md`).

## Hard Cutover Rule

Presence of `DISCORD_CHANNEL_ID` or `MESHTASTIC_CHANNEL_NAME` in the environment —
**at any value, including empty string** — is a startup failure. The implementation must:

- Check for these names before reading any value.
- Never use them as fallbacks.

This check applies on **all** load paths, including `loadIpcConfig`.

## Exact Error Message

```
Legacy environment variables DISCORD_CHANNEL_ID, MESHTASTIC_CHANNEL_NAME are no longer supported; move channel pairs into config.jsonc
```

Template:

```
`Legacy environment variables ${legacy.join(", ")} are no longer supported; move channel pairs into config.jsonc`
```

- Include only the names whose values are not `undefined`.
- Preserve order: `DISCORD_CHANNEL_ID` then `MESHTASTIC_CHANNEL_NAME`.

## Operator Action

Operators must remove these variables from `.env` and all deployment environments.
Pointing operators to `config.jsonc.example` in the error message is encouraged, but
the exact text above is the normative form.
