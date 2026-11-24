// Scheda Branches (⌘⌥4): la mappa verticale dei branch del progetto e, sotto la riga della sessione aperta, le azioni di unione.
import type { SessionSummary } from '@shared/protocol'
import { t } from '@shared/i18n'
import { BranchMap } from './branch-map'
import { PanelNote } from './changes-panel'
import { MergePanel } from './merge-panel'

interface BranchesPanelProps {
  projectId: string
  root: string
  isGit: boolean
  session: SessionSummary | null
}

export function BranchesPanel({ projectId, root, isGit, session }: BranchesPanelProps) {
  if (!isGit) return <PanelNote>{t('This project isn’t a git repository.')}</PanelNote>
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <BranchMap projectId={projectId} currentSessionId={session?.id ?? null} detail={<MergePanel projectId={projectId} root={root} isGit={isGit} session={session} />} />
    </div>
  )
}
