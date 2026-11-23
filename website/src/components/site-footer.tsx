import Link from "next/link"
import { SITE } from "@/lib/site"

const LINKS = [
  { href: "/changelog", label: "Changelog" },
  { href: "/docs", label: "Docs" },
  { href: "/privacy", label: "Privacy" },
] as const

export function SiteFooter() {
  return (
    <footer className="mx-auto flex w-full max-w-[1800px] flex-col gap-6 px-3 py-10 text-[12.5px] text-muted-ink sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-1">
        <p className="font-medium text-ink">© Ladder</p>
        <p>Made for people who work with agents all day.</p>
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
