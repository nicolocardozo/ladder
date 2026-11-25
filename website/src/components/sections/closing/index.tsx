import { ArrowRight } from "lucide-react"
import { Logo } from "@/components/brand/logo"
import { CTA, DOWNLOADS } from "@/lib/site"
import { DownloadLink } from "@/components/download-link"

export function Closing() {
  return (
    <section id="closing" className="px-3">
      {/* Panel with the same radius as the hero (26px), colors inverted relative to the hero: Circuit background with light dots */}
      <div className="relative isolate overflow-hidden rounded-[22px] sm:rounded-[30px] bg-c-bg px-6 py-24 dark:ring-1 dark:ring-white/8 text-c-text sm:py-[120px]">
        {/* Light iris veil */}
        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-[radial-gradient(60%_70%_at_50%_45%,rgba(123,92,240,0.16),transparent_70%)]"
        />
        {/* Static dots, no reaction to the cursor */}
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
            <DownloadLink
              className="inline-flex h-12 items-center gap-2 rounded-lg bg-c-text px-6 text-[15px] font-medium text-c-bg transition-colors hover:bg-white"
            >
              {CTA.label}
            </DownloadLink>
            <DownloadLink
              aria-label={CTA.aria}
              className="inline-flex size-12 items-center justify-center rounded-lg border border-c-border text-c-text transition-colors hover:bg-c-selection"
            >
              <ArrowRight aria-hidden className="size-5" />
            </DownloadLink>
          </div>
          {/* The button picks the right DMG by itself; here is the alternative if it guessed wrong */}
          <p className="mt-5 text-sm text-c-muted">
            For macOS on{" "}
            <a href={DOWNLOADS.arm64} className="underline decoration-c-border underline-offset-4 hover:text-c-text">
              Apple Silicon
            </a>{" "}
            and{" "}
            <a href={DOWNLOADS.x64} className="underline decoration-c-border underline-offset-4 hover:text-c-text">
              Intel
            </a>
          </p>
        </div>
      </div>
    </section>
  )
}
