# Incident: 2026-07-24 Local Landing on `main`

Date: 2026-07-24

Local `main` received direct commits and a local merge without the
pull-request and CI path. This note records what landed, the authorization
under which it landed, exactly which controls were bypassed, and what is owed
afterward.

## Scope

Five commits land on `main` under this landing:

1. `chore(policy): add Claude CI/CD policy pack` — the governance pack,
   `.gitignore` hardening for `*.lnk` and `.agents/`, this incident note, and
   the expected-markdown-count bump to 19. Committed directly to `main`.
2. `Revert "fix: retry failed outbound sends"` — reverts
   126fca4a744415118c3199981a962c6e5b0cf972, ruled abandoned output by the
   owner, and corrects the README reaction and recovery wording to match the
   restored behavior. Committed directly to `main`.
3. feat: OTel JSONL logging — reaction-otel branch work; lands on `main` when
   `codex/reaction-otel` merges.
4. feat: mapping journal — reaction-otel branch work; lands on `main` when
   `codex/reaction-otel` merges.
5. feat: cross-platform parity — reaction-otel branch work; lands on `main`
   when `codex/reaction-otel` merges.

## Authorization

Owner authorization on record for this session:

> Explicit owner EMERGENCY approval to commit directly to the default branch
> main and to merge locally without the PR path and without a Claude Routine
> CI pass, because no remote operations are permitted this session so PR and
> CI are physically impossible.

Also on record for this session: owner confirmation that the governance pack
was reviewed before installation, waiving the eight-perspective review gate
for it; owner instruction to add `*.lnk` and `.agents/` to the tracked
`.gitignore`; and owner ruling that commit 126fca4 "fix: retry failed
outbound sends" is abandoned output to be reverted.

## Bypassed controls

- (a) Topic-branch + pull-request path per
  `docs/spec/dev-loop/git-collaboration.md:17-20` and
  `docs/CONTRIBUTING.md:11-12` — impossible, no remote operations permitted.
- (b) Claude Routine CI required-check pass per
  `docs/spec/dev-loop/git-collaboration.md:88-91` — impossible, no remote.
- (c) Prohibition on agent self-merge per
  `docs/spec/dev-loop/git-collaboration.md:88-91` — owner-approved override.
- (d) Eight-perspective review per
  `docs/spec/prompt-review/eight-perspective-review.md:14-17` for the
  governance pack — waived on owner confirmation that the pack was reviewed
  before installation.

## Follow-up owed

A pull request reconciling local `main` with `origin/main` must be opened
once remote operations are permitted. Note that `origin/main` (24e393f) is an
unrelated history to local `main`, so reconciliation will need
`--allow-unrelated-histories` or a fresh baseline decision by the owner.

## Verification performed instead

Local gates run in place of the bypassed remote path:

- `node scripts/check-md-policy.mjs`
- `npm run typecheck`
- `npm run build`
- `npm test`
- independent review sub-agent
- contradiction-checker sub-agent
- Linux Docker validation
- Windows live-radio UAT
