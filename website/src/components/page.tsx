// Building blocks of the inner pages (agents, docs, changelog, privacy): header, sections and text typography.
// All server components: the content arrives complete in the HTML.
import type { ReactNode } from "react"
import { SiteFooter } from "@/components/site-footer"
import { cn } from "@/lib/utils"

export function PageShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <>
      <main className={cn("mx-auto w-full max-w-5xl px-4 pt-32 pb-24 sm:px-8 sm:pt-40", className)}>{children}</main>
      <SiteFooter />
    </>
  )
}

export function PageHeader({ eyebrow, title, lead }: { eyebrow: string; title: ReactNode; lead?: ReactNode }) {
  return (
    <header className="max-w-3xl">
      <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-iris">{eyebrow}</p>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight text-balance text-ink sm:text-6xl">{title}</h1>
      {lead ? <p className="mt-5 text-lg leading-relaxed text-pretty text-muted-ink sm:text-xl">{lead}</p> : null}
    </header>
  )
}

export function Section({
  id,
  title,
  intro,
  children,
  className,
}: {
  id?: string
  title: ReactNode
  intro?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className={cn("scroll-mt-28", className)}>
      <h2 id={id ? `${id}-title` : undefined} className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
        {title}
      </h2>
      {intro ? <p className="mt-3 max-w-[68ch] text-[15.5px] leading-relaxed text-muted-ink">{intro}</p> : null}
      {children}
    </section>
  )
}

/** Long text: paragraphs, lists, links and inline code in a single style. */
export function Prose({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "max-w-[68ch] space-y-4 text-[15.5px] leading-[1.7] text-muted-ink",
        "[&_strong]:font-semibold [&_strong]:text-ink",
        "[&_a]:font-medium [&_a]:text-iris [&_a]:underline-offset-2 hover:[&_a]:underline",
        "[&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5",
        "[&_li]:pl-1 [&_li::marker]:text-hairline",
        "[&_h3]:pt-4 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:tracking-tight [&_h3]:text-ink",
        className,
      )}
    >
      {children}
    </div>
  )
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-[5px] border border-hairline bg-frame px-1.5 py-0.5 font-mono text-[0.86em] text-ink">
      {children}
    </code>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.6em] items-center justify-center rounded-[5px] border border-hairline bg-surface px-1.5 py-0.5 font-mono text-[0.82em] text-ink shadow-[0_1px_0_var(--color-hairline)]">
      {children}
    </kbd>
  )
}

export function CodeBlock({ title, children }: { title?: string; children: string }) {
  return (
    <figure className="my-5 overflow-hidden rounded-xl border border-hairline bg-frame">
      {title ? (
        <figcaption className="border-b border-hairline px-4 py-2 font-mono text-[11.5px] text-muted-ink">{title}</figcaption>
      ) : null}
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-[1.65] text-ink">
        <code>{children}</code>
      </pre>
    </figure>
  )
}
