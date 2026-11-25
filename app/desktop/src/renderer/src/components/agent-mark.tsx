// Provider mark: shows who is working without opening the session (DESIGN.md, "Agent Mark").
// Monochrome icons (LobeHub set, MIT) drawn with a mask in the text color, so they stay calm
// and follow every theme. For ACP agents: the registry icon, then a known icon by name, then the initial.
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

/** Agents known by name: they also apply to ACP entries added by hand (codex-acp, claude-acp, gemini…). */
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

/** 12–16 px mark in the surrounding text color (usually muted). */
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
        <span className="text-[length:inherit]">{firstGrapheme(label).toUpperCase()}</span>
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

/** "Opus 5.5", "GPT-6 Luna": the model name as the agent shows it, or derived from the id. */
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

/** A session's agent and model, for rows, tabs and headers: "Claude Code · Opus 5.5". */
export function useAgentLine(agent: AgentId, model: string | null): { name: string; model: string | null } {
  const status = useApp((s) => s.agents.find((a) => a.agent === agent) ?? null)
  return { name: status?.name ?? (agent === 'claude-code' ? 'Claude' : agent === 'codex' ? 'Codex' : agent.replace(/^acp:/, '')), model: modelLabel(status, model) }
}

/** First grapheme of a text (an emoji or an accented letter stays whole). */
export const firstGrapheme = (text: string): string =>
  typeof Intl.Segmenter === 'function' ? ([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)][0]?.segment ?? '') : (Array.from(text)[0] ?? '')

/** Decorative mark of a service or another agent (hidden from assistive technology: the name sits next to it). Without an icon, the initial of `name`. */
export function MaskIcon({ icon, name, size = 14, className }: { icon: string | null; name: string; size?: number; className?: string }) {
  if (!icon) {
    return (
      <span aria-hidden className={cn('inline-grid shrink-0 place-items-center rounded-[4px] bg-current/15 font-semibold leading-none', className)} style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.62)) }}>
        <span className="text-[length:inherit]">{firstGrapheme(name).toUpperCase()}</span>
      </span>
    )
  }
  const mask = `url("${icon}")`
  return (
    <span
      aria-hidden
      className={cn('inline-block shrink-0 bg-current', className)}
      style={{ width: size, height: size, maskImage: mask, WebkitMaskImage: mask, maskSize: 'contain', WebkitMaskSize: 'contain', maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat', maskPosition: 'center', WebkitMaskPosition: 'center' }}
    />
  )
}

/** Icon of another agent: the registry one if there is one, then a known one by name. */
export function otherAgentIcon(agent: { id: string; name: string; icon: string | null }): string | null {
  return agentIcon(`acp:${agent.id}`, { name: agent.name, icon: agent.icon } as AgentStatus)
}
