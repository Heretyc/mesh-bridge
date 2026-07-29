# Codex adapter

Run the vendored CLI before and after governed work. Always pass both canonical URLs;
use `--dry-run` to preview writes. Translate unresolved choices into `hr` comments on the
affected issue. Never set `Approved`; wait for the human's Project status change.

```sh
node .agents/project-board-law/manager.js inspect \
  --repo https://github.com/OWNER/REPO \
  --project https://github.com/users/PROJECT_OWNER/projects/NUMBER
```
