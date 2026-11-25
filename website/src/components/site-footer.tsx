import Link from "next/link"
import { cacheLife } from "next/cache"
import { SITE } from "@/lib/site"

const LINKS = [
  { href: "/changelog", label: "Changelog" },
  { href: "/docs", label: "Docs" },
  { href: "/privacy", label: "Privacy" },
] as const

// Current year, recomputed at most once a day (with cacheComponents the date is cached)
async function Year() {
  "use cache"
  cacheLife("days")
  return new Date().getFullYear()
}

export function SiteFooter() {
  return (
    <footer className="mx-auto flex w-full max-w-[95%] flex-col gap-6 px-5 py-10 sm:px-7 text-[12.5px] text-muted-ink sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-1">
        <p className="font-medium text-ink">
          © <Year /> Ladder
        </p>
        <p>Made for people who work with agents all day.</p>
        <p className="max-w-md pt-2 leading-relaxed">
          Ladder is an independent project, not affiliated with or endorsed by Anthropic, OpenAI, Google or the
          makers of the other agents it works with. Product names belong to their respective owners.
        </p>
      </div>
      <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="hover:text-ink">
            {l.label}
          </Link>
        ))}
        {SITE.githubUrl ? (
          <a href={SITE.githubUrl} className="hover:text-ink">
            GitHub
          </a>
        ) : null}
      </nav>
    </footer>
  )
}
