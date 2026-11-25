// Boxed hero: server-rendered texts (the page's only h1), dots and animated window
// are client components loaded afterwards. Scrolling drives claim and window via CSS variables.
import { Fragment } from "react"
import { ArrowRight } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { CTA } from "@/lib/site"
import { cn } from "@/lib/utils"
import "./hero.css"
import { HeroWaves, HeroWindow } from "./hero-lazy"
import { HeroScroll } from "./hero-scroll"
import { DownloadLink } from "@/components/download-link"

const LINE1 = "Every agent, every repo,"
const LINE2 = "one calm window."

// Each word in its own span, so it can move by itself to the final position
const words = (text: string) =>
  text.split(" ").map((w, i, arr) => (
    <Fragment key={w + i}>
      <span className="hw" data-hw>
        {w}
      </span>
      {i < arr.length - 1 ? " " : null}
    </Fragment>
  ))

const cta = "h-[42px] rounded-[10px] px-4 text-xs font-semibold uppercase tracking-[0.06em]"

export function Hero() {
  return (
    <section id="hero" className="hero" aria-labelledby="hero-title">
      <div className="hero-frame">
        <div className="hero-dots" aria-hidden>
          <HeroWaves />
        </div>

        <div className="hero-claim">
          <h1 id="hero-title">
            <span>{words(LINE1)}</span> <span className="hero-iris">{words(LINE2)}</span>
          </h1>
        </div>
        {/* Final layout of the claim (one line, centered), invisible: HeroScroll measures the words in it
            and moves each of them from the h1 toward its own place. */}
        <p className="hero-claim1" aria-hidden>
          {words(LINE1)} <span className="hero-iris">{words(LINE2)}</span>
        </p>

        <p className="hero-foot hero-foot-l">
          Ladder is a macOS workspace for coding with agents across many repositories. See who is working and who is
          waiting for you, and step in with one keystroke.
        </p>
        <div className="hero-foot hero-foot-r">
          <DownloadLink
            className={cn(buttonVariants({ variant: "outline" }), cta, "border-hairline bg-surface hover:bg-surface")}
          >
            {CTA.label}
          </DownloadLink>
          <DownloadLink
            aria-label={CTA.aria}
            className={cn(buttonVariants(), "size-[42px] rounded-[10px] bg-ink text-page hover:bg-ink/85")}
          >
            <ArrowRight className="size-4" aria-hidden />
          </DownloadLink>
        </div>

        {/* hero-win-in: on mobile the window is drawn at desktop width and scaled down (--k) */}
        <div className="hero-win">
          <div className="hero-win-in">
            <HeroWindow />
          </div>
        </div>
      </div>
      <HeroScroll targetId="hero" />
    </section>
  )
}
