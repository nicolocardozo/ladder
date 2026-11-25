import { MARK_PATH, MARK_VIEWBOX, WORDMARK_PATHS, WORDMARK_VIEWBOX } from "./logo-paths"

type LogoProps = {
  /** "wordmark" = horizontal logo, "mark" = symbol only */
  variant?: "wordmark" | "mark"
  className?: string
  /** If true the logo is decorative (hidden from screen readers) */
  decorative?: boolean
}

// Inline logo: takes its color from currentColor, so it works on light and dark backgrounds
export function Logo({ variant = "wordmark", className, decorative = false }: LogoProps) {
  const a11y = decorative
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": "Ladder" } as const)

  if (variant === "mark") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={MARK_VIEWBOX}
        fill="currentColor"
        className={className ?? "h-6 w-auto"}
        {...a11y}
      >
        <path fillRule="evenodd" d={MARK_PATH} />
      </svg>
    )
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={WORDMARK_VIEWBOX}
      fill="currentColor"
      className={className ?? "h-6 w-auto"}
      {...a11y}
    >
      {WORDMARK_PATHS.map((p) => (
        <path key={p.transform} fillRule="evenodd" transform={p.transform} d={p.d} />
      ))}
    </svg>
  )
}
