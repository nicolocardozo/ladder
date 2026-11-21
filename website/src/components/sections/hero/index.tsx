// Hero a riquadro: testi server-rendered (unico h1 della pagina), puntini e finestra animata
// sono client component caricati dopo. Lo scroll guida claim e finestra via variabili CSS.
import { ArrowDown } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { SITE } from "@/lib/site"
import { cn } from "@/lib/utils"
import "./hero.css"
import { HeroWaves, HeroWindow } from "./hero-lazy"
import { HeroScroll } from "./hero-scroll"

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
            <span>Every agent, every repo,</span> <span className="hero-iris">one calm window.</span>
          </h1>
        </div>
        {/* Stessa frase su una riga, centrata: compare quando sale la finestra (decorativa, l'h1 è uno solo) */}
        <p className="hero-claim1" aria-hidden>
          Every agent, every repo, <span>one calm window.</span>
        </p>

        <p className="hero-foot hero-foot-l">
          Ladder is a macOS workspace for coding with agents across many repositories. See who is working and who is
          waiting for you, and step in with one keystroke.
        </p>
        <div className="hero-foot hero-foot-r">
          <a
            href={SITE.downloadUrl}
            className={cn(buttonVariants({ variant: "outline" }), cta, "border-hairline bg-white hover:bg-white")}
          >
            Download for macOS
          </a>
          <a
            href={SITE.downloadUrl}
            aria-label="Download Ladder for macOS"
            className={cn(buttonVariants(), "size-[42px] rounded-[10px] bg-ink text-white hover:bg-ink/85")}
          >
            <ArrowDown className="size-4" aria-hidden />
          </a>
        </div>

        <div className="hero-win">
          <HeroWindow />
        </div>
      </div>
      <HeroScroll targetId="hero" />
    </section>
  )
}
