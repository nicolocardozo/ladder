import { ArrowDown } from "lucide-react"
import { Logo } from "@/components/brand/logo"
import { SITE } from "@/lib/site"
import { ClosingDots } from "./dots"

export function Closing() {
  return (
    <section id="closing" className="px-3">
      {/* Riquadro con lo stesso raggio dell'hero (26px), colori invertiti rispetto all'hero: fondo Circuit con puntini chiari */}
      <div className="relative isolate overflow-hidden rounded-[22px] sm:rounded-[30px] bg-c-bg px-6 py-24 text-c-text sm:py-[120px]">
        {/* Velo iris leggero */}
        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-[radial-gradient(60%_70%_at_50%_45%,rgba(123,92,240,0.16),transparent_70%)]"
        />
        {/* Pattern statico (primo paint e movimento ridotto); DotGrid lo sostituisce appena pronto */}
        <div
          aria-hidden
          className="absolute inset-0 -z-20 bg-[radial-gradient(circle,#4A4357_1.1px,transparent_1.6px)] [background-size:22px_22px] opacity-70 [mask-image:radial-gradient(70%_80%_at_50%_50%,#000,transparent)]"
        />
        <div aria-hidden className="absolute inset-0 -z-10 hidden min-[760px]:block">
          <ClosingDots />
        </div>

        <div className="relative mx-auto flex max-w-3xl flex-col items-center text-center">
          <Logo variant="mark" className="h-12 w-auto text-c-text" />
          <h2 className="mt-10 text-4xl font-semibold tracking-tight text-c-text sm:text-6xl">
            Stop juggling terminals. Start running a team.
          </h2>
          <div className="mt-10 flex items-center gap-3">
            <a
              href={SITE.downloadUrl}
              className="inline-flex h-12 items-center gap-2 rounded-lg bg-c-text px-6 text-[15px] font-medium text-c-bg transition-colors hover:bg-white"
            >
              Download for macOS
            </a>
            <a
              href={SITE.downloadUrl}
              aria-label="Download Ladder"
              className="inline-flex size-12 items-center justify-center rounded-lg border border-c-border text-c-text transition-colors hover:bg-c-selection"
            >
              <ArrowDown aria-hidden className="size-5" />
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}
