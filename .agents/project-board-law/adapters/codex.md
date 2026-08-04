# Codex adapter

Run the vendored CLI before and after governed work. Always pass both canonical URLs;
use `--dry-run` to preview writes. Translate unresolved choices into `hr` comments on the
affected issue. Never set `Approved`; wait for the human's Project status change.

Any inspection digest carries no titles or bodies, so before ANY issue creation read the
board and apply the law's §4 match rule: extend a plausible existing open issue instead of
opening a duplicate. A mid-task human redirection re-triggers the rule; ambiguity among
candidates is a Decision HR via `hr`.

```sh
node .agents/project-board-law/manager.js inspect \
  --repo https://github.com/OWNER/REPO \
  --project https://github.com/users/PROJECT_OWNER/projects/NUMBER
```
