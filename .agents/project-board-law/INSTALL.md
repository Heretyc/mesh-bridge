# Project Board Law installation and operations

The manager targets Node.js 24 LTS and whichever GitHub Project you name at invocation.
Every command takes a canonical `--project` URL, either
`https://github.com/users/OWNER/projects/NUMBER` (user-owned) or
`https://github.com/orgs/OWNER/projects/NUMBER` (organization-owned); the owner segment
tells the manager which GitHub owner to query, so the same vendored runtime installs into
any repository and any reachable Project. Runtime uses Node's standard-library `https`
client; `gh` is only the copy-paste setup wizard. Commands are non-interactive, apply
writes by default, and accept `--dry-run`.

## Artifact layout

Development source:

```text
PROJECT-BOARD-LAW.md
AGENTS.md
INSTALL.md
package.json
package-lock.json
tsconfig.json
src/manager.ts
src/payload.generated.ts
scripts/generate-payload.mjs
scripts/verify-build.mjs
test/manager.test.mjs
.agents/project-ci.env.example
.agents/project-board-law/adapters/{claude,codex,copilot}.md
.github/workflows/{ci,project-board-law}.yml
dist/{manager,payload.generated}.js
```

Every governed repository receives this complete runtime layout:

```text
PROJECT-BOARD-LAW.md
AGENTS.md                                      # exact managed block at byte zero
.agents/project-ci.env.example
.agents/project-ci.env                         # local only; gitignored
.agents/project-board-law/INSTALL.md
.agents/project-board-law/manager.js
.agents/project-board-law/payload.generated.js
.agents/project-board-law/package.json
.agents/project-board-law/adapters/{claude,codex,copilot}.md
.agents/project-board-law/journal.ndjson        # generated; gitignored
.github/workflows/project-board-law.yml
.gitignore
```

The installer copies its own compiled runtime and embedded payload. The law payload has
no version alias: its printed SHA-256 is its only identity.

## Prerequisites

- Node.js 24 LTS.
- Repository admin/write access and write access to the governed Project.
- A user OAuth token or classic PAT with `project` and repository issue scope. For a
  private repository use `repo`; for public-only repositories `public_repo` is enough.
  The same scopes cover user-owned and organization-owned Projects; for an organization
  with SAML SSO, authorize the token for that organization.
- `gh` for this setup recipe only. CI and manager runtime do not need it.

GitHub's `GITHUB_TOKEN` has no user-Project permission and cannot replace
`PROJECT_CI_TOKEN`.

## Copy-paste wizard: existing repository

Set values first; no executable prompt asks questions.

PowerShell:

