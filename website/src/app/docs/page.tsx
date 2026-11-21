import type { Metadata } from "next"
import { SiteFooter } from "@/components/site-footer"

export const metadata: Metadata = {
  title: "Documentation",
  description: "Documentation for Ladder: install the app, connect Claude Code, Codex and other agents, and work with approvals and worktrees.",
  alternates: { canonical: "/docs" },
}

// Segnaposto: contenuto da scrivere
export default function Page() {
  return (
    <>
      <main className="mx-auto w-full max-w-3xl px-4 py-32 sm:px-8">
        <h1 className="text-4xl font-semibold tracking-tight">Documentation</h1>
        <p className="mt-4 text-muted-ink">Documentation is coming soon.</p>
      </main>
      <SiteFooter />
    </>
  )
}
