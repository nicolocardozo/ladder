// Costanti uniche del sito: nome, descrizione, URL. Da aggiornare qui.
export const SITE = {
  name: "Ladder",
  tagline: "Every agent, every repo, one calm window.",
  description:
    "Ladder is a calm desktop app for macOS that runs Claude Code, Codex, Gemini CLI and other coding agents across all your repos, with approvals, worktrees and plan limits in one window.",
  url: "https://itsladder.dev",
  // Link al repo pubblico, se e quando ci sarà: con null header e footer non mostrano GitHub
  githubUrl: null as string | null,
  // Link al file dell'app (dati strutturati): /download rimanda all'ultimo DMG (vedi next.config.ts)
  downloadUrl: "https://itsladder.dev/download" as string | null,
  // Indirizzo di contatto per privacy e domande (va attivato su Cloudflare Email Routing)
  email: "hello@itsladder.dev",
  locale: "en_US",
} as const

// Azione principale di tutto il sito (header, hero, chiusura): scarica l'ultima versione per Mac.
export const CTA = {
  href: "/download",
  label: "Download for Mac",
  short: "Download",
  aria: "Download Ladder for macOS",
} as const

// Pagine del sito, usate da sitemap e footer
export const PAGES = [
  { path: "/", label: "Home", priority: 1 },
  { path: "/agents", label: "Agents", priority: 0.8 },
  { path: "/docs", label: "Docs", priority: 0.7 },
  { path: "/changelog", label: "Changelog", priority: 0.6 },
  { path: "/privacy", label: "Privacy", priority: 0.3 },
] as const
