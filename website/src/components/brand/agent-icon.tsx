import { AGENT_ICON_PATHS } from "./agent-icons"

export type AgentId = keyof typeof AGENT_ICON_PATHS | (string & {})

type AgentIconProps = {
  agent: AgentId
  /** Nome mostrato, usato per l'iniziale di fallback */
  name?: string
  className?: string
}

// Icona dell'agente in inline SVG con currentColor; senza icona nota mostra l'iniziale
export function AgentIcon({ agent, name, className = "size-5" }: AgentIconProps) {
  const paths = AGENT_ICON_PATHS[agent]

  if (!paths) {
    const initial = (name ?? agent).trim().charAt(0).toUpperCase()
    return (
      <span
        aria-hidden
        className={`inline-flex items-center justify-center rounded-sm border border-current text-[0.6em] font-semibold leading-none ${className}`}
      >
        {initial}
      </span>
    )
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden
      className={`flex-none ${className}`}
    >
      {paths.map((p) => (
        <path key={p.d} d={p.d} clipRule={p.clipRule} />
      ))}
    </svg>
  )
}
