"use client"

import { useEffect, useRef } from "react"
import { gsap } from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"

gsap.registerPlugin(ScrollTrigger)

const PLAIN =
  "Agents write code faster than ever. Keeping track of them is the slow part: five terminals, three repos, and a request that sat unanswered for twenty minutes."
const HIGHLIGHT = "Ladder puts every agent in one window and tells you the moment one needs you."

const words = (text: string) => text.split(" ")

// Il testo è nell'HTML del server; il client colora solo le parole allo scroll.
export function StatementText() {
  const ref = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const mm = gsap.matchMedia()
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      const spans = Array.from(el.querySelectorAll<HTMLElement>("[data-w]"))
      const tl = gsap.timeline({
        defaults: { ease: "none" },
        scrollTrigger: { trigger: el, start: "top 85%", end: "bottom 60%", scrub: 0.3, invalidateOnRefresh: true },
      })
      spans.forEach((s, i) => {
        tl.to(s, { color: s.dataset.hl ? "#5525cf" : "#181424", duration: 1 }, i * 0.6)
      })
    })
    // l'hero sticky e le parti caricate dopo cambiano l'altezza della pagina: ricalcola le posizioni
    const refresh = () => ScrollTrigger.refresh()
    const ro = new ResizeObserver(refresh)
    ro.observe(document.body)
    window.addEventListener("load", refresh)
    return () => {
      ro.disconnect()
      window.removeEventListener("load", refresh)
      mm.revert()
    }
  }, [])

  const cls = "statement-word"
  return (
    <h2
      id="statement-title"
      ref={ref}
      className="mx-auto my-0 max-w-[24ch] text-[clamp(1.875rem,3.9vw,3.5rem)] leading-[1.14] font-semibold tracking-[-0.03em] text-pretty"
    >
      {words(PLAIN).map((w, i) => (
        <span key={`p${i}`}>
          <span data-w className={cls}>
            {w}
          </span>{" "}
        </span>
      ))}
      {words(HIGHLIGHT).map((w, i, arr) => (
        <span key={`h${i}`}>
          <span data-w data-hl="1" className={cls}>
            {w}
          </span>
          {i < arr.length - 1 ? " " : null}
        </span>
      ))}
      <style>{`.statement-word{color:#d2cddc}@media (prefers-reduced-motion:reduce){.statement-word{color:#181424}.statement-word[data-hl]{color:#5525cf}}`}</style>
    </h2>
  )
}
