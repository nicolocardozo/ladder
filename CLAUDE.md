# Ladder

A macOS desktop workspace for working on several repositories at once with coding agents (Claude, Codex, ACP agents). Public website at itsladder.dev. Open source under Apache-2.0.

## Parts

| Folder | What | Instructions |
|---|---|---|
| `app/desktop` | Electron app | `app/desktop/CLAUDE.md` |
| `website` | Next.js website | `website/CLAUDE.md` |
| `brand` | Themes and logo, the source for app and website | app: change `brand/themes.json`, then `pnpm --filter @ladder/desktop sync-brand`; website: update it by hand (see `website/CLAUDE.md`) |
| `app/spikes` | Technical prototypes, not in production | read only |

A part's instructions load when a file in that folder is read. Before verifying or reviewing a change, read the CLAUDE.md of the part it touches.

The mobile app (`app/mobile`, Expo) and the Cloudflare relay (`app/relay`) of milestone M6 are being developed on the `m6/*` branches, with worktrees in `.claude/worktrees/m6-*`, and are not in `development` yet. When they land, each gets its own row here and its own CLAUDE.md.

## Commands

Run from the repository root:

```bash
pnpm install
pnpm --filter @ladder/desktop typecheck
pnpm --filter @ladder/desktop build
pnpm --filter @ladder/website build
```

## Documents

- `app/PRODUCT.md`: users, purpose, product rules (agent catalog, downloads, sign-in). Read it before changing a behavior.
- `app/DESIGN.md`: the app's visual system. Read it before touching the interface.
- `website/BRIEF.md`: website decisions.
- The plan and the backlog live in Linear.

## Project agents (maintainer only)

The maintainer's setup has local agents that are not in the repository: `ui` (renderer), `host` (main and host), `web` (website), `linear` (backlog), plus personal `verifier`, `reviewer` and `researcher` agents that read these files. Without them, follow the "Verification" sections of each part's CLAUDE.md directly.

## Git

- Work happens on the `development` branch. Commit and push only when the user asks.
- Align `main` only on explicit request, because it publishes the website to production: `git push origin development:main` and `git branch -f main development` (the second fails if `main` is checked out in a worktree).
- Commit messages, PR titles and descriptions in English: imperative title, short, no final period (e.g. `Add auto-updates from ladder-releases`); if needed, a bulleted body with what changes and why.
- Other sessions often work in the same folder. Before a change across several files, check `git status` for changes that aren't yours; if another `ladder-*` session is active on the same files, ask and use a separate worktree (`../ladder-<name>`).

## Linear (maintainer only)

Workspace "Ladder", team LAD, project P-LAD-1, through the `linear` agent.
- "Develop F5" means every issue of the milestone, in order, to the end, not just the first one.
- At the end of an issue: status Done and a "Come testarla" comment in Italian, with concrete steps in the app, what to expect and edge cases. Done only after the user's OK, unless the request already gave it. The delegating agent writes the comment text and passes it ready to the `linear` agent.
