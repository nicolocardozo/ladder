"use client"

// Tema del sito: chiaro di default, scuro solo se scelto (salvato in localStorage).
// La classe "dark" su <html> la mette lo script inline del layout prima del primo paint.
import { useSyncExternalStore } from "react"

export type Theme = "light" | "dark"
export const THEME_KEY = "ladder-theme"

const subscribe = (cb: () => void) => {
  const mo = new MutationObserver(cb)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => mo.disconnect()
}
const read = (): Theme => (document.documentElement.classList.contains("dark") ? "dark" : "light")

/** Tema corrente; sul server vale sempre "light". */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, () => "light")
}

export function setTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark")
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // storage non disponibile: il tema vale solo per questa visita
  }
}
