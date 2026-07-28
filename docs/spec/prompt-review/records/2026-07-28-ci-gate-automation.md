# 8-Perspective Review Record — 2026-07-28 CI-gate automation

This record satisfies the Directive/SOP Review Gate
(`docs/spec/dev-loop/git-collaboration.md`) and
`docs/spec/prompt-review/eight-perspective-review.md` for the governance and
CI-gate-automation rewrite on branch `fix/s1-batch1-audit` (PR #59). It covers
the mandate consolidation, the move to a single automated merge gate, and the
final governance changes: the automatable-only check preamble, the
`Scope exception:` PR-body mechanism, PROJECT BOARD LAW enforcement in the
routine gate, the restoration of the PROJECT BOARD LAW as the first section of
`AGENTS.md`, and the `AGENTS.md` byte-ceiling raise to 20,000 that holds the Law
verbatim. It spans `docs/spec/dev-loop/claude-routine-prompt.md`,
`docs/spec/dev-loop/claude-routines-cicd.md`,
`docs/spec/dev-loop/git-collaboration.md`, `docs/CONTRIBUTING.md`, `AGENTS.md`,
`agents/GIT_COLLABORATION.md`, `scripts/check-md-policy.mjs`, and
`docs/spec/prompt-review/eight-perspective-review.md`. It follows the template
in `eight-perspective-review.md` exactly. Concerns are honest: the review
surfaced the reduced-human-oversight tradeoff of a self-issued automated verdict
and the external-dependency risk of board enforcement, and records how the
owner-accepted design bounds each.

## Review Record: Governance & CI-gate automation rewrite

- File: `docs/spec/dev-loop/claude-routine-prompt.md`,
  `docs/spec/dev-loop/claude-routines-cicd.md`,
  `docs/spec/dev-loop/git-collaboration.md`, `docs/CONTRIBUTING.md`, `AGENTS.md`,
  `agents/GIT_COLLABORATION.md`, `scripts/check-md-policy.mjs`,
  `docs/spec/prompt-review/eight-perspective-review.md`
- Review date: 2026-07-28
- Scope: Consolidation of the merge-governance policy onto the
  `claude-routine-verdict` commit status as the single automated merge gate;
  alignment of the routine report templates with the defined check set; the
  contradiction-checker fallback destination; the eight-perspective consensus
  rule that routes residual concerns back to the PR diff; and the final
  governance additions — (1) the `claude-routine-prompt.md` Scope-coherence
  check and its `Scope exception:` PR-body mechanism; (2) the Project Board
  currency check enforcing the PROJECT BOARD LAW via GitHub MCP/`gh`; (3) the
  automatable-only preamble scoping every check to repo/diff/PR metadata with
  `blocked` reserved for infrastructure and policy findings failing with
  enumerated gaps; (4) restoration of the PROJECT BOARD LAW as the first,
  never-moved section of `AGENTS.md`, verbatim from its source; and (5) the
  `AGENTS.md` byte ceiling raise 12,000 -> 20,000 across the Character Limit and
  Validation sections, `scripts/check-md-policy.mjs`, and the routine prompt.
- Clarity reviewer: pass
- Role and context reviewer: pass
- Structure reviewer: pass
- Example reviewer: pass
- Negative-constraint reviewer: pass
- Reasoning and decomposition reviewer: pass
- Output-format reviewer: pass
- Iteration and adversarial reviewer: pass
- Concerns: Each perspective examined the final additions.
  First pass — the Iteration and adversarial reviewer and the
  Negative-constraint reviewer flagged that the `claude-routine-verdict` status
  is posted by the owner-account automation, so the report that satisfies the
  gate and the actor that issues it are the same automation; making that status
  the sole merge gate reduces independent human oversight relative to a named
  human approval step. The Role and context reviewer flagged that the routine
  report templates in `claude-routine-prompt.md` and `claude-routines-cicd.md`
  listed a `GitHub governance` check line with no matching check definition, so
  the gate would emit a verdict for an undefined check. The Clarity reviewer
  flagged that the `AGENTS.md` contradiction-checker fallback named a
  degraded-confidence flag with no concrete destination for a local commit path.
  The Structure reviewer flagged the plan-gating passage in
  `claude-routines-cicd.md` reading thin once server-side enforcement is
  unavailable, and the Output-format reviewer flagged that the
  `eight-perspective-review.md` adversarial checklist tested for an owner-
  escalation step that the consensus rule no longer defines.
  On the final additions: (1) Scope coherence — the Clarity and Example
  reviewers asked how a reviewer distinguishes a genuinely multi-concern PR from
  noise; the Output-format reviewer required the escape hatch be a concrete,
  parseable artifact rather than reviewer judgment. (2) Project Board currency —
  the Iteration and adversarial and Role and context reviewers flagged the check
  as the only one depending on an external system (GitHub Project #3 via MCP or
  `gh`): MCP tooling may be absent in a headless or cron run, the board state is
  itself untrusted mutable input that could be stale or wrong, and a hard failure
  on an unreachable board would block otherwise-valid PRs. The Negative-constraint
  reviewer required that unreachable infrastructure not be laundered into a policy
  `fail`. (3) Automatable-only preamble — the Clarity and Reasoning reviewers
  flagged that without an explicit rule a reviewer might mark a check `blocked` to
  avoid a hard policy call, or emit a bare `fail` with no author-actionable gap.
  (4) PROJECT BOARD LAW restoration — the Structure and Negative-constraint
  reviewers flagged that re-adding a canonical law by owner direction must place
  it verbatim from its source and fix its position so it cannot silently regress
  again, and must not paraphrase or reorder the DEFINITIONS/DIRECTIVES it
  governs. (5) Byte ceiling raise — the Reasoning and Output-format reviewers
  flagged that the 12,000 -> 20,000 change must move together in every location
  (`AGENTS.md` Character Limit and Validation prose, the checker constant, and
  the routine prompt's Character-limits check) or the gate would contradict the
  policy it enforces; the raise is justified only as the minimum needed to hold
  the Law verbatim, not as license to grow `AGENTS.md` unboundedly.
- Revisions made: Removed the `GitHub governance` line from both report
  templates so the report list matches the defined checks exactly. Added the
  affirmative single-gate statement to `claude-routines-cicd.md` Enforcement —
  the `claude-routine-verdict` status for the current head SHA is the merge gate
  and merge proceeds only on success — and reworked the plan-gating passage so
  that where GitHub-side enforcement is unavailable the verdict status remains
  the gate and a maintainer confirms it green before merge, which coheres with
  the manual maintainer gate in `git-collaboration.md` #37 and the mandatory
  manual merge gate in `docs/CONTRIBUTING.md`. Set the contradiction-checker
  fallback in `AGENTS.md` to record the degraded-confidence continuation as a
  "Validation Notes" entry in the commit or PR description, with `blocked` and
  `needs_user` verdicts always stopping writes. Aligned the
  `eight-perspective-review.md` adversarial question with the consensus rule so
  a residual concern sets the review to fail, enumerates the open perspective
  concerns, and routes the amend back to the PR diff.
  For the final additions: (1) Added the Scope-coherence check requiring the
  changed files to serve one coherent intent, with the escape hatch defined as a
  present, specific `Scope exception:` line in the PR body naming the combined
  concerns and the reason — a parseable artifact, not reviewer discretion. (2)
  Added the Project Board currency check that enforces the PROJECT BOARD LAW (the
  first section of `AGENTS.md`) against the change set via the GitHub MCP tools or
  `gh` CLI, verifying file->issue/epic mapping on Project #3, required Law 4
  fields with status matching actual state, Law 5 PR->issue mapping, and no
  pre-work status left stale, failing with an enumerated list of missing, stale,
  or under-populated items. The external-dependency concern is bounded by the
  automatable-only preamble: if the MCP tools or `gh` are unavailable the check
  is `blocked` (infrastructure), never a policy `fail`; board state is treated as
  untrusted input verified against the diff, not trusted blindly; and a blocked
  board leaves the verdict short of pass so the PR is held rather than wrongly
  failed. This tradeoff — a canonical law enforced through mutable external state —
  is an owner-accepted design decision recorded here. (3) Added the
  automatable-only preamble stating every check is decided solely from repository
  contents, the checked-out diff, and PR metadata; `blocked` is reserved for
  infrastructure failures (checkout mismatch, API unavailability) and policy
  findings always use `fail` with enumerated gaps the author can act on. (4)
  Restored the PROJECT BOARD LAW as the first section of `AGENTS.md`, copied
  verbatim from its canonical source and fixed as the never-moved opening section
  per owner-directed emergency restoration of the regressed law. (5) Raised the
  `AGENTS.md` byte ceiling 12,000 -> 20,000 in lockstep across the Character Limit
  section, the Validation section prose, the `scripts/check-md-policy.mjs` limit
  constant, and the routine prompt's Character-limits check, as the minimum
  needed to hold the Law verbatim while keeping the non-`AGENTS.md` limit at
  24,000. The reduced-human-oversight tradeoff is an owner-accepted design
  decision recorded here; it is bounded because the verdict fails closed (a
  missing, malformed, or stale report leaves the status unset and holds the PR
  back from merge), the routine executes no untrusted PR code, and a maintainer
  confirms the green verdict for the head SHA on plan-gated repositories where
  server-side enforcement is unavailable.
- Consensus: pass
