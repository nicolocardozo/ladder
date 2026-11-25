@AGENTS.md

# Website

Ladder's public website at itsladder.dev: Next.js (App Router, TypeScript), shadcn/ui, Tailwind 4, package `@ladder/website`. Deployed on Vercel from `main`. Pages: `/`, `/agents`, `/changelog`, `/docs`, `/privacy`.

## Rules

- Decisions live in `BRIEF.md`; the prototypes in `prototype/` show the structure, copy and animations already approved. Reviews flag defects against the brief; they don't propose redesigns.
- Circuit colors are copied by hand into `src/app/globals.css` and the logo paths into `src/components/brand/logo-paths.ts`: `sync-brand` only updates the app, so if `brand/themes.json` or the logo changes, update them here by hand.
- Agent icons come from `@lobehub/icons-static-svg`. For now third-party logos are off: `AgentIcon` shows the agent's initial (`SHOW_AGENT_LOGOS` in `src/components/brand/agent-icon.tsx`).
- Server components by default; `"use client"` only for animated or interactive parts, loaded with `next/dynamic` if they aren't needed for the first paint.
- React Bits components only when the brief names them, with the brand's colors and density. Their license (MIT + Commons Clause) forbids redistributing the source, so they are never committed: `scripts/fetch-react-bits.mjs` downloads them into `src/components/react-bits/` (git-ignored) before dev, build, typecheck and lint, checks a pinned sha256 and applies small local patches. To add one, add it to that script; style it through props, not by editing the file.
- Every animation respects `prefers-reduced-motion` with a readable static state.
- SEO: metadata for every page, real text in the markup, a single h1, no layout shift.
- Website copy and code comments in English (older files still have Italian comments that are being translated).
- Downloads (`/download`, `/download/apple-silicon`, `/download/intel`) are redirects in `next.config.ts` to the releases of `nicolocardozo/ladder-releases`.

## Verification

1. `pnpm --filter @ladder/website build` without errors. Next's Cache Components warnings are not errors.
2. The preview, `pnpm --filter @ladder/website dev` (port 3100; in the maintainer's setup it is the `ladder-website` entry of `.claude/launch.json`).
3. Screenshots at 1440×900 and 375×812 (mobile preset, then reload) of the pages touched; if you don't know what changed, the home page. For scroll-driven animations, one screenshot at the start and one at the end.
4. Console without errors; no horizontal scroll: `[document.documentElement.scrollWidth, window.innerWidth]` must be equal.
5. With reduced motion the section stays readable.
6. Close the preview you opened.
