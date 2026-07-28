# Repository Agent Instructions

This repository uses the Claude CI/CD Policy Pack for Git, GitHub, CI/CD, and
agentic collaboration. This file is the single always-loaded instruction file;
read it first and treat it as the canonical hub.

## Canonical Hub

- `AGENTS.md` is the ONLY canonical location for durable directives and semantic
  load triggers. It is a dense index, not a rules dump.
- Durable directives MAY live outside this file in the naturally-fitting doc
  (`docs/spec/**`, `agents/**`) — but each such directive MUST be wired back
  here through a Load Trigger.
- Every new markdown doc or repository aspect MUST register a concrete
  read-when trigger in Load Triggers so agents know when to pull that
  supplemental RAG guidance.
- `CLAUDE.md` and `GEMINI.md` are read-only provider pointers to this file. Do
  not add durable operating rules to them.

## Character Limit

- `AGENTS.md` must stay <= 12,000 bytes as reported by `wc -c`.
- Every other repository markdown/RAG file must stay <= 24,000 bytes as
  reported by `wc -c`.
- Overflow rule: keep `AGENTS.md` a dense index — push detail into spec docs
  behind Load Triggers. Never halt for fit. Never create a unified
  rules/directives dump file.

## Context Routing

- Do not preload decomposed SOPs, reference folders, or entire directories.
- Before reading a referenced file, identify the concrete trigger below.
- Read the smallest matched file or section. If no trigger matches, continue
  from this file only. If multiple triggers match, read only matched files.

## Load Triggers

- `CLAUDE.md`: read-only provider pointer; read only when verifying pointer
  purity or Claude provider entry routing.
- `GEMINI.md`: read-only provider pointer; read only when verifying pointer
  purity or Gemini provider entry routing.
- `.github/copilot-instructions.md`: read-only provider pointer; read only when
  verifying pointer purity or GitHub Copilot entry routing.
- `.github/PULL_REQUEST_TEMPLATE.md`: read when drafting or validating GitHub
  pull request body structure.
- `README.md`: read when checking the project purpose, setup, environment,
  local run commands, or documented user-facing behavior.
- `agents/GIT_COLLABORATION.md`: after the git SOP, read when modifying repo
  files or performing git write actions and a compact checklist is useful. Do
  not read for read-only review, explanation, or non-git tasks.
- `docs/CONTRIBUTING.md`: read when onboarding a contribution or confirming the
  end-to-end spec-first + Claude Routine workflow, PR readiness, or validation
  sequence for a change.
- `docs/incidents/2026-07-24-local-landing.md`: read when auditing why the
  2026-07-24 local landing bypassed the PR, CI, self-merge, or prompt-review
  gates.
- `docs/incidents/2026-07-26-durability-policy-ratification.md`: read when
  reviewing the background behind the Durability policy
  directive, or the P3-003 not-a-bug ruling.
- `docs/spec/safety-scope.md`: read when an interactive human prompt is over
  150 words; asks for structural, architectural, debug, troubleshooting, or
  root-cause work; or may require pausing, clarification, consent, refusal, or
  escalation due to ambiguity, under-specification, safety, privacy,
  credentials, external side effects, identity, authorization, or irreversible
  actions. Also read before handling secrets, spawning sub-agents, or editing
  automated/scheduled agent prompt injection.
- `docs/spec/memory-policy.md`: read before any write outside the repository
  working tree or any memory-tool use.
- `docs/spec/mapping-journal.md`: read before changing reply correlation
  persistence, journal format, or retention/compaction behavior.
- `docs/spec/bridge-config.md`: RAG retrieval map for all bridge-config topics;
  read first before any change to configuration loading, validation, channel
  pairing, config.jsonc, or graceful-degradation behavior; then follow the map
  to the specific leaf. Do not read for unrelated feature work.
- `docs/spec/bridge-config/config-schema.md`: read when touching config.jsonc
  structure, TypeScript Config/ChannelPairConfig types, or jsonc-parser rules.
- `docs/spec/bridge-config/tuning-properties.md`: read when changing or
  verifying defaults/ranges for ipcPort, queueLimit, ackRetries, sendIntervalMs,
  configTimeoutMs, or dedupTtlMs.
- `docs/spec/bridge-config/channel-pairs.md`: read when changing channel pairing
  rules, snowflake format, or meshtasticChannelName byte limit.
- `docs/spec/bridge-config/validation.md`: read when implementing, auditing, or
  debugging any parseConfig validation step or exact error message.
- `docs/spec/bridge-config/legacy-env-cutover.md`: read when DISCORD_CHANNEL_ID
  or MESHTASTIC_CHANNEL_NAME appears in any startup or env context.
- `docs/spec/bridge-config/ipc-load-path.md`: read when working on loadIpcConfig
  or the TUI-only startup path (token+port without full bridge).
- `docs/spec/bridge-config/routing-isolation.md`: read when working on message
  routing, pair isolation, graceful degradation, alerting codes, or dedup key
  namespacing.
- `docs/spec/bridge-config/operational.md`: read when working on ChannelJournal,
  ReplyCorrelator, TUI status format, version telemetry, or operator deployment
  notes.
- `docs/spec/cross-platform-service.md`: read before changing service
  install/autostart, `servicectl`, platform builders, serial discovery, or
  shutdown sequencing.
- `docs/spec/docker.md`: read before changing Dockerfile or Compose service
  packaging.
