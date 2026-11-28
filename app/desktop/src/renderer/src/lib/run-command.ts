// Shell code blocks of the chat run in a terminal of the session, in its folder (the worktree when it has one).
import type { TerminalInfo } from '@shared/protocol'
import { request } from '@/lib/host-client'
import { showTerminal } from '@/lib/other-agents'
import { useApp } from '@/store/app-store'

const SHELL_LANGS = new Set(['bash', 'sh', 'zsh', 'shell', 'shellscript', 'console', 'terminal', 'fish'])

export function isShellBlock(lang: string | null): boolean {
  return lang !== null && SHELL_LANGS.has(lang.toLowerCase())
}

/**
 * The command to run from a block's text. A transcript with `$ ` prompts (```console) keeps only the prompt lines, since
 * the others are output; without prompts the whole block runs as a script.
 */
export function commandOfBlock(code: string): string {
  const lines = code.replace(/\s+$/, '').split('\n')
  if (!lines.some((line) => /^\s*\$ /.test(line))) return lines.join('\n').trim()
  const kept: string[] = []
  let continued = false
  for (const line of lines) {
    // A prompt line, or the continuation of one ending in a backslash; everything else is output.
    if (/^\s*\$ /.test(line)) kept.push(line.replace(/^\s*\$ /, ''))
    else if (continued) kept.push(line)
    else continue
    continued = /\\$/.test(line)
  }
  return kept.join('\n').trim()
}

/** Runs the command and brings its terminal into view. Rejects with the host's message. */
export async function runInSessionTerminal(projectId: string, sessionId: string, command: string): Promise<void> {
  const terminal = await request<TerminalInfo>({ type: 'terminal.run', projectId, sessionId, command })
  useApp.getState().applyEvent({ type: 'terminal.upsert', terminal })
  showTerminal(terminal)
}