```powershell
$RepoSlug = 'OWNER/REPO'
$RepoUrl = "https://github.com/$RepoSlug"
# User-owned Project: https://github.com/users/PROJECT_OWNER/projects/NUMBER
# Organization-owned Project: https://github.com/orgs/PROJECT_OWNER/projects/NUMBER
$ProjectUrl = 'https://github.com/users/PROJECT_OWNER/projects/NUMBER'
$Manager = 'C:\verified\project-board-law\dist\manager.js'
$Milestone = 'Project governance'
$IterationStart = '2026-07-27'
$IterationDays = '14'

gh auth login --scopes 'repo,project'
gh auth refresh -s repo -s project
gh auth status
$env:PROJECT_CI_TOKEN = gh auth token

node $Manager install --repo $RepoUrl --project $ProjectUrl `
  --milestone $Milestone --true-up-milestone $Milestone `
  --iteration-start $IterationStart --iteration-days $IterationDays --dry-run
node $Manager install --repo $RepoUrl --project $ProjectUrl `
  --milestone $Milestone --true-up-milestone $Milestone `
  --iteration-start $IterationStart --iteration-days $IterationDays

# The token lives in a branch-restricted environment, never as a repository
# secret; see "CI secret exposure" below for why this is required. Restrict the
# environment to the DEFAULT BRANCH ONLY: schedule, push, dispatch, and the
# base-controlled pull_request_target live-board job all run default-branch code.
# Never admit `refs/pull/*/merge`; pull-request content must not reach the token.
$DefaultBranch = gh repo view $RepoSlug --json defaultBranchRef --jq '.defaultBranchRef.name'
'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' |
  gh api -X PUT "repos/$RepoSlug/environments/project-board-law" --input -
gh api -X POST "repos/$RepoSlug/environments/project-board-law/deployment-branch-policies" `
  -f name=$DefaultBranch
gh auth token | gh secret set PROJECT_CI_TOKEN --repo $RepoSlug --env project-board-law
gh secret delete PROJECT_CI_TOKEN --repo $RepoSlug   # only if one already exists

gh variable set PROJECT_BOARD_PROJECT_URL --repo $RepoSlug --body $ProjectUrl
gh variable set PROJECT_BOARD_WRITES --repo $RepoSlug --body 'false'
gh variable set PROJECT_BOARD_TRUE_UP_MILESTONE --repo $RepoSlug --body $Milestone
node .agents/project-board-law/manager.js inspect --repo $RepoUrl --project $ProjectUrl
```

POSIX shell:

```sh
repo_slug='OWNER/REPO'
repo_url="https://github.com/$repo_slug"
# User-owned Project: https://github.com/users/PROJECT_OWNER/projects/NUMBER
# Organization-owned Project: https://github.com/orgs/PROJECT_OWNER/projects/NUMBER
project_url='https://github.com/users/PROJECT_OWNER/projects/NUMBER'
manager='/verified/project-board-law/dist/manager.js'
milestone='Project governance'
iteration_start='2026-07-27'
iteration_days='14'

gh auth login --scopes 'repo,project'
gh auth refresh -s repo -s project
gh auth status
export PROJECT_CI_TOKEN="$(gh auth token)"

node "$manager" install --repo "$repo_url" --project "$project_url" \
  --milestone "$milestone" --true-up-milestone "$milestone" \
  --iteration-start "$iteration_start" --iteration-days "$iteration_days" --dry-run
node "$manager" install --repo "$repo_url" --project "$project_url" \
  --milestone "$milestone" --true-up-milestone "$milestone" \
  --iteration-start "$iteration_start" --iteration-days "$iteration_days"

# The token lives in a branch-restricted environment, never as a repository
# secret; see "CI secret exposure" below for why this is required. Restrict the
# environment to the DEFAULT BRANCH ONLY: schedule, push, dispatch, and the
# base-controlled pull_request_target live-board job all run default-branch code.
# Never admit refs/pull/*/merge; pull-request content must not reach the token.
default_branch="$(gh repo view "$repo_slug" --json defaultBranchRef --jq '.defaultBranchRef.name')"
printf '%s' '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' |
  gh api -X PUT "repos/$repo_slug/environments/project-board-law" --input -
gh api -X POST "repos/$repo_slug/environments/project-board-law/deployment-branch-policies" \
  -f name="$default_branch"
gh auth token | gh secret set PROJECT_CI_TOKEN --repo "$repo_slug" --env project-board-law
gh secret delete PROJECT_CI_TOKEN --repo "$repo_slug"   # only if one already exists

