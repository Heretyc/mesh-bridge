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

- `AGENTS.md` must stay <= 24,000 bytes as reported by `wc -c`.
- Every other repository markdown/RAG file must stay <= 24,000 bytes as
  reported by `wc -c`.
- Overflow rule: keep `AGENTS.md` a dense index — push detail into spec docs
  behind Load Triggers. Never halt for fit. Never create a unified
  rules/directives dump file.
- Inline exception: the byte-identical Project Board Law and Historian content
  policy blocks below are required always-loaded canonical material. They are
  exempt from the dense-index and overflow placement rules and must not move
  behind Load Triggers.

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
- `docs/spec/safety-scope.md`: read when an interactive human prompt is over
  150 words; asks for structural, architectural, debug, troubleshooting, or
  root-cause work; or may require pausing, clarification, consent, refusal, or
  escalation due to ambiguity, under-specification, safety, privacy,
  credentials, external side effects, identity, authorization, or irreversible
  actions. Also read before handling secrets, spawning sub-agents, or editing
  automated/scheduled agent prompt injection.
- `docs/spec/memory-policy.md`: read before any write outside the repository
  working tree or any memory-tool use.
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
  specs/docs. If unavailable, halt and tell the owner. If it reports `blocked`
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

## Validation

After structural or payload changes, run relevant checks:

```bash
node scripts/check-md-policy.mjs
git status --short --branch
```

`node scripts/check-md-policy.mjs` validates every `.md` character limit
(`AGENTS.md` <= 24,000 bytes per `wc -c`; other markdown/RAG <= 24,000 bytes
per `wc -c`) and pointer-file purity;
it must exit 0. Run `python -m py_compile` on any repo Python used by policy or
CI, and confirm docs/JSON referenced by the change still resolve.

---

## PROJECT BOARD LAW - BINDING, NO EXCEPTIONS

https://github.com/users/Heretyc/projects/3 is the canonical Source of Truth
    for the PLANNING and STATUS of all repo Work. It is subordinate to the alignment chain
    in Law 2: where Board and Premise conflict, the Premise wins and the Board is corrected.

### DEFINITIONS
"Work" = any mutation of git-tracked content: commits, branches, PRs. Wiki edits,
    releases, tags, and comments are not Work. Board mutations are not Work and never
    require issues.
"Human Review" (HR) = engagement of the human via the structured question tool,
    presented as if the human has no knowledge of the project or repo. Two modes:
  - Decision HR: 2+ options, each with pros and cons.
  - Action HR: 1 required action, why it is needed, and the consequence of inaction.
    HR is NEVER skippable for any authority or reason. One HR session MAY bundle every
    trigger pending at that moment.
"Premise" = The answer to "what is this + why care?":  who it's for + problem + what
    it does + why not alternatives. Canonical copy: first paragraph of README.md,
    MAXIMUM 1000 characters.
