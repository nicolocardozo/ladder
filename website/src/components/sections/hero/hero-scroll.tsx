"use client"

// Collega lo scroll alle variabili CSS del hero (--e claim, --lift finestra, --fade testi).
// Con prefers-reduced-motion non fa nulla: il CSS mostra già lo stato finale.
import { useEffect } from "react"

const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v))
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

export function HeroScroll({ targetId }: { targetId: string }) {
  useEffect(() => {
    const el = document.getElementById(targetId)
    if (!el) return
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    let raf = 0
    const update = () => {
      raf = 0
      if (mq.matches) {
        for (const v of ["--e", "--lift", "--fade"]) el.style.removeProperty(v)
        el.removeAttribute("data-open")
        return
      }
      const span = el.offsetHeight - window.innerHeight
      const p = clamp(-el.getBoundingClientRect().top / (span * 0.8))
      const fade = 1 - clamp(p / 0.35)
      el.style.setProperty("--e", ease(p).toFixed(4))
      el.style.setProperty("--lift", ease(clamp((p - 0.12) / 0.88)).toFixed(4))
      el.style.setProperty("--fade", fade.toFixed(3))
      if (fade < 0.2) el.setAttribute("data-open", "")
      else el.removeAttribute("data-open")
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    window.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onScroll)
    mq.addEventListener("change", onScroll)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onScroll)
      mq.removeEventListener("change", onScroll)
    }
  }, [targetId])
  return null
}
