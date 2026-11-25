// "Open plan": the button that opens a plan as a commentable document.
import { FileText } from 'lucide-react'
import { t } from '@shared/i18n'
import { useApp } from '@/store/app-store'
import { useChatActions } from './chat-context'

export function OpenPlanButton({ text }: { text: string }) {
  const { sessionId } = useChatActions()
  // Advice children are read-only: no "Implement with…".
  const child = useApp((s) => Boolean(sessionId && s.sessions[sessionId]?.parent))
  if (!sessionId || child) return null
  return (
    <button
      type="button"
      onClick={() => useApp.getState().setPlanDocument({ sessionId, text })}
      className="flex h-[22px] shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-xs font-medium text-primary outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <FileText aria-hidden className="size-3" strokeWidth={2} />
      {t('Open plan')}
    </button>
  )
}

/** Under the last answer of a finished turn with the session in Plan permission: that answer is the plan. */
export function FinalPlanAction({ text }: { text: string }) {
  const { sessionId } = useChatActions()
  const planning = useApp((s) => (sessionId ? (s.sessions[sessionId]?.permission === 'plan' && !s.sessions[sessionId]?.parent) : false))
  if (!planning || !text.trim()) return null
  return (
    <div className="flex justify-start">
      <OpenPlanButton text={text} />
    </div>
  )
}
