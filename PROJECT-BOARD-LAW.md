# PROJECT BOARD LAW

This law governs every repository installed into a governed GitHub Project. The governed
Project is named explicitly at every invocation and is the source of truth for planning
and status. Repository premise and specification documents remain the source of truth for
product intent; if they conflict with the Project, stop the affected work, obtain Human
Review, and reconcile the Project to the repository intent.

## 1. Canonical bytes and installation

`PROJECT-BOARD-LAW.md` at the governed repository root is the canonical law. Every
governed repository must vendor the complete manager runtime, workflow, adapters,
installation guide, configuration template, and this file. The manager embeds the law
payload and identifies that payload only by its SHA-256 digest; there is no independent
version label that may override the bytes.

The root `AGENTS.md` must begin with exactly one managed block:

```text
<!-- PROJECT-BOARD-LAW:BEGIN -->
<the exact bytes of PROJECT-BOARD-LAW.md>
<!-- PROJECT-BOARD-LAW:END -->
```

Only the two stable marker lines wrap the payload. Bytes between them, including the
law's final newline, must equal `PROJECT-BOARD-LAW.md` byte-for-byte. Content outside
the block is preserved. A malformed or duplicate block is a hard failure. Build,
install, inspect, reconcile, and CI checks must reject drift among the canonical file,
the manager's embedded payload, and the installed block.

The vendored installation guide `.agents/project-board-law/INSTALL.md` is the sole
installed artifact a governed repository may customize. The manager updates it by a
deterministic, fail-closed three-way merge and never by executing installed target code;
every other vendored artifact stays byte-identical to its embedded payload.

## 2. Manager authority and addressing

The vendored Node.js 24 LTS manager is the sole automation entry point. It is a
zero-runtime-dependency TypeScript CLI whose compiled JavaScript is committed in
`dist/` and vendored into governed repositories. Its subcommands are `inspect`,
`reconcile`, `install`, `item`, `status`, `hr`, `true-up`, and `milestone`.

Every subcommand invocation must receive both a canonical HTTPS repository URL and a
canonical HTTPS Project URL. The Project URL must be exactly
`https://github.com/users/OWNER/projects/NUMBER` for a user-owned Project or
`https://github.com/orgs/OWNER/projects/NUMBER` for an organization-owned Project; the
owner segment of that URL selects the owner the manager queries. No default, inferred,
or remembered target is allowed, and a governed repository may be installed into any
Project its token can reach. The repository URL must identify the repository affected by
the invocation.

Runtime GitHub access is direct REST and GraphQL over the Node standard-library HTTPS
client. Runtime must not require, invoke, or fall back to `gh`. The `gh` CLI is used
only by the documented copy-paste installation wizard for authentication, secret
configuration, and supported setup calls. The manager is non-interactive.

## 3. Authentication and configuration

The token key is `PROJECT_CI_TOKEN`. Process environment wins over
`.agents/project-ci.env`; no other local token store is read. The local file is
gitignored and its tracked example contains no secret. In GitHub Actions the token is an
environment secret bound to the `project-board-law` environment whose deployment branch
policy is the default branch only, so it reaches only trusted default-branch execution;
pull-request content never receives this broadly-scoped PAT. That environment is a
secret-scoping gate, not a deployment: each token-bearing job declares it with
`deployment: false`, which suppresses the Deployments-UI record (verified 2026-08-03)
while leaving the environment's branch protection rules fully enforced. The environment
remains mandatory — it, not `deployment: false`, keeps the token off untrusted refs — and
`inspect` enforces its posture (environment present, one default-branch-only custom policy,
no pull-ref policy, no custom GitHub App deployment protection rule — incompatible with
`deployment: false` — and no copy of any provisioned secret (`PROJECT_CI_TOKEN`,
`CLAUDE_ROUTINE_FIRE_URL`, `CLAUDE_ROUTINE_FIRE_TOKEN`) at repository or organization scope,
failing closed on any scope it cannot read). Tokens,
authorization headers, and secret-bearing values are never printed or journaled.

Use a user OAuth token or classic personal access token whose account can reach the
governed Project, whether that Project is user-owned or organization-owned. Read-only
runs require a verifiable `read:project` or `project` scope. Writes require a verifiable
`project` scope plus repository issue access (`repo`, or `public_repo` for a public-only
repository). The manager verifies reported scopes and actual repository and Project
access before planning mutations; unverifiable or insufficient scopes fail closed.

