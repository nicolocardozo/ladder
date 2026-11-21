import type { Metadata } from "next"
import { SiteFooter } from "@/components/site-footer"

export const metadata: Metadata = {
  title: "Privacy",
  description: "How Ladder handles your data: it runs on your Mac, talks directly to your agents and keeps your code local.",
  alternates: { canonical: "/privacy" },
}

// Segnaposto: contenuto da scrivere
export default function Page() {
  return (
    <>
      <main className="mx-auto w-full max-w-3xl px-4 py-32 sm:px-8">
        <h1 className="text-4xl font-semibold tracking-tight">Privacy</h1>
        <p className="mt-4 text-muted-ink">The privacy policy is coming soon.</p>
      </main>
      <SiteFooter />
    </>
  )
}
