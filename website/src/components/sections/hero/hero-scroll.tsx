"use client"

// Apre il hero quando si inizia a scrollare e scrive le variabili CSS: --e (claim), --lift (finestra), --fade (testi di base),
// --x (riquadro che si allarga a tutto schermo alla fine dell'apertura). Misura anche, per ogni parola del claim,
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
    // Su mobile l'hero è fermo (testo sopra, finestra in miniatura sotto): niente apertura animata
    const mobile = window.matchMedia("(max-width: 760px)")
    const still = () => mq.matches || mobile.matches
    const win = el.querySelector<HTMLElement>(".hero-win")
    const claim = el.querySelector<HTMLElement>(".hero-claim")
    const claim1 = el.querySelector<HTMLElement>(".hero-claim1")
    const from = Array.from(el.querySelectorAll<HTMLElement>(".hero-claim [data-hw]"))
    const to = Array.from(el.querySelectorAll<HTMLElement>(".hero-claim1 [data-hw]"))

    // offsetLeft/Top ignorano i transform: le misure non dipendono dallo stato dell'animazione
    const measure = () => {
      // scala della finestra in miniatura: larghezza disponibile / 1100px disegnati
      if (win) el.style.setProperty("--k", (win.clientWidth / 1100).toFixed(4))
      if (!claim || !claim1 || from.length !== to.length) return
      from.forEach((w, i) => {
        const t = to[i]
        w.style.setProperty("--dx", (claim1.offsetLeft + t.offsetLeft - claim.offsetLeft - w.offsetLeft).toFixed(1))
        w.style.setProperty("--dy", (claim1.offsetTop + t.offsetTop - claim.offsetTop - w.offsetTop).toFixed(1))
        w.style.setProperty("--s", (t.offsetHeight / Math.max(1, w.offsetHeight)).toFixed(4))
      })
      el.setAttribute("data-m", "")
    }

    // Lo scroll non pilota l'animazione, la innesca: superata una piccola soglia l'apertura va avanti
    // da sola fino in fondo, tornando in cima si richiude. Così non resta mai a metà.
    const DURATION = 1100 // ms per l'apertura completa
    let p = 0 // avanzamento 0..1
    let target = 0
    let last = 0
    let raf = 0

    const paint = () => {
      const fade = 1 - clamp(p / 0.35)
      el.style.setProperty("--e", ease(clamp(p / 0.85)).toFixed(4))
      el.style.setProperty("--lift", ease(clamp((p - 0.1) / 0.8)).toFixed(4))
      el.style.setProperty("--fade", fade.toFixed(3))
      // nell'ultimo tratto dell'apertura il riquadro perde il margine bianco e gli angoli
      el.style.setProperty("--x", ease(clamp((p - 0.72) / 0.28)).toFixed(4))
      if (fade < 0.2) el.setAttribute("data-open", "")
      else el.removeAttribute("data-open")
    }

    const tick = (now: number) => {
      const dt = last ? now - last : 16
      last = now
      const step = dt / DURATION
      p = target > p ? Math.min(target, p + step) : Math.max(target, p - step)
      paint()
      raf = p === target ? 0 : requestAnimationFrame(tick)
      if (!raf) last = 0
    }

    // y: quanto si è scrollato dentro l'hero. Si apre oltre la soglia, si richiude solo in cima.
    const threshold = () => Math.min(48, window.innerHeight * 0.05)
    const readTarget = () => {
      const y = -el.getBoundingClientRect().top
      if (y > threshold()) return 1
      if (y <= 2) return 0
      return target
    }

    // Blocco dello scroll durante l'apertura: il primo gesto (con la sua inerzia) si ferma sullo stato
    // aperto invece di portare la pagina oltre l'hero. Dura quanto l'animazione e finché arrivano ancora
    // eventi di rotella ravvicinati (la coda dell'inerzia del trackpad), poi lo scroll torna libero.
    let lockY = -1
    let lockEnd = 0
    let lastInput = 0
    const locked = () => {
      if (lockY < 0) return false
      const now = performance.now()
      // la coda dell'inerzia si assorbe al massimo per 500ms dopo l'animazione, così un nuovo gesto
      // fatto subito dopo non va a vuoto
      if (now < lockEnd || (now - lastInput < 120 && now < lockEnd + 500)) return true
      lockY = -1
      return false
    }
    const lock = () => {
      // fermo appena oltre la soglia: il riquadro sticky è identico in tutto il tratto, e così dopo
      // l'apertura resta intero il tratto in cui la finestra aperta resta ferma prima della sezione dopo
      lockY = Math.round(el.offsetTop + threshold() + 1)
      lockEnd = performance.now() + DURATION
      lastInput = performance.now()
      if (window.scrollY !== lockY) window.scrollTo({ top: lockY, behavior: "instant" })
    }
    const swallow = (e: Event) => {
      if (!locked()) return
      lastInput = performance.now()
      if (e.cancelable) e.preventDefault()
    }
    const KEYS = new Set([" ", "PageDown", "PageUp", "ArrowDown", "ArrowUp", "End", "Home"])
    const onKey = (e: KeyboardEvent) => {
      if (KEYS.has(e.key)) swallow(e)
    }

    const onScroll = () => {
      if (locked()) {
        if (Math.abs(window.scrollY - lockY) > 1) window.scrollTo({ top: lockY, behavior: "instant" })
        return
      }
      if (still()) {
        for (const v of ["--e", "--lift", "--fade", "--x"]) el.style.removeProperty(v)
        el.removeAttribute("data-open")
        return
      }
      const next = readTarget()
      if (next === target) return
      target = next
      if (target === 1 && p === 0) lock()
      if (!raf) raf = requestAnimationFrame(tick)
    }

    // Pagina aperta già scrollata (ricarica, link a un'ancora): stato finale subito, senza animazione
    const init = () => {
      if (still()) return onScroll()
      target = readTarget()
      p = target
      paint()
    }
    const onResize = () => {
      measure()
      onScroll()
    }

    measure()
    init()
    document.fonts?.ready.then(measure)
    const ro = new ResizeObserver(measure)
    if (claim) ro.observe(claim)
    if (win) ro.observe(win)
    window.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("wheel", swallow, { passive: false })
    window.addEventListener("touchmove", swallow, { passive: false })
    window.addEventListener("keydown", onKey)
    window.addEventListener("resize", onResize)
    mq.addEventListener("change", init)
    mobile.addEventListener("change", init)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("wheel", swallow)
      window.removeEventListener("touchmove", swallow)
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("resize", onResize)
      mq.removeEventListener("change", init)
      mobile.removeEventListener("change", init)
    }
  }, [targetId])
  return null
}
