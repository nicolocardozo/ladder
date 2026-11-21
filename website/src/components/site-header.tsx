// Header fisso: logo senza sfondo a sinistra, nav compatta a destra (pillola bianca sfocata).
import Link from "next/link"
import { Logo } from "@/components/brand/logo"
import { SITE } from "@/lib/site"

const LINKS = [
  { href: "/#features", label: "Product" },
  { href: "/agents", label: "Agents" },
  { href: "/changelog", label: "Changelog" },
  { href: "/docs", label: "Docs" },
]

const item =
  "inline-flex h-[34px] items-center rounded-[9px] px-3 text-[13.5px] font-medium leading-none transition-colors hover:bg-frame/80"

export function SiteHeader() {
  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50 flex items-center justify-between px-5 pt-[calc(env(safe-area-inset-top,0px)+20px)] sm:px-7 sm:pt-[calc(env(safe-area-inset-top,0px)+28px)]">
      <Link href="/" aria-label="Ladder, home" className="pointer-events-auto flex items-center text-iris">
        <Logo className="h-6 w-auto" decorative />
      </Link>
      <nav
        aria-label="Main"
        className="pointer-events-auto flex h-[46px] items-center gap-0.5 rounded-[14px] border border-hairline bg-white/75 p-1.5 shadow-[0_1px_2px_rgb(24_20_36/0.04)] backdrop-blur-[14px] backdrop-saturate-150"
      >
        <div className="hidden items-center gap-0.5 md:flex">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={item}>
              {l.label}
            </Link>
          ))}
          <a href={SITE.githubUrl} className={item}>
            GitHub
          </a>
        </div>
        <a
          href={SITE.downloadUrl}
          className="inline-flex h-[34px] items-center rounded-[9px] bg-ink px-3.5 text-[13.5px] font-medium leading-none text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.12),0_1px_2px_rgb(24_20_36/0.2)] transition hover:-translate-y-px hover:bg-[#2a2340]"
        >
          Download
        </a>
      </nav>
    </header>
  )
}
