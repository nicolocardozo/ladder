"use client"

import { Moon, Sun } from "lucide-react"
import { setTheme, useTheme } from "@/lib/theme"

// Interruttore chiaro/scuro nella nav
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme()
  const next = theme === "dark" ? "light" : "dark"
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={next === "dark" ? "Switch to dark theme" : "Switch to light theme"}
      className={className}
    >
      {theme === "dark" ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
    </button>
  )
}