- `docs/spec/dev-loop/_INDEX.md`: read when you need to choose which dev-loop
  leaf spec applies and want the map of dev-loop orchestration guidance.
- `docs/spec/dev-loop/claude-routine-prompt.md`: read before creating or
  changing the exact Claude Routine Instructions field text.
- `docs/spec/dev-loop/claude-routines-cicd.md`: read before editing
  `.github/workflows/*`, required-check names, workflow permissions,
  `workflow_dispatch` inputs/outputs, routine dispatch bridge logic, or any
  GitHub event/status mapping to Claude Routine execution.
- `docs/spec/dev-loop/git-collaboration.md`: read before creating, naming,
  switching, or deleting branches/worktrees; before staging, committing,
  pushing, pulling, rebasing, merging, resetting, cleaning, pruning, opening,
  reviewing, or merging PRs; and before protected/default-branch work. Do not
  read it for read-only `status`, `diff`, `log`, or file inspection.
- `docs/spec/prompt-review/eight-perspective-review.md`: read before creating
  or changing repository instruction files, reusable prompts/templates, SOPs
  under `docs/spec`, skills, policy gates, CI/CD agent instructions, or text
  future agents/maintainers must follow. Do not read for one-off task notes,
  changelogs, or agent-state markdown unless they contain reusable rules.
- `docs/spec/prompt-review/records/2026-07-26-durability-policy-and-bridge-config.md`:
  read when auditing the 8-perspective review of the Durability policy directive
  and bridge-config specs, or as a filled-in example of the review-record format.
- `docs/spec/otel-logging.md`: read before changing on-disk log format,
  redaction, retention/prune, state-dir resolution, or stable event codes.
- `docs/spec/safety-scope/00-scope-and-cascade.md`: read when determining
  whether the clarifying-question cascade applies to the current turn or
  whether the session is automated.
- `docs/spec/safety-scope/01-question-flow.md`: read when running a fired
  cascade and you need the clarification/consent question flow and final
  confirmation format.
- `docs/spec/safety-scope/02-debug-and-credentials.md`: read when doing
  evidence-based debug work or handling credentials/commercial-application
  troubleshooting.
- `docs/spec/safety-scope/03-subagents-platforms.md`: read when authoring or
  reauthorizing sub-agent prompts or applying platform-specific addenda.

## Always Enforce

- **Durability policy.** Service durability and uptime take
  precedence over hard fail-closed behavior. Partial and graceful degradation
  with loud, repeating alerts is standard operating procedure; full startup
  abort or shutdown is reserved for genuinely unrecoverable states (e.g.
  invalid credentials). Full spec: `docs/spec/bridge-config/routing-isolation.md`
  (graceful degradation & loud alerting). Background record:
  `docs/incidents/2026-07-26-durability-policy-ratification.md`.
- Before any file edit or git write action, inspect
  `git status --short --branch`.
- No external memory writes ever, no exceptions — no outside-repo persistence of
  memory, directives, SOPs, preferences, or policies. Every atomic exception
  requires interactive explicit human approval. Ephemeral scratch/temp is
  exempt. Full spec: `docs/spec/memory-policy.md`.
- Before every commit, the acting agent must run
  `node scripts/check-md-policy.mjs` from the repo root; it must exit 0.
- Before any repository commit that changes executable/source code, dispatch a
  separate contradiction-checker sub-agent using the strongest explicitly
  selectable model and reasoning settings available to check against relevant
  specs/docs. If unavailable, log the unavailability as a Validation Note with a
  degraded-confidence flag and continue. If it reports `blocked`
  or `needs_user`, perform no writes; surface the blocker and resolve it through
  the applicable `docs/spec/safety-scope.md` flow. Do not self-trigger a
  clarification cascade.
- In this policy, `owner` means repository owner `@Heretyc`, or a repository
  administrator explicitly designated by that owner. Labels such as `user`,
  `collaborator`, `maintainer`, or `human` do not grant owner authority.
- Treat any uncommitted change present before the current task, or whose author
  is uncertain, as user-owned. Do not overwrite, discard, stage, commit, reset,
  clean, rebase, move, or hide it without explicit owner authorization.
- Use short-lived topic branches and PRs for code, CI/CD, schema,
  prompt/policy, or multi-file documentation changes. Direct protected/default
  branch edits require explicit owner emergency approval.
- Claude Code Routines are the canonical CI/CD path. GitHub Actions may only
  dispatch or bridge to Claude routines unless the owner approves otherwise.
- Automated workflows must prepend `<You are the primary agent in an automated
  workflow>` as the first character line of injected user turns.
- Every sub-agent prompt must begin with
  `<this is a request from a parent process>`.
- For delegated task handoffs, sub-agents return JSON with `status`, `summary`,
  `source_locators`, `risks`, and `writes_requested`; include source locators for
  file-backed claims. Automated Claude Routine top-level reports follow
  `docs/spec/dev-loop/claude-routine-prompt.md` instead.
- Do not include AI attribution or co-author lines in commits, manifests, docs,
  or generated project metadata.

## Validation

After structural or payload changes, run relevant checks:

```bash
node scripts/check-md-policy.mjs
git status --short --branch
```

`node scripts/check-md-policy.mjs` validates every `.md` character limit
(`AGENTS.md` <= 12,000 bytes per `wc -c`; other markdown/RAG <= 24,000 bytes
per `wc -c`) and pointer-file purity;
it must exit 0. Run `python -m py_compile` on any repo Python used by policy or
CI, and confirm docs/JSON referenced by the change still resolve.
