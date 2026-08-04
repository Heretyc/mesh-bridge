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
- The verdict bridge trusts owner-authored report comments, and the routine
  itself posts as the owner account. The verdict status is therefore a
  mechanical floor, not an independent approval: it blocks merges that lack a
  passing report, but it cannot prove the report is trustworthy. A routine
  manipulated through untrusted PR content could still post `Status: pass`, so
  the human-review requirement below stays normative and the merge decision
  stays with the owner.
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

## Project Board Law callback and exceptions (owner-approved)

- **Action -> Routine callback.** Configure the Routine to receive the completed
  Action inspection callback (Action completes -> Routine fires). Do not
  configure the Routine to poll Actions. Wire it only from already-authorized,
  available Routine configuration: the governed Project URL comes from the
  `PROJECT_BOARD_PROJECT_URL` repository variable, and any bearer credential
  lives only in the `project-board-law` protected environment secret. Never
  invent, print, or commit a token or trigger value. Give the Routine repository
  read access and let it call `hr`; retain human-only control of `Approved`.
  Remove or narrow a duplicate dispatcher only if policy proves it required.
- **Fail-closed verification prerequisites (mandatory, not asserted).** Before
  any token-bearing run or callback is trusted, each control below must be
  actively verified; if verification cannot be performed or fails, the run/config
  is blocked (fail closed) and the token is treated as unprotected. Do not assert
  these as facts:
  1. The `project-board-law` **environment exists** (a missing environment is
     created on first use with no protection rules — an open door, not a
     failure).
  2. `PROJECT_CI_TOKEN` is stored **in the environment**, and **no repository
     secret of the same name exists** (a repo-level copy silently removes the
     protection; delete it).
  3. The environment's **deployment branches are restricted to the default
     branch only**; confirm no `refs/pull/*/merge` or other branch policy is
     present.
  4. Optional but recommended: required reviewers and "Prevent self-review" are
     enabled on the environment.
  Record the verification outcome (pass/blocked) per run; never rely on
  configuration being correct without checking it.
- **Least privilege (concrete).** Credential type: a classic PAT (or dedicated
  machine-account PAT) used **only** as `PROJECT_CI_TOKEN`. Minimum scope for the
  read-only `inspect` use is `read:project` (read-only Projects access), **not**
  the write-capable `project` scope. Grant **no** repository write scope for
  inspection; add a repository scope only if a specific endpoint demonstrably
  requires it, at the minimum documented scope — reading issues on a **private**
  repository needs classic `repo` (the narrowest classic scope that reads private
  issues), while public-repository issue reads need no repository scope.
  `public_repo`/`repo` grant write and are not required for read-only inspection;
  never an Anthropic API key. Permitted use: a single read-only manager `inspect`
  execution step against the GitHub GraphQL/REST Projects and issues endpoints
  for the one governed repository and Project — no write-capable subcommand (such
  as `hr`) runs under this token in the read-only `live-board` job; the token is
  mapped **solely** to that inspect step and any run that cannot honor that
  mapping fails closed; not exposed to checkout, setup, artifact upload/download,
  caches, or PR inputs. The callback/verdict `GITHUB_TOKEN` uses job-scoped
  `statuses: write` (plus `pull-requests: read` only on the separate verdict
  bridge, never on this `live-board` inspect job) and nothing more.
- **Committed-only runtime provenance (exception).** The vendored
  `.agents/project-board-law/**` runtime is tracked in source control rather than
  fetched at run time; its printed SHA-256 is its only identity. The `.gitignore`
  tracks that runtime and the env example while keeping `project-ci.env` and the
  generated `journal.ndjson` ignored.
- **Hardened `pull_request_target` precondition (exception).** The token-bearing
  `live-board` job runs under `pull_request_target` and must satisfy every clause
  below; any clause that cannot be met blocks the job (fail closed):
  1. **Read-only checkout permission.** The workflow default is
     `permissions: contents: read`; the `live-board` job adds only the job-scoped
     `statuses: write` it needs to publish its status. It declares **no**
     `pull-requests: read` (that permission is justified solely on the separate
     verdict bridge, not here) and no other write permission.
  2. **Exact base-SHA checkout, no credentials.** If it checks out at all, it
     checks out only the immutable `github.event.pull_request.base.sha` with
     `actions/checkout` set to `persist-credentials: false`. Because the job
     declares `environment: project-board-law`, `PROJECT_CI_TOKEN` is in fact
     available to the whole job, so the protection is **not** that the secret is
     unavailable at checkout — it is that the broad token is never mapped into
     `env:`, `with:`, or git config anywhere except the single manager inspection
     step, and the checkout step runs with no token in its environment. It never
     checks out the PR head, merge ref, `refs/pull/*/merge`, artifacts, caches,
     or inputs.
  3. **No PR-controlled fields reach code or the callback.** Attacker-controlled
     `pull_request` fields — title, body, branch/head ref name, label names,
     author/login, comments — must never be interpolated into shell commands,
     into action `with:` parameters, into `env:`, or into any callback/verdict
     payload. Pass only fixed literals and the vetted base SHA; treat all event
     fields as untrusted data, never as expression or command input.
     **Target-SHA exception.** The one PR-derived value the job may consume is the
     head SHA used as the commit-status target, and only after it is validated
     against `^[0-9a-f]{40}$`. Even then it is allowed solely as the status API
     target argument — never as shell text, an action input, `env:` data, a
     cache/artifact key or input, or callback content.
  4. **Single token step, fixed status.** `PROJECT_CI_TOKEN` is exposed to one
     `inspect` step from the default-branch-restricted `project-board-law`
     environment, and the job publishes only the fixed
     `project-board-law/live-board` status via a job-scoped `statuses: write`
     `GITHUB_TOKEN` — never the PAT.
