import type { Metadata } from "next"
import { SiteFooter } from "@/components/site-footer"

export const metadata: Metadata = {
  title: "Supported agents",
  description: "The coding agents Ladder works with: Claude Code, Codex, Gemini CLI, OpenCode, Goose, Qwen Code, Amp, Cline, Kimi CLI and more from the ACP registry.",
  alternates: { canonical: "/agents" },
}

// Segnaposto: contenuto da scrivere
export default function Page() {
  return (
    <>
      <main className="mx-auto w-full max-w-3xl px-4 py-32 sm:px-8">
        <h1 className="text-4xl font-semibold tracking-tight">Supported agents</h1>
        <p className="mt-4 text-muted-ink">The full list of supported agents is coming soon.</p>
      </main>
      <SiteFooter />
    </>
  )
}
