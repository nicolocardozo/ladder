// Anteprima del pannello terminali con due servizi del worktree (LAD-66): "Web" su :4200 in corso, "API" su :4300 fermo
// (Riavvia lo rimette in corso, come farebbe terminal.restart), accanto a una shell e a un'azione di avvio.
import { useState } from 'react'
import type { HostCommand, TerminalInfo } from '@shared/protocol'
import { TerminalPanel } from '@/components/terminal/terminal-panel'
import { useApp } from '@/store/app-store'
import { installSettingsPreview } from './settings-preview'
import { emitPreviewEvent, registerPreviewHandler } from './shortcuts-preview'

const PROJECT = 'preview'
const now = Date.now()
const base = { projectId: PROJECT, sessionId: null, cwd: '/Users/dev/.ladder/worktrees/acme/fix-login', exitCode: null }

const TERMINALS: TerminalInfo[] = [
  { ...base, id: 'tp-shell', kind: 'shell', title: 'zsh', command: null, state: 'running', createdAt: now - 5000, port: null },
  { ...base, id: 'tp-setup', kind: 'run', title: 'setup', command: 'pnpm install', state: 'exited', createdAt: now - 4000, port: 4100 },
  { ...base, id: 'tp-web', kind: 'service', title: 'Web', command: 'pnpm --filter web dev --port $LADDER_PORT', state: 'running', createdAt: now - 3000, port: 4200 },
  { ...base, id: 'tp-api', kind: 'service', title: 'API', command: 'pnpm --filter api dev --port $LADDER_PORT', state: 'stopped', createdAt: now - 2000, port: 4300 },
  { ...base, id: 'tp-worker', kind: 'service', title: 'Worker', command: 'pnpm worker', state: 'running', createdAt: now - 1000, port: null }
]

let handled = false

export function TerminalsPreview() {
  useState(() => {
    // Il pannello senza terminali ne aprirebbe uno: la lista c'è prima del primo render.
    useApp.setState({ terminals: Object.fromEntries(TERMINALS.map((x) => [x.id, x])) })
    useApp.getState().setTerminalPanel(PROJECT, { open: true, active: 'tp-api', side: 'bottom' })
    installSettingsPreview()
    if (!handled) {
      handled = true
      // terminal.restart: l'host vero rimanda terminal.upsert con lo stato in corso.
      registerPreviewHandler((command: HostCommand) => {
        if (!command.type.startsWith('terminal.')) return undefined
        if (command.type === 'terminal.attach') return { ok: true, data: { data: '' } }
        if (command.type !== 'terminal.restart') return { ok: true, data: null }
        const found = useApp.getState().terminals[command.id]
        if (found) emitPreviewEvent({ type: 'terminal.upsert', terminal: { ...found, state: 'running', exitCode: null } })
        return { ok: true, data: null }
      })
    }
  })
  return (
    <div className="flex h-[420px] w-[900px] shrink-0 flex-col justify-end overflow-hidden rounded-xl border border-border bg-background shadow-[0_18px_44px_rgb(3_8_20/0.25)]">
      <TerminalPanel projectId={PROJECT} sessionId={null} cwd={base.cwd} composerKey={null} />
    </div>
  )
}
