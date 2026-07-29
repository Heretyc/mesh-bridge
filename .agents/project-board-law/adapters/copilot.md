# Copilot adapter

Use the vendored CLI as the policy boundary. Do not recreate schema or lifecycle calls in
an agent prompt. Always pass both canonical URLs, leave destructive confirmations to a
human, and never set `Approved`.

```sh
node .agents/project-board-law/manager.js inspect \
  --repo https://github.com/OWNER/REPO \
  --project https://github.com/users/PROJECT_OWNER/projects/NUMBER
```
