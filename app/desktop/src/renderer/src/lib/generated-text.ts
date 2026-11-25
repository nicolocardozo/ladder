// Text written by a model: commit message, PR title and description.
// Active if both the global setting and the project want it; ACP agents have no small model.
import type { SessionSummary } from '@shared/protocol'
import { t } from '@shared/i18n'
import { useApp } from '@/store/app-store'

export type GeneratedTextState = { available: true } | { available: false; reason: string }

export function useGeneratedText(projectId: string, session: SessionSummary | null): GeneratedTextState {
  const globalOn = useApp((s) => s.prefs?.generatedText ?? true)
  const projectOn = useApp((s) => s.ui[projectId]?.generatedText !== false)
  if (session && session.agent.startsWith('acp:'))
    return {
      available: false,
      reason: t('This agent can’t write the text. Type it yourself.')
    }
  if (!globalOn) return { available: false, reason: t('Written text is off in Settings.') }
  if (!projectOn)
    return {
      available: false,
      reason: t('Written text is off for this project, in Settings.')
    }
  if (!session)
    return {
      available: false,
      reason: t('Open a session on this branch to have the text written.')
    }
  return { available: true }
}
