import { AGENT_ICON_PATHS } from "./agent-icons"

export type AgentId = keyof typeof AGENT_ICON_PATHS | (string & {})

type AgentIconProps = {
  agent: AgentId
  /** Display name, used for the fallback initial */
  name?: string
  className?: string
}

// Third-party logos stay off until their owners' brand guidelines are checked: every agent shows its initial.
const SHOW_AGENT_LOGOS = false

// Agent icon as inline SVG with currentColor; without a known icon (or with logos off) it shows the initial
export function AgentIcon({ agent, name, className = "size-5" }: AgentIconProps) {
  const paths = SHOW_AGENT_LOGOS ? AGENT_ICON_PATHS[agent] : undefined

  if (!paths) {
    const initial = (name ?? agent).trim().charAt(0).toUpperCase()
    return (
      <span
        aria-hidden
        className={`inline-flex flex-none items-center justify-center rounded-sm border border-current text-[0.6em] font-semibold leading-none ${className}`}
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
