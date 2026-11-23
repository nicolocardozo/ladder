import type { Metadata } from "next"
import { Rss } from "lucide-react"
import { PageHeader, PageShell } from "@/components/page"
import { CTA } from "@/lib/site"
import { ENTRIES, formatDate } from "./entries"

export const metadata: Metadata = {
  title: "Changelog",
  description: "What's new in Ladder, the macOS workspace for coding agents: new features, agents and fixes, release by release.",
  alternates: { canonical: "/changelog", types: { "application/rss+xml": "/changelog/feed.xml" } },
  openGraph: { url: "/changelog" },
}

export default function Page() {
  return (
    <PageShell>
      <PageHeader
        eyebrow="Changelog"
        title="What's new"
        lead={
          <>
            Ladder is in private preview. Until the first public release, these are the milestones of its development.{" "}
            <a href={CTA.href} className="font-medium text-iris hover:underline">
              Join the waitlist
            </a>{" "}
            to try it.
          </>
        }
      />
      <a
        href="/changelog/feed.xml"
        className="mt-6 inline-flex items-center gap-1.5 text-[14px] font-medium text-muted-ink transition-colors hover:text-ink"
      >
        <Rss aria-hidden className="size-4" /> RSS feed
      </a>

      <ol className="mt-16">
        {ENTRIES.map((e) => (
          <li
            key={e.date}
            id={e.date}
            className="grid scroll-mt-28 gap-3 border-t border-hairline py-12 md:grid-cols-[180px_minmax(0,1fr)] md:gap-10"
          >
            <a href={`#${e.date}`} className="font-mono text-[13px] text-muted-ink hover:text-ink md:pt-1.5">
              <time dateTime={e.date}>{formatDate(e.date)}</time>
            </a>
            <article>
              <h2 className="text-2xl font-semibold tracking-tight text-ink">{e.title}</h2>
              <p className="mt-2 max-w-[64ch] text-[15.5px] leading-relaxed text-muted-ink">{e.summary}</p>
              <ul className="mt-5 max-w-[64ch] space-y-2 text-[15px] leading-relaxed text-ink">
                {e.items.map((it) => (
                  <li key={it} className="flex gap-3">
                    <span aria-hidden className="mt-[0.6em] size-1.5 flex-none rounded-full bg-iris" />
                    <span>{it}</span>
                  </li>
                ))}
              </ul>
            </article>
          </li>
        ))}
      </ol>
    </PageShell>
  )
}
