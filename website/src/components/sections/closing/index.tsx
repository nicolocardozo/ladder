import { ArrowRight } from "lucide-react"
import { Logo } from "@/components/brand/logo"
import { CTA } from "@/lib/site"

export function Closing() {
  return (
    <section id="closing" className="px-3">
      {/* Riquadro con lo stesso raggio dell'hero (26px), colori invertiti rispetto all'hero: fondo Circuit con puntini chiari */}
      <div className="relative isolate overflow-hidden rounded-[22px] sm:rounded-[30px] bg-c-bg px-6 py-24 dark:ring-1 dark:ring-white/8 text-c-text sm:py-[120px]">
        {/* Velo iris leggero */}
        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-[radial-gradient(60%_70%_at_50%_45%,rgba(123,92,240,0.16),transparent_70%)]"
        />
        {/* Puntini statici, senza reazione al cursore */}
        <div
          aria-hidden
          className="absolute inset-0 -z-20 bg-[radial-gradient(circle,#4A4357_1.1px,transparent_1.6px)] [background-size:22px_22px] opacity-70 [mask-image:radial-gradient(70%_80%_at_50%_50%,#000,transparent)]"
        />

        <div className="relative mx-auto flex max-w-3xl flex-col items-center text-center">
          <Logo variant="mark" className="h-12 w-auto text-c-text" />
          <h2 className="mt-10 text-4xl font-semibold tracking-tight text-c-text sm:text-6xl">
            Stop juggling terminals. <span className="text-c-accent">Start running a team.</span>
          </h2>
          <div className="mt-10 flex items-center gap-3">
            <a
              href={CTA.href}
              className="inline-flex h-12 items-center gap-2 rounded-lg bg-c-text px-6 text-[15px] font-medium text-c-bg transition-colors hover:bg-white"
            >
              {CTA.label}
            </a>
            <a
              href={CTA.href}
              aria-label={CTA.aria}
              className="inline-flex size-12 items-center justify-center rounded-lg border border-c-border text-c-text transition-colors hover:bg-c-selection"
            >
              <ArrowRight aria-hidden className="size-5" />
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}
