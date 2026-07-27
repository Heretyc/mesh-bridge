# 8-Perspective Review Records — 2026-07-26 durability policy & bridge-config

These records satisfy the Directive/SOP Review Gate
(`docs/spec/dev-loop/git-collaboration.md`) and
`docs/spec/prompt-review/eight-perspective-review.md` for the durable
directive/SOP/spec content introduced on branch `fix/s1-batch1-audit`
(PR #58): the new `AGENTS.md` "Durability policy" directive and the new
`docs/spec/bridge-config.md` retrieval map plus its leaf specs. Records follow
the template in `eight-perspective-review.md` exactly. Findings are honest: the
first review surfaced a real concern (the unbacked "user-ratified" label), which
was revised and re-run to consensus.

## Review Record: AGENTS.md — Durability policy directive

- File: `AGENTS.md` ("Always Enforce" → Durability policy bullet)
- Review date: 2026-07-26
- Scope: New durable directive asserting durability/uptime precedence over hard
  fail-close, graceful degradation with loud alerts as SOP, and the
  "user-ratified" label.
- Clarity reviewer: pass
- Role and context reviewer: pass
- Structure reviewer: pass
- Example reviewer: pass
- Negative-constraint reviewer: pass
- Reasoning and decomposition reviewer: pass
- Output-format reviewer: pass
- Iteration and adversarial reviewer: pass
- Concerns: First pass — Role and context reviewer and Iteration and adversarial
  reviewer both flagged the "(user-ratified)" label as an authority claim with no
  linked owner authorization, PR/issue reference, or incident note, unlike the
  precedent `docs/incidents/2026-07-24-local-landing.md` which quotes owner
  authorization verbatim. An agent could treat "user-ratified" as settled without
  evidence (adversarial shortcut). Clarity reviewer also asked where the
  authorizing decision is recorded.
- Revisions made: Created `docs/incidents/2026-07-26-durability-policy-ratification.md`
  quoting the owner's 2026-07-26 continuous-audit per-fix-gate ruling verbatim
  (durability/uptime precedence, graceful degradation SOP, only invalid
  credentials fatal, missing channels never abort startup, P3-003 rejected). Added
  a citation to that record from the AGENTS.md durability bullet and a Load
  Trigger for the record. Re-ran the review: Role/context and Iteration/adversarial
  now pass because the ratification claim is backed by an auditable, cited record.
- Consensus: pass

## Review Record: docs/spec/bridge-config.md + leaf specs

- File: `docs/spec/bridge-config.md` (retrieval map) and leaf specs under
  `docs/spec/bridge-config/` (notably `routing-isolation.md` — Graceful
  Degradation and Loud Alerting).
- Review date: 2026-07-26
- Scope: New RAG retrieval map plus leaf specs defining config loading,
  validation, channel pairing, routing isolation, graceful degradation, alert
  codes/cadence, and dedup key namespacing.
- Clarity reviewer: pass
- Role and context reviewer: pass
- Structure reviewer: pass
- Example reviewer: pass
- Negative-constraint reviewer: pass
- Reasoning and decomposition reviewer: pass
- Output-format reviewer: pass
- Iteration and adversarial reviewer: pass
- Concerns: First pass — Iteration and adversarial reviewer noted the terse
  AGENTS.md summary alone could be misread as "never fail closed"; the leaf spec
  must state the fatal exception explicitly. Verified `routing-isolation.md`
  already bounds this: "Channel-level failures ... are never fatal. Only an
  invalid token stays fatal," and the collision case is an explicit startup
  failure. Reasoning/decomposition reviewer confirmed the retrieval map keeps each
  leaf small and load-triggered rather than one oversized doc. No unresolved
  concern.
- Revisions made: None to the specs; confirmed each leaf is wired to a concrete
  AGENTS.md Load Trigger and the retrieval map routes to the correct leaf.
- Consensus: pass
