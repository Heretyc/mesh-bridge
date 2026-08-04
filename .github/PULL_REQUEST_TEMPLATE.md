# Summary


# Scope


# Validation


# Claude Routine

- Session URL:
- Routine status for current head SHA: pass/fail/blocked
- Emergency override or bypass rationale: none


# Project Board Law

- Linked board item / issue: # (or note: blocked pending authorization)
- Milestone:
- Fields (Status / Priority / Size / Estimate / Iteration):
- Required checks status (`Project Board Law / identity`, `project-board-law/live-board`):
- Environment controls VERIFIED fail-closed (not asserted): environment exists / secret in
  environment not repo / deployment branches = default branch only / no `refs/pull/*/merge`: yes/blocked
- Least privilege confirmed: `PROJECT_CI_TOKEN` for the read-only `inspect` use holds
  only `read:project` (no repository write scope unless a specific endpoint requires it —
  private-repo issue reads need `repo`, public repos need none), mapped solely to the
  read-only manager `inspect` step and fail-closed otherwise (no write-capable `hr`
  under this token); callback `GITHUB_TOKEN` job-scoped `statuses: write` only
  (`pull-requests: read` only on the verdict bridge, not this inspect job). No values printed.
- Live-board smoke gate: opt-in read-only `workflow_dispatch` live smoke run for the
  current head (pass/blocked), or intentionally absent — the `Project Board Law / identity`
  and `project-board-law/live-board` required checks gate the merge either way.
- Owner-approved narrow exceptions applied in this change:
  - Committed-only runtime provenance: the vendored `.agents/project-board-law/**`
    runtime is tracked in source control; its printed SHA-256 is its only identity.
  - Hardened `pull_request_target` precondition: the token-bearing `live-board`
    job checks out only the immutable `github.event.pull_request.base.sha`, binds
    `PROJECT_CI_TOKEN` to the default-branch-restricted `project-board-law`
    environment (verified per above), and never touches pull-request content,
    artifacts, caches, or inputs.


# Risk


# Rollback


# Reviewer Notes


# Checklist

- [ ] I inspected the staged diff before committing.
- [ ] I kept this PR to one cohesive change set.
- [ ] I preserved user/unowned work.
- [ ] I updated tests/docs or recorded why not.
- [ ] I checked generated, large, binary, and cached files intentionally.
- [ ] I did not add AI attribution or co-author lines.
- [ ] I linked this PR to its Project Board Law item and filled the governance metadata
      above, or noted the link/values as blocked pending authorization where they are not
      yet available.
