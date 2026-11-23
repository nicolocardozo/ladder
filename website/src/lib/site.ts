// Costanti uniche del sito: nome, descrizione, URL. Da aggiornare qui.
export const SITE = {
  name: "Ladder",
  tagline: "Every agent, every repo, one calm window.",
  description:
    "Ladder is a calm desktop app for macOS that runs Claude Code, Codex, Gemini CLI and other coding agents across all your repos, with approvals, worktrees and plan limits in one window.",
  url: "https://itsladder.dev",
  // Link al repo pubblico, se e quando ci sarà: con null header e footer non mostrano GitHub
  githubUrl: null as string | null,
  // Link al file dell'app per i dati strutturati: null finché non c'è una release pubblica
  downloadUrl: null as string | null,
  locale: "en_US",
} as const

// Azione principale di tutto il sito (header, hero, chiusura). Per ora è la lista d'attesa via mail;
// quando l'app sarà scaricabile basta cambiare questo oggetto e impostare SITE.downloadUrl.
export const CTA = {
  href: "mailto:waitlist@itsladder.dev?subject=Ladder%20waitlist",
  label: "Join the waitlist",
  short: "Join waitlist",
  aria: "Join the Ladder waitlist",
} as const

// Pagine del sito, usate da sitemap e footer
export const PAGES = [
  { path: "/", label: "Home", priority: 1 },
  { path: "/agents", label: "Agents", priority: 0.8 },
  { path: "/docs", label: "Docs", priority: 0.7 },
  { path: "/changelog", label: "Changelog", priority: 0.6 },
  { path: "/privacy", label: "Privacy", priority: 0.3 },
] as const
