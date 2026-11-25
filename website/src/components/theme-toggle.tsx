"use client"

import { useEffect } from "react"
import { Moon, Sun } from "lucide-react"
import { followSystem, setTheme, useTheme } from "@/lib/theme"

// Light/dark toggle in the nav
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme()
  useEffect(followSystem, [])
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