"Short Premise" = Verbatim-identical version of Premise (minus the "why not 
    alternatives" aspect) MAXIMUM 350 characters and found in BOTH the Repo and Project 
    Short Descriptions.
"Interactive Session" = A harness that has a working structured question tool. 
    Lacking this, the session is considered non-interactive.

### DIRECTIVES

1. Short Premise must faithfully condense the canonical Premise. Any edit to the 
    Premise updates both Short Premise copies in the same session. If the copies mismatch, 
    truncate, or drift from the canonical: the README is canonical and
    the mismatch is an HR trigger. 
2. Code MUST align with repo Spec docs. Spec MUST align with the Premise at all
    times. The Premise is always the tie-breaker. If in doubt, HR. If the
    Repo lacks the canonical Premise in README.md, or either Short Description
    lacks the Short Premise: recon the project specs/code and present a proposed
    Premise and Short Premise via Decision HR; that same HR authorizes the board
    issue for the restoration edit (which is Work).
3. All Work maps to a board issue. All issues map to Milestones. No unmapped Work.
4. Every issue/epic carries ALL required fields at ALL times: Label(s),
    Priority, Size, Estimate, Iteration, Milestone, Assignee, Relationships,
    branch/PR link, and updated Status. Satisfiability rules: issues are created
    fully populated in a single operation, with Iteration taken from the
    authorizing HR (Law 9, bundled per the HR definition); the branch/PR link is
    mandatory from the moment the branch or PR exists and MUST be back-filled in
    the same working session ("none yet" before that; "n/a" for board-only
    issues); Assignee follows Law 11 (an idle issue may be unassigned or
    assigned to anyone; an actively-worked issue MUST be assigned to the worker).
5. Every PR maps to a fully populated issue.
6. Live updates are mandatory: update the mapped item BEFORE, DURING, and AFTER
    Work. Agents update existing items in real time without seeking permission.
    While an HR is pending on an item, only Status changes and comments recording
    the block are permitted on it.
7. Every agent MUST fully understand the Board plan and the Premise BEFORE acting.
    The read-only sweep in Law 13 both requires and satisfies this understanding.
8. Any conflict between tasked work and the Board: STOP and deconflict via HR
    BEFORE any board edit. Conflicts between Board and Premise resolve per Law 2.
9. Net-new Work not on the board: HR BEFORE adding it. That HR also supplies the
    new issue's Iteration and other judgment fields (Law 4).
10. Board ops use ONLY the `gh` CLI (including `gh api`) or GitHub MCP. Either
    channel may perform supported Board reads and mutations. If neither is
    available, authenticated, or adequately scoped: Action HR asking the human
    to enable one; `gh` project scope may be refreshed with `gh auth refresh -s
    project` (interactive; agents cannot complete it).
11. Before starting Work on an unassigned issue, assign it to the authenticated GitHub
    user. If an issue you are tasked to work is assigned to someone else: Action
    HR to reassign. If the human declines, stand down from that item: you are
    forbidden from performing Work on any issue not assigned to the authenticated
    GitHub user. Idle issues may remain unassigned or assigned to others.
12. Never store local paths or machine-specific information anywhere on the Board.
13. Sweep the Board before starting and after finishing Work: find the most
    recently COMPLETED "Project Board true-up #". If it completed more than 5
    business days ago, or none exists: dispatch 2+ review subagents over all
    incomplete board items for non-compliance with these Laws (if the harness
    cannot spawn subagents, perform work directly). HR is mandated on all 
    non-compliant items found (bundle-able). Once the true-up is complete: mark 
    it complete and create the next true-up issue with an incremented #, 
    NO assignee, description = a VERBATIM copy of these Laws from their canonical 
    home (this document at the repo root).
14. HR may be DEFERRED only in headless runs where no human is reachable 
    (determined if no structured question tool exists in your harness), and
    deferral is never resolution. Queue the item as a comment on the dedicated
    HR-queue board item, set the affected issue's Status to "Awaiting Review" 
    (rename "In Review" to "Awaiting Review" if it exists. If you cannot rename, 
    use "In Review" status), and proceed only with Work unaffected by the pending 
    question; doubt about whether Work is affected resolves to AFFECTED. Any 
    Interactive Session MUST drain the queue (bundled HR) BEFORE starting any 
    new Work. If any queued item is older than 5 business days, ALL Work halts 
    until the queue drains. Every true-up (Law 13) reports the queue's contents. 
    Queued items are never deemed approved, expired, or abandoned.

---

## Content Policy - No Historical Framing (Standing, Unskippable)

Repo content states only the current objective truth. This rule is always in 
    effect, at maximum strength, and applies to every tracked file.

- No historical context or origin stories. Do not narrate how a system, methodology, or decision came to be.
- No allusions to previous versions, iterations, sessions, or rejected designs (no "v1/v2/v3", no "Approach A/B", no "the old system").
- No "formerly / replaces / superseded / was / updated from / previously" meta-framing about the repo's own design.
- No changelog narration in docs, and no dated "as of <date>, N tasks complete" journaling.
- Git history is the sole record of how anything changed; never restate that history in prose.
- Do not include AI attribution or co-author lines in PRs, commits, manifests, 
    docs, or generated project metadata.