## 4. Work items and schema

Work is a mutation of git-tracked repository content. Every unit of Work maps to a
repository issue in the Project, and every pull request maps to a Project issue. Project
draft issues do not satisfy this rule.

Before creating any issue for requested Work, an agent must enumerate the existing open
issues and evaluate each for plausible fit against that Work. A plausible fit means the
Work extends an existing issue — recorded as a scope note, comment, or native relation —
and must never become a net-new issue. Ambiguity among two or more candidates requires a
Decision HR listing the candidates. Creation is permitted only on verified absence of any
plausible fit. A mid-task scope change or human redirection re-triggers this evaluation
before any new issue. Wording-level title differences are not evidence of net-new Work.

The manager additively ensures this custom schema:

- `Status`: `SINGLE_SELECT`, containing exact case-sensitive options `In Review` and
  `Approved`.
- `Priority`: `SINGLE_SELECT`, containing `P0`, `P1`, `P2`, and `P3`.
- `Size`: `SINGLE_SELECT`, containing `XS`, `S`, `M`, `L`, and `XL`.
- `Estimate`: `NUMBER`.
- `Iteration`: `ITERATION`.

Missing fields and required options are created silently on authorized write runs.
Existing fields, options, iteration configuration, and unrelated schema are preserved.
A required name with a different data type, duplicate required names, or an option-name
collision is a hard failure. Creating a missing Iteration field requires explicit UTC
start date and duration inputs; the manager never invents an iteration calendar.

Labels, assignees, milestones, linked pull requests, parent/sub-issues, and blocked-by
relationships use GitHub's native issue and Project relations. No text field may
duplicate a native relation. Milestone is required. Other native fields are optional;
an empty optional native value is reported as `N/A`, not written as a sentinel string.

## 5. Lifecycle writes

Writes apply by default. `--dry-run` performs validation and reads, emits the exact plan,
and makes no local or remote mutation. Each applied run writes a secret-free NDJSON
journal containing planned, applied, verified, failed, and blocked states.

Issue creation or reconciliation is one logical operation but cannot be one GitHub API
mutation. The manager therefore performs an ordered transaction-like sequence: verify
the current item snapshot, mutate one step, re-read and verify it, then release dependent
steps. A failed write blocks every dependent step. Each item uses bounded retries and
fresh `updatedAt` snapshots for best-feasible optimistic concurrency. GitHub provides no
atomic multi-resource commit or compare-and-swap for these mutations, so any unresolved
race or unverifiable final state fails closed and is journaled.

Archive and permanent Project-item deletion require explicit, item-specific confirmation.
Resetting an `Approved` item to any other status also requires explicit, item-specific
confirmation. The manager exposes no bulk destructive operation and never deletes an
issue, milestone, Project, field, option, comment, or workflow.

Before install writes locally or remotely, it resolves the open numbered true-up. More
than one is a hard failure. If the sole open true-up body differs byte-for-byte from the
new law, install requires the exact item-specific option
`--replace-true-up-body REPLACE-TRUE-UP-BODY:ISSUE_NUMBER`; absent, repeated, or
mismatched confirmation fails before any mutation. Dry-run includes the body-only patch
in its exact plan. An applied upgrade freshly rechecks the issue identity, `updated_at`,
and body snapshot, patches only its body, re-reads and byte-verifies the new law, and
only then releases local installation and unrelated remote steps. The replacement is
ordered and journaled but not atomic with later install mutations; any concurrent or
unverifiable state fails closed.

Install writes the vendored installation guide `.agents/project-board-law/INSTALL.md` by
a deterministic line-based three-way merge of the prior upstream default, the current
target customization, and the incoming default. The prior default is read as data from
the already-installed generated payload after that payload verifies against its own
manifest digest; installed target code is never imported or executed. Identical or
disjoint line edits merge deterministically; an overlapping incompatible edit, an absent
or unverifiable prior default, or ambiguous newline or encoding fails closed before any
write and is journaled and planned, dropping neither the customization nor an incoming
security or functionality change. Initial install writes the incoming default. Every
other installed artifact is written byte-identically and re-verified.

## 6. Status and Human Review

Status values are case-sensitive. Humans alone set `Approved`; the manager must reject
every attempt to set it, including through generic item or status commands. The manager
trusts an observed `Approved` value and never silently clears it.

