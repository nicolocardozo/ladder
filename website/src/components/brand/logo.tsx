import { MARK_PATH, MARK_VIEWBOX, WORDMARK_PATHS, WORDMARK_VIEWBOX } from "./logo-paths"

type LogoProps = {
  /** "wordmark" = logo orizzontale, "mark" = solo simbolo */
  variant?: "wordmark" | "mark"
  className?: string
  /** Se true il logo è decorativo (nascosto agli screen reader) */
  decorative?: boolean
}

// Logo inline: prende il colore da currentColor, così funziona su fondo chiaro e scuro
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
