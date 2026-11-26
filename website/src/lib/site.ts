// Single constants of the site: name, description, URL. Update them here.
export const SITE = {
  name: "Ladder",
  tagline: "Every agent, every repo, one calm window.",
  description:
    "A free, open source macOS app that runs Claude Code, Codex and other coding agents across your repos, with approvals, worktrees and plan limits in one window.",
  url: "https://itsladder.dev",
  // Public repository: header, mobile menu and footer link to it (null hides the links)
  githubUrl: "https://github.com/nicolocardozo/ladder" as string | null,
  // Link to the app file (structured data): /download redirects to the latest DMG (see next.config.ts)
  downloadUrl: "https://itsladder.dev/download" as string | null,
  // Contact address for privacy and questions (must be enabled on Cloudflare Email Routing)
  email: "hello@itsladder.dev",
  locale: "en_US",
} as const

// Published DMGs (redirect in next.config.ts). /download is the default, Apple Silicon.
export const DOWNLOADS = {
  auto: "/download",
  arm64: "/download/apple-silicon",
  x64: "/download/intel",
} as const

// Main action of the whole site (header, hero, closing): download the latest version for Mac.
export const CTA = {
  href: "/download",
  label: "Download for Mac",
  short: "Download",
  aria: "Download Ladder for macOS",
} as const

// Pages of the site, used by sitemap and footer
export const PAGES = [
  { path: "/", label: "Home", priority: 1 },
  { path: "/agents", label: "Agents", priority: 0.8 },
  { path: "/docs", label: "Docs", priority: 0.7 },
  { path: "/changelog", label: "Changelog", priority: 0.6 },
  { path: "/privacy", label: "Privacy", priority: 0.3 },
] as const
