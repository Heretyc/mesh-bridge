# Claude adapter

Invoke `.agents/project-board-law/manager.js`; do not duplicate its governance rules.
Always pass the repository and Project HTTPS URLs. A Claude Routine receives a completed
GitHub Action inspection callback and acts on that result. Direction is Action → Routine;
the Routine does not poll Actions or synthesize approval. Post HR with `hr`; only a human
sets `Approved` in the Project.

```sh
node .agents/project-board-law/manager.js inspect \
  --repo https://github.com/OWNER/REPO \
  --project https://github.com/users/PROJECT_OWNER/projects/NUMBER
```
