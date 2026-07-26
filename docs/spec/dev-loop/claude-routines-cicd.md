# Claude Routines CI/CD

Status: normative CI/CD mapping for this repository.

## Canonical Path

Claude Code Routines are the canonical CI/CD path for this repository. GitHub
Actions exists only as the GitHub-standard dispatch bridge and signal that a
routine was started. The dispatch workflow file is
`.github/workflows/claude-routine.yml`. A second bridge,
`.github/workflows/claude-routine-verdict.yml`, translates the routine's PR
report comment into the `claude-routine-verdict` commit status so the verdict
itself is machine-enforceable.

Routines are research-preview infrastructure. If Anthropic changes routine API,
trigger behavior, limits, or completion reporting, stop and update this SOP
before changing workflow behavior.

## Prompt And Setup

Paste the exact contents of `docs/spec/dev-loop/claude-routine-prompt.md` into
the Claude routine Instructions field. That file contains no setup commentary,
citations, or wrapper text.

## Required Setup

1. Create a Claude Code routine at `claude.ai/code/routines`.
2. Select this repository and a scoped Claude Code cloud environment.
3. Configure the routine Instructions field from
   `docs/spec/dev-loop/claude-routine-prompt.md`.
4. Add an API trigger to the routine.
5. Store the API trigger URL in GitHub Actions secret
   `CLAUDE_ROUTINE_FIRE_URL`.
6. Store the API trigger bearer token in GitHub Actions secret
   `CLAUDE_ROUTINE_FIRE_TOKEN`.
7. Install the Claude GitHub App for GitHub-event routines when direct webhook
   triggers are used.
8. Keep routine repository branch pushes disabled for CI/CD routines. If a
   future implementation routine must push code, use Claude's default
   `claude/`-prefixed branch restriction as a documented tool exception, or get
   owner approval before enabling broader branch pushes.

## Workflow Contract

`.github/workflows/claude-routine.yml` must:

- trigger on `pull_request`, `workflow_dispatch`, `merge_group`, and push events
  with the dispatch job limited to the repository default branch unless owner
  policy adds more protected branches
- use least-privilege `GITHUB_TOKEN` permissions
- avoid checkout and avoid executing untrusted PR code
- send only bounded event metadata to the routine API
- prepend `<You are the primary agent in an automated workflow>` to the routine
  API text body
- send workflow SHA, target SHA, PR head/base SHA, and merge-group metadata
- fail if the routine cannot be dispatched
- report the returned Claude Code session URL in the workflow summary
- not claim that routine completion succeeded merely because dispatch succeeded
- mark all GitHub event fields as untrusted metadata for the routine

`.github/workflows/claude-routine-verdict.yml` must:

- trigger only on `issue_comment` (created, edited) and run only for PR
  comments whose author association is `OWNER`
- use least-privilege `GITHUB_TOKEN` permissions (`statuses: write`,
  `pull-requests: read`) with no checkout and no execution of untrusted code
- parse the comment body as data only: require the `## Claude Routine CI/CD`
  header plus parseable `Status:` and `Target SHA:` lines, else do nothing
- post the `claude-routine-verdict` commit status on the PR head SHA only when
  the report's target SHA matches the current head SHA (`pass` maps to
  `success`; `fail` and `blocked` map to `failure`)
- fail closed: a missing, malformed, or stale report leaves the verdict status
  unset, which keeps the PR blocked while the context is required

## Routine Report Format

The routine must post or preserve a report of this shape. It is an illustrative
template, not a byte-identical spec: the canonical field text lives in
`docs/spec/dev-loop/claude-routine-prompt.md`, and context-specific wording (for
example the `### Findings` and `### Validation Notes` labels) may differ between
that copy/paste Instructions field and this SOP so long as the Status, Checks,
Findings, and Validation Notes sections stay present and compatible:

```markdown
## Claude Routine CI/CD

Status: pass|fail|blocked
Session: <Claude session URL>
Trigger: <event/ref/sha>
Target SHA: <sha checked out for validation>

### Checks
- Character limits: pass|fail|blocked
- JSON syntax: pass|fail|blocked
- Python syntax: pass|fail|blocked
- Branch and PR policy: pass|fail|blocked
- GitHub governance: pass|fail|blocked
- Claude CI/CD mapping: pass|fail|blocked
- Security: pass|fail|blocked
- Attribution: pass|fail|blocked
- Artifact hygiene: pass|fail|blocked
- 8-perspective directive/SOP gate: pass|fail|blocked|not-applicable

### Findings
- <file or PR field>: <problem and required fix>

### Validation Notes
- <commands, limitations, skipped checks, or routine API limitations>
```

## Enforcement

- Branch protection or rulesets should require `claude-routine-dispatch` and
  `claude-routine-verdict` only on GitHub plans where private-repository
  protections are actually enforced.
- On private repositories where GitHub shows a plan-gating warning, do not treat
  rulesets or branch protection as enforceable. Maintainers must manually block
  merges unless this SOP's routine-report gate passes.
- The `claude-routine-dispatch` check proves that GitHub successfully fired the
  routine. It does not prove that the routine completed successfully. The
  `claude-routine-verdict` status proves the routine's latest report for the
  current head SHA carries `Status: pass`.
- No PR may merge unless the latest Claude Routine report for the current head
  SHA has `Status: pass`, or the owner explicitly approves an emergency override
  that names the risk and accepted bypass.
- Human review must inspect the routine session URL or PR comment before merge
  until Anthropic exposes a blocking completion status for routines.
- If the routine API, token, quota, or webhook delivery fails, the PR does not
  merge.
- If direct GitHub-event routines are enabled in Claude, keep the workflow
  bridge anyway so GitHub has a required status check.
- The verdict status is posted per PR head SHA. If a merge queue is enabled,
  merge-group SHAs will not carry it; extend the verdict bridge before making
  it required for merge groups.
- Fork and Dependabot `pull_request` runs do not receive normal repository
  secrets. They fail closed unless a maintainer moves the change to a trusted
  branch, performs a trusted `workflow_dispatch`, or uses an owner-approved
  metadata-only GitHub App/routine trigger.

## Security

- Routine API tokens are per-routine bearer tokens and must stay in GitHub
  Actions secrets.
- Do not use an Anthropic API key for routine firing.
- Do not put secrets in workflow YAML, prompts, PR bodies, comments, or docs.
- Limit routine environment variables, network access, connectors, and branch
  permissions to what the routine needs.
- Remember that routines run autonomously without approval prompts during a run.
