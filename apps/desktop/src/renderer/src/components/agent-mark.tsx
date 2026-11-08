// Segno del provider: dice chi sta lavorando senza aprire la sessione (DESIGN.md, "Agent Mark").
// Icone monocromatiche (set di LobeHub, MIT) disegnate con una maschera nel colore del testo, così restano calme
// e seguono ogni tema. Per gli agenti ACP: l'icona del registro, poi un'icona nota per nome, poi l'iniziale.
import ampIcon from '@lobehub/icons-static-svg/icons/amp.svg?url'
import claudeIcon from '@lobehub/icons-static-svg/icons/claudecode.svg?url'
import clineIcon from '@lobehub/icons-static-svg/icons/cline.svg?url'
import codexIcon from '@lobehub/icons-static-svg/icons/codex.svg?url'
import copilotIcon from '@lobehub/icons-static-svg/icons/copilot.svg?url'
import cursorIcon from '@lobehub/icons-static-svg/icons/cursor.svg?url'
import geminiIcon from '@lobehub/icons-static-svg/icons/geminicli.svg?url'
import gooseIcon from '@lobehub/icons-static-svg/icons/goose.svg?url'
import grokIcon from '@lobehub/icons-static-svg/icons/grok.svg?url'
import kimiIcon from '@lobehub/icons-static-svg/icons/kimi.svg?url'
import kiroIcon from '@lobehub/icons-static-svg/icons/kiro.svg?url'
import mistralIcon from '@lobehub/icons-static-svg/icons/mistral.svg?url'
import opencodeIcon from '@lobehub/icons-static-svg/icons/opencode.svg?url'
import qwenIcon from '@lobehub/icons-static-svg/icons/qwen.svg?url'
import type { AgentId, AgentStatus } from '@shared/protocol'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

/** Agenti noti per nome: valgono anche per le voci ACP aggiunte a mano (codex-acp, claude-acp, gemini…). */
const KNOWN: [RegExp, string][] = [
  [/claude/i, claudeIcon],
  [/codex/i, codexIcon],
  [/gemini/i, geminiIcon],
  [/opencode/i, opencodeIcon],
  [/goose/i, gooseIcon],
  [/qwen/i, qwenIcon],
  [/\bamp\b|amp-/i, ampIcon],
  [/cline/i, clineIcon],
  [/copilot/i, copilotIcon],
  [/cursor/i, cursorIcon],
  [/kimi/i, kimiIcon],
  [/mistral|vibe/i, mistralIcon],
  [/grok/i, grokIcon],
  [/kiro/i, kiroIcon]
]

export function agentIcon(agent: AgentId, status?: AgentStatus | null): string | null {
  if (status?.icon) return status.icon
  const key = `${agent} ${status?.name ?? ''}`
  return KNOWN.find(([pattern]) => pattern.test(key))?.[1] ?? null
}

/** Segno da 12–16 px nel colore del testo intorno (di solito tenue). */
export function AgentMark({ agent, size = 14, className, title }: { agent: AgentId; size?: number; className?: string; title?: string }) {
  const status = useApp((s) => s.agents.find((a) => a.agent === agent) ?? null)
  const icon = agentIcon(agent, status)
  const label = title ?? status?.name ?? agent
  if (!icon) {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className={cn('inline-grid shrink-0 place-items-center rounded-[4px] bg-current/15 font-semibold leading-none', className)}
        style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.62)) }}
      >
        <span className="text-[length:inherit]">{label.slice(0, 1).toUpperCase()}</span>
      </span>
    )
  }
  const mask = `url("${icon}")`
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn('inline-block shrink-0 bg-current', className)}
      style={{ width: size, height: size, maskImage: mask, WebkitMaskImage: mask, maskSize: 'contain', WebkitMaskSize: 'contain', maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat', maskPosition: 'center', WebkitMaskPosition: 'center' }}
    />
  )
}

/** "Opus 5.5", "GPT-6 Luna": il nome del modello come lo mostra l'agente, o ricavato dall'id. */
export function modelLabel(status: AgentStatus | null | undefined, model: string | null | undefined): string | null {
  if (!model) return null
  const known = status?.models.find((m) => m.id === model)?.label
  if (known) return known
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(model)
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
  if (/^(opus|sonnet|haiku|fable)$/i.test(model)) return `${model[0].toUpperCase()}${model.slice(1)}`
  const gpt = /^gpt-([\d.]+)-?(.*)$/i.exec(model)
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${gpt[2].split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')}` : ''}`
  return model
}

/** Agente e modello di una sessione, per righe, tab e intestazioni: "Claude Code · Opus 5.5". */
export function useAgentLine(agent: AgentId, model: string | null): { name: string; model: string | null } {
  const status = useApp((s) => s.agents.find((a) => a.agent === agent) ?? null)
  return { name: status?.name ?? (agent === 'claude-code' ? 'Claude Code' : agent === 'codex' ? 'Codex' : agent.replace(/^acp:/, '')), model: modelLabel(status, model) }
}
