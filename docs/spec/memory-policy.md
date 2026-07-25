# External Memory Ban

Status: normative memory policy for this repository. Binding on all agents,
harnesses, sub-agents, and automated sessions with no exceptions beyond the
approval process defined below.

## Scope

This policy governs where durable knowledge, learning, and operating rules may
persist. Root invariants live in `AGENTS.md`; its "Always Enforce" section
carries the short form of this rule and this document is its full specification.

The repository working tree is the only permitted home for persistent memory.
"External memory" means any persistence outside the working tree of the current
repository.

## The Ban

No external memory writes are permitted, for any reason, ever, with no
exceptions. This bans ALL persistence outside the repository working tree of
each of the following categories, each banned by name:

1. Agent/harness memory: memory tools, memory directories, `MEMORY.md`-style
   indexes, and any auto-memory feature that records or updates state.
2. Directives: standing instructions to agents or maintainers.
3. SOPs: standard operating procedures and runbooks.
4. Preferences: user, project, or agent preference stores.
5. Policies: normative rules, gates, and enforcement text.

The ban applies regardless of tool, provider, location, or format, including
home-directory config, global agent state, external databases, hosted memory
services, and any location outside this repository's working tree.

Examples of banned writes:

- Calling a harness memory tool to remember a project rule or user preference.
- Appending a directive to a home-directory `MEMORY.md` index.
- Saving a preference, SOP, or policy file outside the working tree.

## Exception Process

Any exception requires interactive, explicit human approval for every single
atomic write:

- One approval covers exactly one write.
- No standing approvals. No batched approvals. No session-wide approvals.
- Approval must be interactive and explicit for that specific write; silence,
  prior consent, or a general "yes to memory" never qualifies.
- Re-request approval for each subsequent atomic write, however similar.

## Allowed

- Ephemeral scratch and temp files that are not intended to persist as memory,
  such as session scratchpads and OS temp directories. These must not be used
  to smuggle durable memory past the ban.
- Reads and recall of existing external memory are NOT banned. Only writes to
  external memory are banned.

## Requirement: Capture In-Repo

All persistent, durable knowledge and learning must be captured in-repo:

1. Place it in the naturally-fitting document, under `docs/spec/**` or
   `agents/**`, not in an ad hoc location.
2. Wire it back to `AGENTS.md` via a Load Trigger pointing at that in-repo
   doc or spec, so it loads under a concrete trigger rather than always-on.
3. Never write a unified dump file. Durable knowledge belongs in the specific
   document its subject fits, split across documents as needed.

New or changed durable directive, SOP, or policy content added under this
requirement is subject to the Directive/SOP review gate in
`docs/spec/prompt-review/eight-perspective-review.md`.
