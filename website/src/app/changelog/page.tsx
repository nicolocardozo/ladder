import type { Metadata } from "next"
import { SiteFooter } from "@/components/site-footer"

export const metadata: Metadata = {
  title: "Changelog",
  description: "Release notes for Ladder: what changed in every version of the macOS app for running coding agents.",
  alternates: { canonical: "/changelog" },
}

// Segnaposto: contenuto da scrivere
export default function Page() {
  return (
    <>
      <main className="mx-auto w-full max-w-3xl px-4 py-32 sm:px-8">
        <h1 className="text-4xl font-semibold tracking-tight">Changelog</h1>
        <p className="mt-4 text-muted-ink">Release notes are coming soon.</p>
      </main>
      <SiteFooter />
    </>
  )
}
