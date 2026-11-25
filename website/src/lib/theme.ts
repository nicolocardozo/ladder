"use client"

// Site theme: follows the system until the user chooses with the switch (choice saved in localStorage).
// The "dark" class on <html> is set by the layout's inline script before first paint.
import { useSyncExternalStore } from "react"

export type Theme = "light" | "dark"
export const THEME_KEY = "ladder-theme"

const subscribe = (cb: () => void) => {
  const mo = new MutationObserver(cb)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => mo.disconnect()
}
const read = (): Theme => (document.documentElement.classList.contains("dark") ? "dark" : "light")

/** Current theme; on the server it is always "light". */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, () => "light")
}

/** Choice saved by the user, or null if the site follows the system. */
function stored(): Theme | null {
  try {
    const t = localStorage.getItem(THEME_KEY)
    return t === "dark" || t === "light" ? t : null
  } catch {
    return null
  }
}

/** Until a saved choice exists, it follows system theme changes while the page is open. */
export function followSystem() {
  const mq = window.matchMedia("(prefers-color-scheme: dark)")
  const apply = () => {
    if (!stored()) document.documentElement.classList.toggle("dark", mq.matches)
  }
  mq.addEventListener("change", apply)
  return () => mq.removeEventListener("change", apply)
}

export function setTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark")
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // storage not available: the theme only applies to this visit
  }
}