gh variable set PROJECT_BOARD_PROJECT_URL --repo "$repo_slug" --body "$project_url"
gh variable set PROJECT_BOARD_WRITES --repo "$repo_slug" --body false
gh variable set PROJECT_BOARD_TRUE_UP_MILESTONE --repo "$repo_slug" --body "$milestone"
node .agents/project-board-law/manager.js inspect --repo "$repo_url" --project "$project_url"
```

`--iteration-start` and `--iteration-days` are used only if the Project lacks an
Iteration field; an existing configuration is preserved. Repeat `--milestone` and use
`NAME=YYYY-MM-DD` when a due date is explicitly known. A bare name creates no date.

When an upgrade dry-run reports a stale open true-up body, inspect that exact issue and,
after item-specific approval, rerun both dry-run and apply with:

```text
--replace-true-up-body REPLACE-TRUE-UP-BODY:ISSUE_NUMBER
```

The number must match the sole open numbered true-up. The manager rejects absent,
repeated, wrong, or ambiguous confirmation before any write. Dry-run shows the exact
body-only patch; apply fresh-checks the issue identity, `updated_at`, and body, replaces
and verifies only that body, then continues installation. It does not change the title,
state, milestone, comments, or Project status.

To make the local token file, copy `.agents/project-ci.env.example` to
`.agents/project-ci.env`, then place `PROJECT_CI_TOKEN=<token>` there. The installer adds
that path to `.gitignore`; process environment takes precedence. Never commit the file.

## New repository

Create and clone the repository, enter its root, then run the existing-repository wizard:

```sh
gh repo create OWNER/REPO --private --clone
cd REPO
```

The install command links the repository to the named Project, creates only missing schema and
milestones, installs the complete vendored payload, and creates the missing next true-up.
It preserves unrelated Project fields/options and repository files. A same-name field of
the wrong type fails safely.

## Schema and command recipes

Required custom schema is `Status` (`In Review`, `Approved`), `Priority` (`P0`–`P3`),
`Size` (`XS`–`XL`), `Estimate` (number), and `Iteration`. Native milestone, assignee,
label, sub-issue, dependency, and linked-PR relations remain native.

When creating the Project Board Law installation issue, suggested starting values are
Status `In Review`, Priority `P0`, Size `M`, Estimate `5`, the current explicitly
available Iteration, and the explicitly supplied installation milestone. These
recommendations require explicit operator confirmation; the manager does not apply them
as silent defaults.

```sh
# Read-only inventory and compliance report
node .agents/project-board-law/manager.js inspect --repo "$repo_url" --project "$project_url"

# Add missing deterministic schema/options and report item violations
node .agents/project-board-law/manager.js reconcile --repo "$repo_url" --project "$project_url"

# Create a fully reconciled issue and Project item
node .agents/project-board-law/manager.js item --repo "$repo_url" --project "$project_url" \
  --title 'Ship change' --body 'Tracked work' --milestone 'Release 1' \
  --priority P1 --size M --estimate 3 --iteration 'Iteration 4' --status 'In Review'

# Existing issue status; the CLI refuses --value Approved
node .agents/project-board-law/manager.js status --repo "$repo_url" --project "$project_url" \
  --issue 42 --value 'In Review'

# HR stays on the affected issue
node .agents/project-board-law/manager.js hr --repo "$repo_url" --project "$project_url" \
  --issue 42 --mode decision --request 'Choose A or B; A is smaller, B is more flexible.'

# Add/update only an explicitly supplied milestone date
node .agents/project-board-law/manager.js milestone --repo "$repo_url" --project "$project_url" \
  --name 'Release 1' --due 2026-09-30

# Audit/advance the true-up only after a human sets its Status to Approved
node .agents/project-board-law/manager.js true-up --repo "$repo_url" --project "$project_url" \
  --milestone 'Project governance'
