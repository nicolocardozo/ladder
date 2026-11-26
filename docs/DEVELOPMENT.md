# Development

## Building from source

You need macOS, Node 24 and pnpm (the version is pinned in `package.json`; `corepack enable` picks it up).

```bash
pnpm install
```

```bash
pnpm dev
```

`pnpm dev` opens the Electron app. To try only the interface in a browser, at `http://localhost:5199/preview.html` with sample data:

```bash
pnpm --filter @ladder/desktop dev:web
```

If Electron doesn't start because its binary is missing, the app's `postinstall` script downloads it; otherwise:

```bash
node app/desktop/node_modules/electron/install.js
```

A local build to install:

```bash
pnpm --filter @ladder/desktop dist
```

It creates `app/desktop/dist/mac-arm64/Ladder.app`, signed only for this Mac: drag it to Applications.

The website (`pnpm --filter @ladder/website dev` or `build`) downloads two background components from the [React Bits](https://reactbits.dev) registry before it starts. They are used under React Bits' own license and are not part of this repository.

node-pty is the only native module: it uses the bundled N-API prebuild (no node-gyp), `postinstall` makes `spawn-helper` executable, and the build keeps it outside the asar.

## Repository layout

| Folder | Contents |
|---|---|
| `app/desktop` | The Electron app: React 19, TypeScript, Tailwind 4, shadcn/ui on Base UI |
| `app/mobile` | The phone app (Expo), a remote control for Ladder on the Mac; not in the stores yet |
| `app/relay` | The relay between Mac and phone: a Cloudflare Worker that forwards end-to-end encrypted bytes; see its README |
| `app/spikes` | Phase 0 technical prototypes, standalone npm packages outside the workspace |
| `website` | The website (Next.js) |
| `brand` | Themes, logo, app icons and boards, shared by the app and the website |

[`app/PRODUCT.md`](../app/PRODUCT.md) and [`app/DESIGN.md`](../app/DESIGN.md) describe the product rules and the visual system; they apply to every interface change.

## Architecture

- `src/main`: windows, menus, dialogs; starts the host and hands it a MessagePort per window. Notifications and the Dock badge (`attention.ts`), `ladder://` links, Linear (`linear.ts`).
- `src/host`: the session host in a `utilityProcess`, with SQLite (`node:sqlite`), git checkpoints and diffs (`git.ts`, `workspace.ts`), files (`files.ts`), terminals with node-pty and headless xterm (`terminals.ts`), worktrees and ports (`worktrees.ts`), project configuration (`project-settings.ts`), GitHub through gh (`github.ts`), search (`search.ts`) and button prompts (`prompts.ts`). Agents share an interface in `agents/common.ts`: Claude Code in `claude/`, Codex on the App Server in `codex/`, ACP agents in `acp/`, reviews in `review.ts`.
- `src/shared/protocol.ts`: types and messages between the host and the interface.
- `src/renderer`: React; state comes from the host (`store/app-store.ts`), the chat is in `components/chat`, the inspector in `components/inspector`, terminals in `components/terminal` and `lib/terminal-registry.ts`.

User-facing text is English inside `t()` and `plural()` (`src/shared/i18n.ts`); Italian translations live in `src/shared/locales/it/`, keyed by the English sentence.

## Themes

- `brand/themes.json` is the source of the theme tokens; `brand/themes.css` is the reference for the variables.
- `pnpm --filter @ladder/desktop sync-brand` regenerates the files the app uses from the JSON and the SVGs in `brand/logo/svg/`: `themes.generated.css`, `src/shared/themes.generated.ts` and the logo paths.
- `node app/desktop/scripts/check-contrast.mjs` checks every theme's contrast: 4.5:1 for text, 3:1 for focus, control borders and indicators.

## Debugging

- The page exposes `window.__ladder` (`request`, `send`, `store`, `settings`).
- `LADDER_USER_DATA=<folder>` uses a separate data folder; `LADDER_WORKTREES=<folder>` moves the worktrees.
- `LADDER_LOCALE=en|it` sets the initial language of a new profile (after that, the saved one wins).
- `LADDER_EDITOR_TRACE=<file>` and `LADDER_NOTIFY_TRACE=<file>` record editor launches and notifications instead of performing them, for automated tests.
- `LADDER_GH=<executable>` replaces gh, `LADDER_LINEAR_API=<url>` the Linear API and `LADDER_PR_POLL_MS` the PR polling interval (90 s).
- `LADDER_CODEX=<binary>` picks the Codex to use; `LADDER_ACP_REGISTRY=<url>` replaces the ACP registry (development builds only).
