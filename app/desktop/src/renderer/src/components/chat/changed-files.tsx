// Compact list of changed files with status and added and removed lines: under "N files changed" and in the agent handoff.
import { t } from '@shared/i18n'
import type { FileChange } from '@shared/protocol'

// English text: translated with t() where it is shown.
const STATUS_LABEL: Record<FileChange['status'], string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed'
}

export function ChangedFileList({ id, files, hint, onPick }: { id?: string; files: FileChange[]; hint: string; onPick: (file: FileChange, altKey: boolean) => void }) {
  return (
    <ul id={id} className="overflow-hidden rounded-[10px] border border-border dark:border-input/70">
      {files.map((file) => {
        const slash = file.path.lastIndexOf('/')
        const dir = slash >= 0 ? file.path.slice(0, slash + 1) : ''
        const base = slash >= 0 ? file.path.slice(slash + 1) : file.path
        return (
          <li key={file.path} className="border-b border-border last:border-b-0 dark:border-input/50">
            <button
              type="button"
              onClick={(event) => onPick(file, event.altKey)}
              title={`${t(STATUS_LABEL[file.status])} · ${file.path}\n${hint}`}
              className="flex w-full min-w-0 items-center gap-2.5 px-3 py-[5px] text-left font-mono text-xs text-foreground/85 outline-none hover:bg-accent focus-visible:bg-accent"
            >
              <span aria-label={t(STATUS_LABEL[file.status])} className="w-3 shrink-0 text-faint">
                {file.status}
              </span>
              <span className="flex min-w-0 flex-1">
                {dir ? <span className="min-w-0 truncate text-muted-foreground">{dir}</span> : null}
                <span className="shrink-0">{base}</span>
              </span>
              <span className="flex shrink-0 gap-2 tabular-nums">
                {file.added > 0 ? <span className="text-diff-added">+{file.added}</span> : null}
                {file.removed > 0 ? <span className="text-diff-removed">−{file.removed}</span> : null}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
