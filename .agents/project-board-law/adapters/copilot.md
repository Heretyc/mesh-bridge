# Copilot adapter

Use the vendored CLI as the policy boundary. Do not recreate schema or lifecycle calls in
an agent prompt. Always pass both canonical URLs, leave destructive confirmations to a
human, and never set `Approved`.

Any inspection digest carries no titles or bodies, so before ANY issue creation read the
board and apply the law's §4 match rule: extend a plausible existing open issue rather than
open a duplicate. A mid-task human redirection re-triggers the rule; ambiguity among
candidates is a Decision HR via `hr`.

```sh
node .agents/project-board-law/manager.js inspect \
  --repo https://github.com/OWNER/REPO \
  --project https://github.com/users/PROJECT_OWNER/projects/NUMBER
```