Human Review (HR) is requested on the affected work item, never on a dedicated queue
item. The `hr` command posts the complete request as an issue comment and moves the item
to `In Review`. If that would reset `Approved`, the explicit approval-reset confirmation
is required. A headless run may record the request but cannot manufacture approval.
Decision HR gives two or more concrete choices with consequences; Action HR states the
required human action, why it is needed, and the consequence of inaction.

## 7. Milestones

Milestone names and optional due dates are explicit install or `milestone` inputs.
Missing milestones are created additively. Existing milestones and dates are preserved
unless an explicitly supplied date requests an update. A name without a date creates a
dateless milestone. The manager never invents, deletes, or closes milestones. Dates are
validated as `YYYY-MM-DD` and sent as UTC.

## 8. True-ups

Business-day calculations use UTC Monday through Friday and exclude no holidays. The
most recent closed repository issue titled `Project Board true-up #N` is the completion
anchor. A true-up is due when more than five UTC weekdays have elapsed since that issue
closed, or immediately when no completed true-up exists.

The first authorized `true-up` write repairs a missing next true-up by creating
`Project Board true-up #1`; later runs preserve exactly one next open numbered true-up.
Every true-up is a repository issue in the Project, uses an explicitly named milestone,
and has a body byte-identical to this law with no preamble or suffix. A run inspects all
in-scope Project items, records noncompliance on each affected issue by comment, and
requests HR there. It never resets an `Approved` status without confirmation.

A current true-up completes only after a human sets its Project Status to `Approved`.
The manager then verifies the audit, closes that issue, and creates the incremented next
true-up with the exact law body. The manager does not set `Approved` itself.

## 9. CI and agent adapters

The generic GitHub Actions workflow runs on Node.js 24, uses direct API access, and does
not install or require `gh`. Its default continuous check is read-only. A `pull_request`
event runs the token-free `Project Board Law / identity` check on pull-request content.
It verifies every embedded payload except the customizable installation guide against its
installed bytes — the installation guide is verified present, not byte-identical — the
installed compiled manager against its generated SHA-256, the static runtime package
against its generated bytes, and the root `AGENTS.md` block. This is deterministic internal consistency, not an
external trust root: coordinated replacement of the workflow and every embedded
expectation can agree with itself and still requires review.

A separate base-controlled `pull_request_target` job checks out the immutable base commit
— never pull-request content, artifacts, caches, or inputs — inside the
`project-board-law` environment (declared `deployment: false`, a secret-scoping gate that
records no deployment yet still enforces its branch policy); it alone holds
`statuses: write` and uses it solely to
publish the fixed `project-board-law/live-board` status check, never a broad token to
pull-request content. The exact required checks are `Project Board Law / identity` and
`project-board-law/live-board`; full compliance is their conjunction. The former
`project-board-law/pre-merge` context is migration-only and is not compliance evidence.
Because any account that can push a branch can also post a commit status through the
portable API, the live-board status is advisory against a determined insider and must be
paired with branch protection and review; `inspect` verifies the default branch's effective
branch protection and rulesets require both exact contexts and fails closed if either is
missing or the protection is unreadable. Live smoke is explicitly opt-in and read-only.
Every `PROJECT_CI_TOKEN` reference in inspect, true-up, and live-smoke workflows is scoped
only to the manager execution step; checkout, setup, and artifact-upload steps never
receive it. Scheduled or manually authorized write jobs upload the journal and retain
least-privilege `GITHUB_TOKEN` permissions because the workflow token cannot authorize
Project writes.

Claude, Codex, and Copilot adapter instructions all invoke the same vendored CLI and
must not reimplement board policy. The canonical Claude automation direction is GitHub
Action to Claude Routine callback: the Action supplies the validated inspection result
to a Routine; a Routine does not poll or invoke an Action as an untracked side channel.
All adapters preserve the rule that only a human sets `Approved`.

## 10. Compliance condition

A repository's release gate is fully compliant only when both exact required checks,
`Project Board Law / identity` and `project-board-law/live-board`, pass. Board compliance
also requires that local byte identity passes, authentication and
scope checks pass, required schema exists without collisions, every governed issue is
in the target Project with a milestone and valid custom values, native relations verify,
no write is left unverifiable or dependency-blocked, and the next true-up exists. Any
other state is reported as noncompliant; inspection never repairs it, while authorized
write commands repair only deterministic, additive state.
