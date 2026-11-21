// Costanti uniche del sito: nome, descrizione, URL. Da aggiornare qui quando il dominio sarà deciso.
export const SITE = {
  name: "Ladder",
  tagline: "Every agent, every repo, one calm window.",
  description:
    "Ladder is a calm desktop app for macOS that runs Claude Code, Codex, Gemini CLI and other coding agents across all your repos, with approvals, worktrees and plan limits in one window.",
  // TODO: segnaposto, dominio e link ancora da decidere (vedi "Domande aperte" nel brief)
  url: "https://ladder.dev",
  downloadUrl: "https://github.com/ladder-app/ladder/releases/latest",
  githubUrl: "https://github.com/ladder-app/ladder",
  locale: "en_US",
} as const

// Pagine del sito, usate da sitemap e footer
export const PAGES = [
  { path: "/", label: "Home", priority: 1 },
  { path: "/agents", label: "Agents", priority: 0.8 },
  { path: "/docs", label: "Docs", priority: 0.7 },
  { path: "/changelog", label: "Changelog", priority: 0.6 },
  { path: "/privacy", label: "Privacy", priority: 0.3 },
] as const
