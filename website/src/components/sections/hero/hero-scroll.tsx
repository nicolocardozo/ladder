"use client"

// Opens the hero when scrolling starts and writes the CSS variables: --e (claim), --lift (window), --fade (base texts),
// --x (panel that widens to full screen at the end of the opening). It also measures, for each word of the claim,
// the offset and scale toward its position in the one-line claim (--dx, --dy, --s).
// With prefers-reduced-motion scrolling animates nothing: the CSS already shows the final state.
import { useEffect } from "react"

const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v))
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

export function HeroScroll({ targetId }: { targetId: string }) {
  useEffect(() => {
    const el = document.getElementById(targetId)
    if (!el) return
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    // On mobile the hero is static (text above, miniature window below): no animated opening
    const mobile = window.matchMedia("(max-width: 760px)")
    const still = () => mq.matches || mobile.matches
    const win = el.querySelector<HTMLElement>(".hero-win")
    const claim = el.querySelector<HTMLElement>(".hero-claim")
    const claim1 = el.querySelector<HTMLElement>(".hero-claim1")
    const from = Array.from(el.querySelectorAll<HTMLElement>(".hero-claim [data-hw]"))
    const to = Array.from(el.querySelectorAll<HTMLElement>(".hero-claim1 [data-hw]"))

    // offsetLeft/Top ignore transforms: the measurements don't depend on the animation state
    const measure = () => {
      // scale of the miniature window: available width / 1100px drawn
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

    // Scrolling doesn't drive the animation, it triggers it: past a small threshold the opening proceeds
    // on its own all the way, and scrolling back to the top closes it again. So it never stays halfway.
    const DURATION = 1100 // ms for the full opening
    let p = 0 // progress 0..1
    let target = 0
    let last = 0
    let raf = 0

    const paint = () => {
      const fade = 1 - clamp(p / 0.35)
      el.style.setProperty("--e", ease(clamp(p / 0.85)).toFixed(4))
      el.style.setProperty("--lift", ease(clamp((p - 0.1) / 0.8)).toFixed(4))
      el.style.setProperty("--fade", fade.toFixed(3))
      // in the last stretch of the opening the panel loses the white margin and the corners
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

    // y: how far we have scrolled into the hero. It opens past the threshold, closes only at the top.
    const threshold = () => Math.min(48, window.innerHeight * 0.05)
    const readTarget = () => {
      const y = -el.getBoundingClientRect().top
      if (y > threshold()) return 1
      if (y <= 2) return 0
      return target
    }

    // Scroll lock during the opening: the first gesture (with its inertia) stops on the open
    // state instead of carrying the page past the hero. It lasts as long as the animation and while closely spaced
    // wheel events keep arriving (the tail of trackpad inertia), then scrolling is free again.
    let lockY = -1
    let lockEnd = 0
    let lastInput = 0
    const locked = () => {
      if (lockY < 0) return false
      const now = performance.now()
      // the inertia tail is absorbed for at most 500ms after the animation, so a new gesture
      // made right after doesn't go nowhere
      if (now < lockEnd || (now - lastInput < 120 && now < lockEnd + 500)) return true
      lockY = -1
      return false
    }
    const lock = () => {
      // still just past the threshold: the sticky panel is identical throughout, and so after
      // the opening the stretch where the open window stays still before the next section stays whole
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

    // Page opened already scrolled (reload, link to an anchor): final state right away, no animation
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
