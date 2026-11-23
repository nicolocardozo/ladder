"use client"

// Tema del sito: segue il sistema finché l'utente non sceglie con l'interruttore (scelta salvata in localStorage).
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

/** Scelta salvata dall'utente, o null se il sito segue il sistema. */
function stored(): Theme | null {
  try {
    const t = localStorage.getItem(THEME_KEY)
    return t === "dark" || t === "light" ? t : null
  } catch {
    return null
  }
}

/** Finché non c'è una scelta salvata, segue i cambi di tema del sistema mentre la pagina è aperta. */
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
    // storage non disponibile: il tema vale solo per questa visita
  }
}
