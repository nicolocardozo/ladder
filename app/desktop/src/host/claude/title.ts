// Titolo della sessione da un modello piccolo: una query() separata dell'Agent SDK, senza strumenti né impostazioni.
import { tmpdir } from 'node:os'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { TITLE_SYSTEM, cleanTitle } from '../titles'
import { TextToolAttempt, TextUnsafe, claudeInitIsClean, claudeTextOnly, claudeToolUses, isTextBlocked } from '../text-safety'
import { claudeEnv } from './environment'

const TIMEOUT_MS = 30_000

/** Titolo proposto da Haiku (abbonamento dell'utente, stesso login della CLI); null se fallisce o scade. */
export async function claudeTitle(cli: string | null, prompt: string, configDir: string | null = null): Promise<string | null> {
  try {
    const raw = await claudeText(cli, TITLE_SYSTEM, prompt, TIMEOUT_MS, configDir)
    return raw === null ? null : cleanTitle(raw)
  } catch (error) {
    // Un titolo è un di più: se la generazione ha tentato uno strumento si scarta, senza errori per l'utente.
    if (isTextBlocked(error)) return null
    throw error
  }
}

/**
 * Testo libero dal modello piccolo (commit, PR, branch): stessa query() dei titoli, SOLO testo e nessuno strumento (vedi
 * claudeTextOnly). null se fallisce o scade; se il modello prova a usare uno strumento la generazione si ferma e lancia
 * TextToolAttempt (il diff è un dato non affidabile).
 */
export async function claudeText(cli: string | null, system: string, prompt: string, timeoutMs: number, configDir: string | null = null, signal?: AbortSignal): Promise<string | null> {
  const abort = new AbortController()
  let blocked = null as string | null
  // Annullamento dall'esterno (text.cancel): ferma la query.
  if (signal?.aborted) return null
  signal?.addEventListener('abort', () => abort.abort(), { once: true })
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  const q = query({
    prompt,
    options: {
      // Cartella neutra: niente CLAUDE.md né file del progetto.
      cwd: tmpdir(),
      env: claudeEnv(configDir),
      abortController: abort,
      ...(cli ? { pathToClaudeCodeExecutable: cli } : {}),
      model: 'haiku',
      systemPrompt: system,
      ...claudeTextOnly((name) => {
        blocked = name
        abort.abort()
      })
    }
  })
  try {
    for await (const message of q) {
      // Fail-closed: se il processo parte con strumenti o server MCP la generazione non comincia nemmeno.
      if (message.type === 'system' && message.subtype === 'init' && !claudeInitIsClean(message)) {
        blocked = 'init'
        break
      }
      const uses = claudeToolUses(message)
      if (uses.length > 0 || (message.type === 'system' && (message as { subtype?: string }).subtype === 'permission_denied')) {
        blocked = uses[0] ?? 'permission_denied'
        break
      }
      if (blocked) break
      if (message.type === 'result') return message.subtype === 'success' ? message.result : null
    }
    if (blocked === null) return null
  } catch {
    if (blocked === null) return null
  } finally {
    clearTimeout(timer)
    abort.abort()
    q.close()
  }
  // Arriva qui solo se uno strumento è stato tentato o negato: mai restituire testo in quel caso.
  console.warn(`[text] tool attempt blocked: ${blocked}`)
  throw blocked === 'init' ? new TextUnsafe() : new TextToolAttempt(blocked ?? 'unknown')
}
