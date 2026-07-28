# Decision: 2026-07-26 Durability Policy Ratification

Date: 2026-07-26

This note is the background record for the **Durability policy** directive in
`AGENTS.md` ("Always Enforce"). It records the durability ruling, when and how it
was given, and exactly which durable changes it covers. It follows the
record precedent set by `docs/incidents/2026-07-24-local-landing.md`.

## Authorization

Owner authorization on record. On 2026-07-26 the repository owner (`@Heretyc`)
ruled during the continuous-audit per-fix gate:

> Service durability and uptime take precedence over hard fail-closed behavior.
> Partial and graceful degradation with loud, repeating alerts is standard
> operating procedure. Full startup abort or shutdown is reserved for genuinely
> unrecoverable states such as an invalid credential. Missing or unresolvable
> channels must never abort startup. Finding P3-003 (`.env` ACL fail-closed) is
> explicitly rejected as not-a-bug.

The ruling was issued interactively by the owner during the continuous-audit
per-fix gate (the review checkpoint applied to each audit fix before it lands),
not inferred by an agent.

## Scope of ratification

This ruling authorizes and constrains the following durable changes:

1. `AGENTS.md` "Always Enforce" — the **Durability policy**
   bullet: durability/uptime take precedence over hard fail-close; partial and
   graceful degradation with loud, repeating alerts is SOP; full startup abort or
   shutdown is reserved for genuinely unrecoverable states (e.g. invalid
   credentials).
2. `docs/spec/bridge-config/routing-isolation.md` — the "Graceful Degradation and
   Loud Alerting" section: the service MUST start and keep bridging every pair
   that resolves and MUST NOT refuse to start over one misconfigured channel;
   channel-level failures are never fatal; only an invalid token stays fatal;
   `MESH_CHANNEL_UNRESOLVED` / `DISCORD_CHANNEL_UNRESOLVED` alerts repeat every
   2 minutes until resolved.

## Explicitly rejected

- **P3-003 (`.env` ACL fail-closed)** — rejected as not-a-bug. Fail-closed on
  `.env` file ACLs is not required; it is not adopted as policy.

## Consequences

- Missing, unresolvable, or misconfigured channels must never abort startup.
  Startup abort / shutdown is reserved for genuinely unrecoverable states such as
  an invalid credential (token).
- Loud, repeating alerts (per `routing-isolation.md`) are the required signal for
  degraded pairs; silent degradation is non-compliant.

## Cross-references

- Directive text: `AGENTS.md` → "Always Enforce" → Durability policy bullet.
- Full behavior spec: `docs/spec/bridge-config/routing-isolation.md`
  (Graceful Degradation and Loud Alerting).
- Review gate for this durable change:
  `docs/spec/prompt-review/records/2026-07-26-durability-policy-and-bridge-config.md`.
