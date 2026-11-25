# Ladder

A macOS desktop workspace for working on several repositories at once with coding agents (Claude, Codex, ACP agents), with a phone app that controls it remotely through an end-to-end encrypted relay. Public website at itsladder.dev. Open source under Apache-2.0.

## Parts

| Folder | What | Instructions |
|---|---|---|
| `app/desktop` | Electron app | `app/desktop/CLAUDE.md` |
| `app/mobile` | Phone app (Expo), remote control for the Mac app | `app/mobile/CLAUDE.md` |
| `app/relay` | Relay between Mac and phone (Cloudflare Worker) | `app/relay/CLAUDE.md` |
| `website` | Next.js website | `website/CLAUDE.md` |
| `brand` | Themes and logo, the source for app and website | app: change `brand/themes.json`, then `pnpm --filter @ladder/desktop sync-brand`; website: update it by hand (see `website/CLAUDE.md`) |
| `app/spikes` | Technical prototypes, not in production | read only |

A part's instructions load when a file in that folder is read. Before verifying or reviewing a change, read the CLAUDE.md of the part it touches.

## Commands

Run from the repository root:

```bash
pnpm install
pnpm --filter @ladder/desktop typecheck
pnpm --filter @ladder/desktop build
pnpm --filter @ladder/mobile typecheck
pnpm --filter @ladder/relay test
pnpm --filter @ladder/website build
```

## Documents

- `app/PRODUCT.md`: users, purpose, product rules (agent catalog, downloads, sign-in). Read it before changing a behavior.
- `app/DESIGN.md`: the app's visual system. Read it before touching the interface.
- `website/BRIEF.md`: website decisions.
- The plan and the backlog live in Linear.

## Public repository

The repository is public under Apache-2.0: everything committed, history included, is visible to anyone.
- English everywhere: code comments, docs, commit messages, script output. Italian only in `app/desktop/src/shared/locales/it` and in the Italian variants of agent prompts.
- Nothing private: no names of other projects or clients, no personal paths (`/Users/<name>/…`), no personal emails, tokens or keys, no internal notes. Plans and the backlog live in Linear; private notes stay outside the repository. Sample data, fixtures and tests use generic names (`acme-monorepo`, `/Users/dev/…`).
- Comments explain the code; they don't reference Linear issues (`LAD-…`), phases or internal plans.
- Third-party code: copy it only if its license allows redistribution under Apache-2.0, keep its copyright notice, and add it to `NOTICE` when the license asks. Code that can't be redistributed is fetched at build time instead, like the React Bits components (see `website/CLAUDE.md`).
- In the maintainer's setup a local pre-commit hook (not in the repository) blocks private names and secrets. If it blocks a commit, fix the content; don't bypass it with `--no-verify`.

## Project agents (maintainer only)

The maintainer's setup has local agents that are not in the repository: `ui` (renderer), `host` (main and host), `web` (website), `linear` (backlog), plus personal `verifier`, `reviewer` and `researcher` agents that read these files. Without them, follow the "Verification" sections of each part's CLAUDE.md directly.

## Git

- Work happens on the `development` branch. Commit and push only when the user asks.
- Align `main` only on explicit request, because it publishes the website to production: `git push origin development:main` and `git branch -f main development` (the second fails if `main` is checked out in a worktree).
- Commit messages, PR titles and descriptions in English: imperative title, short, no final period (e.g. `Add auto-updates from ladder-releases`); if needed, a bulleted body with what changes and why. No `Co-Authored-By` or other agent attribution.
- Commits use the maintainer's GitHub noreply email (set in this repository's git config), never a personal address.
- Other sessions often work in the same folder. Before a change across several files, check `git status` for changes that aren't yours; if another `ladder-*` session is active on the same files, ask and use a separate worktree (`../ladder-<name>`).

## Linear (maintainer only)

Workspace "Ladder", team LAD, project P-LAD-1, through the `linear` agent.
- "Develop F5" means every issue of the milestone, in order, to the end, not just the first one.
- At the end of an issue: status Done and a "Come testarla" comment in Italian, with concrete steps in the app, what to expect and edge cases. Done only after the user's OK, unless the request already gave it. The delegating agent writes the comment text and passes it ready to the `linear` agent.
