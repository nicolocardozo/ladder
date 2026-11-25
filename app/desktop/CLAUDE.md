# Desktop app

Electron for macOS (electron-vite, TypeScript, node:sqlite), package `@ladder/desktop`. The commands below run from the repository root with `pnpm --filter @ladder/desktop …`, except where it says "from `app/desktop`".

## Structure

```
src/main/      main process: windows, menus, updates, notifications
src/host/      work with the agents: Claude (Agent SDK), Codex (app-server), ACP, sign-in and limits, SQLite, git and worktrees, files, terminal
src/preload/   bridge between main and renderer
src/renderer/  interface: React 19, Tailwind 4, shadcn on Base UI, state in zustand (src/renderer/src/store/app-store.ts)
src/shared/    host-renderer contract (protocol.ts), i18n, Italian catalogs (locales/it)
scripts/       postinstall, brand, release
```

The contract between host and renderer is `src/shared/protocol.ts`: change it only when really needed, and host and renderer use it the same way.

## Rules

- Inherited `ANTHROPIC_*` and `CLAUDE*` variables never reach child processes: the environment always starts from `cleanEnv()` (`src/shared/env.ts`). Ladder then adds its own on purpose, for example `CLAUDE_CONFIG_DIR` in `claudeEnv` (`src/host/claude/environment.ts`) for non-default profiles. The terminal has its own, wider filter (`src/host/terminals.ts`).
- Never read, print, log or copy credentials, tokens or Keychain contents.
- User-facing text in English inside `t('…')` (English is the source language), with the entry in the Italian catalog in `src/shared/locales/it`. The key is the exact English text: if you change the English text, change the key too, or the translation disappears without errors. A new catalog file must be registered in `locales/it/index.ts`.
- No em dashes in user-facing text.
- Interface: first read `app/DESIGN.md` and reuse the components in `src/renderer/src/components` (`ui/`, `composer/`, `chat/`). Colors as tokens, elements reachable by keyboard, `aria-label` on icon buttons, visible focus.
- Agent APIs: the first source is the types installed in `node_modules` (`@anthropic-ai/claude-agent-sdk/*.d.ts` at the version pinned in `package.json`, the Codex app-server schema). The adapters depend on fields that change between versions; the web comes after.
- Edge cases to keep in mind, in development and in review: agent not available, concurrent requests, session closed halfway, listeners or processes left alive.
- Short comments in English that explain why or a non-obvious behavior. Older code still has Italian comments that are being translated: in a file you rewrite, don't mix the two languages.

## Verification

1. `pnpm --filter @ladder/desktop typecheck`.
2. `pnpm --filter @ladder/desktop build` if the change touches host or main.
3. Visible changes: the browser preview, `pnpm --filter @ladder/desktop dev:web` (port 5199, page `/preview.html`; in the maintainer's setup it is the `ladder-web` entry of `.claude/launch.json`). If port 5199 is already taken by a vite of this project, use it and don't restart it. The preview doesn't start the host: data comes from the fixtures in `src/renderer/src/dev/fixtures.ts` and from the previews in `src/renderer/src/dev/`. Useful parameters: `?lang=it` for translations, `?view=connections|agents|terminals|new` for the other views. For a particular state, from the console: `const { useApp } = await import('/src/store/app-store.ts'); useApp.setState({...})` (path relative to the vite root, `src/renderer`).
4. Try the requested interaction, keyboard included; console without errors; light and dark theme if colors change. A screenshot of the final state.
5. What goes through the host (real agents, sign-in, git, terminal) doesn't show in the preview: try it in the development app with a test profile, `LADDER_USER_DATA=<folder> LADDER_WORKTREES=<folder> pnpm --filter @ladder/desktop dev`. Main doesn't hot-reload: restart after changes to host or main.
6. In the report, what you couldn't verify and why.

## Release

Only when the user asks.
1. Version in `app/desktop/package.json`, commit.
2. The maintainer runs `pnpm --filter @ladder/desktop release:mac`: build, signing and notarization for arm64 and x64. `--arch=arm64|x64` and `--dmg-only` only serve to redo a failed build: publishing needs both architectures.
3. From `app/desktop`: `node scripts/publish-release.mjs` publishes the DMG, zip and `latest-mac.yml` to `nicolocardozo/ladder-releases`.
4. Tag `vX.Y.Z` on the repository, push.
5. Check `/download/apple-silicon` and `/download/intel` on the website (file size).
