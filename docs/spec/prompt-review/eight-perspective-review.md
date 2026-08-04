# 8-Perspective Prompt Review

Status: normative when activated by `AGENTS.md`, owner instruction, or durable
prompt/directive/SOP work.

## Purpose

Every new or changed durable prompt, directive, SOP, or skill must be reviewed
from eight distinct prompt-engineering perspectives before release. The review
is a quality gate. It does not create personas, fictional identities, or
delegated authority.

## Activation

This process applies only when creating or updating durable instructions,
policies, SOPs, prompts, or skills. It should not be loaded into context for
unrelated tasks unless the owner explicitly asks for it.

## Review Perspectives

Use these functional reviewer labels:

1. Clarity reviewer
2. Role and context reviewer
3. Structure reviewer
4. Example reviewer
5. Negative-constraint reviewer
6. Reasoning and decomposition reviewer
7. Output-format reviewer
8. Iteration and adversarial reviewer

## Required Questions

### Clarity Reviewer

- Is the task stated plainly?
- Are audience, constraints, terms, success criteria, and stop conditions clear?
- Are required actions distinguishable from examples?

### Role And Context Reviewer

- Is the actor or tool responsible for each action identified?
- Does the document avoid gimmicky persona framing?
- Does it state what context may and must not be assumed?

### Structure Reviewer

- Are critical rules early and repeated where useful?
- Are instructions separated from reference content?
- Are normative requirements easy to scan?

### Example Reviewer

- Are examples present when they reduce ambiguity?
- Are examples clearly marked as examples?
- Are likely failure modes shown as anti-examples when useful?

### Negative-Constraint Reviewer

- Does the document say what not to do?
- Are prohibited actions precise?
- Are privacy, credential, safety, and source-contamination boundaries explicit?

### Reasoning And Decomposition Reviewer

- Is the task split when one context would be too large?
- Are integration steps defined?
- Are reasoning requirements bounded and token-conscious?

### Output-Format Reviewer

- Are required outputs, schemas, statuses, filenames, or templates specified?
- Are error shapes enumerated?
- Are examples syntactically valid or marked illustrative?

### Iteration And Adversarial Reviewer

- How could a model shortcut or misread this document?
- What ambiguity could cause a bad assumption?
- What edge case would break validation or migration?
- Does the document say when to stop and ask the owner?

## Consensus Rule

All eight reviewers must agree that the approach is sufficient. If any reviewer
is concerned or unsure:

1. Record the concern.
2. Revise if the fix is within confirmed scope.
3. Re-run the review.
4. If concern remains or the fix changes scope, stop and ask the owner.

Do not mark review complete by majority vote.

## Review Record Template

Each perspective line records its verdict **and** the evidence/justification for
that verdict, so a `pass` is traceable, not asserted. Record either one reviewer
id + date per perspective, or a single `Consolidated by` id + date when one
reviewer ran all eight passes.

```markdown
## Review Record: <file>

- File:
- Review date:
- Reviewer id(s) / Consolidated by:
- Scope:
- Clarity reviewer: pass|concern — evidence: <what was checked and why it passes/concerns>
- Role and context reviewer: pass|concern — evidence: <...>
- Structure reviewer: pass|concern — evidence: <...>
- Example reviewer: pass|concern — evidence: <...>
- Negative-constraint reviewer: pass|concern — evidence: <...>
- Reasoning and decomposition reviewer: pass|concern — evidence: <...>
- Output-format reviewer: pass|concern — evidence: <...>
- Iteration and adversarial reviewer: pass|concern — evidence: <...>
- Concerns:
- Revisions made:
- Consensus: pass|blocked
```
