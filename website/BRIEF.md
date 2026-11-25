# Ladder website: brief

Single source for whoever works on the site. Agents read this file instead of having decisions repeated to them.

## References

- Prototypes in `prototype/`: `v2.html` (sections as 4+1 cards, central sentence) and `v3.html` (boxed hero, drum-style cards). The `*-src.html` files are the sources; `python3 build.py v3-src.html v3.html` inserts the logo and icons from `brand/` and `app/desktop/node_modules`.
- Inspirations: hero and rhythm of [rbp-shader-template](https://rbp-shader-template.vercel.app/), product section of [rbp-genai-template](https://rbp-genai-template.vercel.app/#product), nav of [Efferd hero-4](https://efferd.com/view/hero-4). Animations and components on those sites come from React Bits.
- Brand: `brand/themes.json` (Circuit theme), `brand/logo/svg/`, agent icons from `@lobehub/icons-static-svg`. Real app UI: `app/desktop/src/renderer`, `app/DESIGN.md`.

## Principles

- White page. Strong color lives in the Ladder window in the Circuit theme (dark violet), which creates contrast.
- Animations tell things Ladder really does: agents at work, requests waiting, approvals, worktrees, plan limits. No decorative effects without meaning.
- No section labels like "01 / 02 · The problem", no decorative underlines.
- `prefers-reduced-motion`: every animation has a readable static state.
- Copy in English.

## Sections, in order

### 1. Hero
- Full-width box with a margin, **radius 0**, light dotted background (React Bits Dot Grid or equivalent); dots near the cursor light up.
- Header above the box: **logo with no background on the left**, **compact nav on the right** in the style of the v2 nav (blurred white, thin border, in-sentence links, dark Download).
- Initial state: large claim on the left, small subtitle at the bottom left, download at the bottom right, a prompt to scroll.
- On scroll the claim shrinks and moves to the top **on two lines**: "Every agent, every repo," / "one calm window." (second line in iris). The Ladder window rises from the bottom, straight and large.
- The window **must not appear with an empty chat**: when it arrives a conversation is already in progress (request, reads, subagents), then the demo continues (approval request from another project, notification, ⏎, work finished).
- Window: faithful reconstruction of the real UI (sidebar with New chat, Waiting, projects and sessions; tabs with the agent's icon; composer with usage, agent, permissions).

### 2. Problem sentence
- As in v2: large sentence, text in the middle of the page; words light up on scroll, the last sentence in iris.
- **Below the sentence**: [Ghost Fibers from React Bits](https://reactbits.dev/backgrounds/ghost-fibers), on a white background, in a color that does not clash with the violet part of the text (slate gray or a cool neutral). Check whether it is a Pro component and what the license is.

### 3. Features: the 5 cards from v2
- 2×2 grid plus a wide card below, as in v2: Waiting, subagents, worktrees, plan limits, agent catalog with sha256. Each card has an animated Circuit mini-screen.
- The three-level drum from v3 (GenAI style) is still to be decided: it does not replace these cards.

### 4. Supported agents
- Like the reference provided ("Works with your tools"): title, subtitle, a 3-column table of cells with the agent's icon and name, last cell "+N more" with an arrow. On a white background, thin borders.
- Agents: Claude Code, Codex, Gemini CLI, OpenCode, Goose, Qwen Code, Amp, Cline, Kimi CLI and "+N more" from the ACP registry.

### 4b. Coming soon: phone app
- Eyebrow "Coming soon", two columns like section 4: text and four short points (approve and answer, start and check limits, Live Activity and widget on iPhone, code pairing with end-to-end encryption through a relay), and a CSS phone with one Waiting card on the dotted frame. No store badges, links, dates or sign-up form; no claims beyond what is built.

### 5. Closing and footer
- Box with claim and download, **radius 0**, **inverted colors**: dark violet (Circuit) background with the dots, light text.
- **Only the Ladder logo**, without the app-icon-style tile.
- Simple footer below.

## Stack
- **Next.js** (App Router, TypeScript), **shadcn/ui**, **Tailwind 4**. `@ladder/website` package in the pnpm workspace (`website/`).
- Pages rendered on the server or static (SSG); animated parts are isolated client components, so the HTML reaches search engines complete.
- React Bits components fetched from their registry at build time by `scripts/fetch-react-bits.mjs` (not committed, because their license forbids redistributing the source), styled to the brand through props.
- Fonts with `next/font` (Mona Sans, Monaspace Neon or JetBrains Mono), images with `next/image`.

## SEO
- Next Metadata API for title, description, canonical, Open Graph and Twitter card; OG image generated with `next/og`.
- `sitemap.ts`, `robots.ts`, `manifest.ts`, favicon from the logo symbol.
- JSON-LD `SoftwareApplication` (macOS, category DeveloperApplication, price) and `Organization`.
- A single `h1`, clean heading hierarchy, real text in the markup (animated demos do not replace the text).
- Core Web Vitals: light hero on first load, animations loaded afterwards (`next/dynamic`), no layout shift, canvas only when visible.
- Pages to plan besides the home page: changelog, docs, supported agents, privacy. Each with its own metadata.

## Open questions
- The GitHub repository goes public under Apache-2.0: header and footer show the link once `SITE.githubUrl` is set in `src/lib/site.ts`.
- Three-level drum: where to use it, whether to use it.
- Deploy: Vercel is the natural choice with Next.js.