```

Archive confirmation is `ARCHIVE:<issue-number>`, permanent Project-item deletion is
`DELETE:<issue-number>`, and clearing an approval is `RESET-APPROVAL:<issue-number>`.
These confirmations are item-specific and cannot be supplied globally.

## Permissions, workflow, and adapters

The installed workflow sets a default `permissions: contents: read`; only the
base-controlled `live-board` job additionally takes a job-scoped `statuses: write` to
publish the fixed `project-board-law/live-board` check. The exact required checks are
`Project Board Law / identity` and `project-board-law/live-board`; full compliance is
their conjunction. The former `project-board-law/pre-merge` context is migration-only
and should be removed from required checks after the pair is active. Every
`PROJECT_CI_TOKEN` reference is scoped to the manager execution step, so checkout,
setup, and artifact upload never receive the PAT. The workflow reads the governed Project URL from the
`PROJECT_BOARD_PROJECT_URL` repository variable, so each repository points at its own
Project and no target is baked into the runtime; an unset or malformed value fails closed
with `bad-project` before any write is planned. Keep `PROJECT_BOARD_WRITES=false` until
true-up writes are explicitly authorized: that variable must be `true` for both the
scheduled true-up and a `workflow_dispatch` true-up. `workflow_dispatch` can run an opt-in
read-only smoke or one authorized true-up. Journals are uploaded even after failure.

### CI secret exposure

`PROJECT_CI_TOKEN` is a classic PAT carrying `project` plus `repo` or `public_repo`, so
it reaches every repository and Project its owner can access. Treat it as a
broadly-scoped credential, not a repository-local one.

The workflow must never hand that token to code an untrusted account controls. Two
distinct paths would do so, and both are closed:

- **Pull requests.** A `pull_request` run checks out the pull-request head, which the
  author controls, so it receives **no** secret regardless of whether the pull request
  comes from a fork or a same-repository branch: it runs only the token-free local
  byte-identity check. Full compliance also requires the base-controlled `live-board`
  job, which runs on `pull_request_target`. That event executes the workflow and the code
  it checks out from the **base** branch, not the pull request, so it may safely hold the
  token — as long as it never checks out or executes pull-request content, artifacts,
  caches, or inputs. The `live-board` job checks out only the immutable
  `github.event.pull_request.base.sha`, exposes the PAT to a single inspect step, and
  publishes exactly one fixed status context, `project-board-law/live-board`, using a
  job-scoped `statuses: write` `GITHUB_TOKEN` — never the PAT. Require that status in
  branch protection so an unlinked pull request or a governance regression blocks the
  merge. **Portable-spoofing caveat:** any account that can push a branch can also POST a
  commit status through the REST API, so this published status is advisory against a
  determined insider; pair it with branch protection and review.
- **Manual dispatch.** Running a workflow manually requires only write access, and the
  person triggering it chooses the ref, so `workflow_dispatch` from an attacker's branch
  would run that branch's manager with the token. Event conditions cannot prevent this.
  Every token-bearing job therefore declares `environment: project-board-law`, because
  environment secrets reach only jobs using that environment and only after its
  protection rules pass.

That second defense depends entirely on how the environment is configured, and it fails
silently if it is wrong:

1. Store `PROJECT_CI_TOKEN` **in the environment**, not as a repository secret. A
   repository secret of the same name resolves in these jobs regardless of the
   environment and quietly removes the protection. The wizard above deletes any
   repository-level copy for this reason.
2. Restrict the environment's deployment branches to the **default branch only**. That
   single policy is what rejects a dispatch from an arbitrary branch and binds the token
   to trusted code. Schedule, push, dispatch, and the `pull_request_target` `live-board`
   job all run default-branch code, so no other policy is needed. **Never** add
   `refs/pull/*/merge` or any pull-request ref: pull-request content must never claim the
   environment or the token.
3. An environment that does not exist yet is created on first use **with no protection
   rules**, so a missing environment is an open door rather than a failure. Confirm it
   exists under **Settings → Environments** before relying on it.
4. Optionally add required reviewers to the environment so token-bearing runs also need a
   human approval, and enable **Prevent self-review**.

Layer on as much of the following as your threat model warrants:

1. Use a dedicated machine account whose access is limited to the governed repository and
   Project, so an exposed token cannot reach unrelated repositories.
2. Restrict who can push branches, and require review on the paths that carry executable
   governance (`.agents/project-board-law/**`, `.github/workflows/**`) via a CODEOWNERS
   rule, so a manager change cannot merge unreviewed.
3. Omit the Actions secret entirely and run every token-bearing command locally from a
   trusted checkout. CI then verifies only local byte identity, and the board is
   reconciled by a human on demand. This is the strongest option and costs only the
   scheduled true-up.
4. Rotate the token on a schedule and immediately if a branch-pushing account is
   compromised; revoking the PAT in GitHub settings is the kill switch.

Third-party actions are pinned to full commit SHAs rather than mutable tags, so a
retagged or compromised release cannot execute beside the token. Update those pins
deliberately, and re-pin to a SHA you verified.

Claude, Codex, and Copilot adapter files are documentation, not alternate executables.
For Claude automation, configure a Routine to receive the completed Action inspection
callback (Action → Routine). Do not configure the Routine to poll Actions. Give the
Routine repository read access and let it call `hr`; retain human-only control of
`Approved`.

## Web-only or UI alternatives

The manager and `gh` automate every supported API step. These account-level actions may
require GitHub web UI:

1. Create a classic PAT: avatar → **Settings** → **Developer settings** → **Personal
   access tokens** → **Tokens (classic)** → **Generate new token (classic)** → select
   `repo` and `project` → **Generate token**. Copy it once into the local env file and the
   Actions secret; never paste it into an issue or log.
2. Verify Project access: open the governed Project → **…** → **Settings** → **Manage
   access** → add the repository owner/collaborator if the API reports no write access.
   For an organization-owned Project, an organization owner may have to grant this and
   authorize the token for SAML SSO.
3. Enable Actions if disabled: repository → **Settings** → **Actions** → **General** →
   choose the allowed-actions policy → **Save**.
4. Require both exact compliance checks: repository → **Settings** → **Branches**
   → add/edit protection rule → enable required status checks → require
   `Project Board Law / identity` and `project-board-law/live-board` → **Save changes**.
   Full compliance is their conjunction. Remove the old `project-board-law/pre-merge`
   requirement only after both replacements are active; it is migration-only.
5. Human approval: open the governed Project → find the affected item → set `Status` to exact
   `Approved`. There is intentionally no manager command or secret that performs this.

No screenshots are required. Project field, item, milestone, dependency, and sub-issue
operations are API-supported and therefore are not labeled UI-only.

## Verification

From this source distribution:

```sh
npm ci
npm run check
```

That command typechecks with TypeScript 7, builds vendored JavaScript, runs `node:test`
mock integrations, validates both workflows and adapters, and checks SHA-256/byte identity
among every payload, the generated payload, compiled manager, static runtime package, and
root `AGENTS.md` block. Build order is compile, generate expectations from the current
compiled manager, compile again, then verify stable generation and byte identity. These
checks prove internal consistency, not an external trust root: coordinated replacement
of all expectations can still agree with itself. CI repeats the check on Windows, macOS,
and Ubuntu with Node 24. The optional live Project smoke is read-only and reads the
Project named by the `PROJECT_BOARD_PROJECT_URL` repository variable.

In a governed repository, run `inspect` and confirm `compliant: true`, then use
**Actions** → **Project Board Law** → **Run workflow** with live smoke enabled. Never use
the write input merely to test connectivity.

## Upgrade and rollback

Upgrade with a verified newer `dist/manager.js`: run its `install ... --dry-run`, save the
plan and SHA-256, then run the same command without `--dry-run`. If the dry-run requires
the item-specific true-up body migration above, add the exact same confirmation to both
commands. The confirmed replacement completes and verifies before managed files or
unrelated remote resources change. Managed files and the top AGENTS block then update;
unrelated content and extra Project schema remain untouched.

Before upgrade, commit or otherwise back up the governed repository. Roll back local
artifacts with source control, for example:

```sh
git restore PROJECT-BOARD-LAW.md AGENTS.md .agents/project-board-law \
  .agents/project-ci.env.example .github/workflows/project-board-law.yml .gitignore
```

Remote schema changes are additive and intentionally not auto-removed on rollback.
Removing fields/options would be destructive; review them in Project settings and remove
only with separate human authorization. Milestones likewise remain.

## Troubleshooting

- `missing PROJECT_CI_TOKEN`: export it or create `.agents/project-ci.env`.
- `bad-project`: pass the full canonical Project URL, either
  `https://github.com/users/OWNER/projects/NUMBER` or
  `https://github.com/orgs/OWNER/projects/NUMBER`, with no trailing slash or view suffix;
  in CI, set the `PROJECT_BOARD_PROJECT_URL` repository variable.
- `no-project` on an organization Project: confirm the URL uses `/orgs/`, that the token
  account can see the Project, and that SAML SSO authorization is granted.
- `unverifiable scopes`: use a user OAuth/classic PAT; refresh `repo,project`; fine-grained
  token scope headers do not satisfy this verifier.
- `project scope missing`: run `gh auth refresh -s project`, then replace the Actions
  secret from stdin.
- `name/type collision`: rename the unrelated field in Project settings or change it to
  the law's type; the manager will not delete or coerce it.
- `iteration inputs required`: the field is absent; supply explicit UTC start and duration.
- `409/concurrency failure`: re-run `inspect`, resolve the competing item edit, then retry.
- `secondary rate limit`: honor the reported retry time; do not loop the command.
- `Approved is human-only`: set it in the Project UI. To clear it, use the exact
  item-specific reset confirmation.
- byte drift: restore canonical artifacts, then rerun the verified installer; do not
  normalize the managed block to CRLF.
