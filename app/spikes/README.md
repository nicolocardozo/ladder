# Phase 0 spikes

Command-line prototypes that verify the technical hypotheses of the initial plan. "Blue" in these files was Ladder's working name.
Each folder is a standalone npm package, outside the pnpm workspace, with pinned versions and a README with results and conclusions.

| Folder | Verifies |
|---|---|
| `claude-sdk/` | S2 · Agent SDK: streaming, approvals, questions, interruption, resume |
| `codex-app-server/` | S1 · Codex App Server: full lifecycle with ChatGPT login |
| `acp/` | S5 · generic ACP client with a real agent |
| `terminal-hooks/` | S6 · terminal session state via hooks |
| `git-checkpoint/` | S4 · checkpoints with a temporary index |

The scripts are in TypeScript and run with `node` (Node 24 strips the types by itself): no enums, namespaces or other non-erasable syntax.
The test repositories are created in temporary folders: no spike touches the real projects.
