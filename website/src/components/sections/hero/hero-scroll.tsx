"use client"

// Collega lo scroll alle variabili CSS del hero: --e (claim), --lift (finestra), --fade (testi di base),
// --x (riquadro che si allarga a tutto schermo alla fine). Misura anche, per ogni parola del claim,
// lo spostamento e la scala verso la sua posizione nel claim su una riga (--dx, --dy, --s).
// Con prefers-reduced-motion lo scroll non anima nulla: il CSS mostra già lo stato finale.
import { useEffect } from "react"

const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v))
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

export function HeroScroll({ targetId }: { targetId: string }) {
  useEffect(() => {
    const el = document.getElementById(targetId)
    if (!el) return
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    const claim = el.querySelector<HTMLElement>(".hero-claim")
    const claim1 = el.querySelector<HTMLElement>(".hero-claim1")
    const from = Array.from(el.querySelectorAll<HTMLElement>(".hero-claim [data-hw]"))
    const to = Array.from(el.querySelectorAll<HTMLElement>(".hero-claim1 [data-hw]"))

    // offsetLeft/Top ignorano i transform: le misure non dipendono dallo stato dell'animazione
    const measure = () => {
      if (!claim || !claim1 || from.length !== to.length) return
      from.forEach((w, i) => {
        const t = to[i]
        w.style.setProperty("--dx", (claim1.offsetLeft + t.offsetLeft - claim.offsetLeft - w.offsetLeft).toFixed(1))
        w.style.setProperty("--dy", (claim1.offsetTop + t.offsetTop - claim.offsetTop - w.offsetTop).toFixed(1))
        w.style.setProperty("--s", (t.offsetHeight / Math.max(1, w.offsetHeight)).toFixed(4))
      })
      el.setAttribute("data-m", "")
    }

    let raf = 0
    const update = () => {
      raf = 0
      if (mq.matches) {
        for (const v of ["--e", "--lift", "--fade", "--x"]) el.style.removeProperty(v)
        el.removeAttribute("data-open")
        return
      }
      const span = el.offsetHeight - window.innerHeight
      const q = clamp(-el.getBoundingClientRect().top / span)
      const p = clamp(q / 0.8)
      const fade = 1 - clamp(p / 0.35)
      el.style.setProperty("--e", ease(p).toFixed(4))
      el.style.setProperty("--lift", ease(clamp((p - 0.12) / 0.88)).toFixed(4))
      el.style.setProperty("--fade", fade.toFixed(3))
      // a finestra aperta il riquadro perde il margine bianco e gli angoli
      el.style.setProperty("--x", ease(clamp((q - 0.8) / 0.16)).toFixed(4))
      if (fade < 0.2) el.setAttribute("data-open", "")
      else el.removeAttribute("data-open")
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    const onResize = () => {
      measure()
      onScroll()
    }

    measure()
    update()
    document.fonts?.ready.then(measure)
    const ro = new ResizeObserver(measure)
    if (claim) ro.observe(claim)
    window.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onResize)
    mq.addEventListener("change", onScroll)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onResize)
      mq.removeEventListener("change", onScroll)
    }
  }, [targetId])
  return null
}
