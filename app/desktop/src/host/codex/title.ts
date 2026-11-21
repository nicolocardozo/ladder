// Titolo della sessione da un modello piccolo di Codex: thread effimero dell'app-server, in sola lettura.
import { tmpdir } from 'node:os'
import { TextToolAttempt, TextUnsafe, codexRefuse, isPlainServerName, codexTextConfig, codexToolItem, isTextBlocked, mcpServerNames } from '../text-safety'
import { TITLE_SYSTEM, cleanTitle } from '../titles'
import { codexEnv } from './environment'
import { CodexRpc } from './rpc'

const TIMEOUT_MS = 40_000

/** Il modello più piccolo tra quelli dell'account ("mini"); null se non ce n'è: il titolo resta provvisorio. */
export function smallCodexModel(models: { id: string; label: string }[]): string | null {
  return models.find((m) => /mini/i.test(m.id) || /mini/i.test(m.label))?.id ?? null
}

export async function codexTitle(cli: string, version: string, model: string, prompt: string, configDir: string | null = null): Promise<string | null> {
  try {
    const raw = await codexText(cli, version, model, TITLE_SYSTEM, prompt, TIMEOUT_MS, configDir)
    return raw === null ? null : cleanTitle(raw)
  } catch (error) {
    // Un titolo è un di più: se la generazione ha tentato uno strumento si scarta, senza errori per l'utente.
    if (isTextBlocked(error)) return null
    throw error
  }
}

/**
 * Testo libero dal modello piccolo (commit, PR, branch): stesso thread effimero dei titoli, SOLO testo. Barriere: sola
 * lettura, ogni comando chiede un'approvazione che si rifiuta (approvalPolicy 'untrusted'), funzioni di strumenti spente, ogni server MCP dell'utente disattivato per nome (config/read),
 * ogni richiesta di strumento rifiutata e ogni voce che non sia testo ferma il turno. In quel caso lancia TextToolAttempt
 * (il diff è un dato non affidabile). null se fallisce o scade.
 * Non si usa un CODEX_HOME temporaneo: servirebbe copiare auth.json (credenziali) e un token rinnovato nella copia
 * invaliderebbe quello dell'utente; con le credenziali nel Portachiavi non funzionerebbe affatto.
 */
export async function codexText(cli: string, version: string, model: string, system: string, prompt: string, timeoutMs: number, configDir: string | null = null, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return null
  let reply = ''
  let blocked = null as string | null
  let unsafe = false as boolean
  let threadId = null as string | null
  let turnId = null as string | null
  let finish: (ok: boolean) => void = () => undefined
  const done = new Promise<boolean>((resolve) => (finish = resolve))
  /** Uno strumento è stato tentato: turn/interrupt (meglio che si fermi da sé), poi si chiude il processo. */
  const block = (tool: string): void => {
    if (blocked !== null) return
    blocked = tool
    // Dopo il turno di event loop: prima parte la risposta di rifiuto alla richiesta, poi l'interruzione.
    setImmediate(() => {
      if (threadId && turnId) void rpc.request('turn/interrupt', { threadId, turnId }, 2_000).catch(() => undefined).finally(() => finish(false))
      else finish(false)
    })
  }
  const rpc = new CodexRpc(
    cli,
    await codexEnv(configDir),
    (method, params) => {
      if (method === 'turn/started') turnId = (params.turn as { id?: string } | undefined)?.id ?? turnId
      const tool = codexToolItem(method, params)
      if (tool) block(tool)
      if (method === 'item/completed') {
        const item = params.item as { type?: string; text?: string } | undefined
        if (item?.type === 'agentMessage') reply = String(item.text ?? '')
      } else if (method === 'turn/completed') {
        finish((params.turn as { status?: string } | undefined)?.status === 'completed')
      }
    },
    // Niente approvazioni né strumenti: ogni richiesta ha un rifiuto esplicito e ferma la generazione.
    async (request) => {
      const { reply, tool } = codexRefuse(request.method)
      if (tool) block(tool)
      return reply
    }
  )
  // Allo scadere si ferma il processo: le richieste in corso falliscono subito e il catch restituisce null.
  const timer = setTimeout(() => {
    finish(false)
    rpc.kill()
  }, timeoutMs)
  void rpc.exited.then(() => finish(false))
  // Annullamento dall'esterno (text.cancel): si ferma il processo.
  const cancel = (): void => {
    finish(false)
    rpc.kill()
  }
  signal?.addEventListener('abort', cancel, { once: true })
  // Annullato mentre si avviava il processo (await codexEnv): l'evento è già passato, lo si ricontrolla qui.
  if (signal?.aborted) cancel()
  try {
    await rpc.initialize(version)
    // Server MCP del config dell'utente: senza i nomi non si può spegnerli, quindi senza non si genera (fail-closed).
    // Risposta di forma diversa dall'attesa (null) o nome non semplice: non si genera.
    const names = mcpServerNames(await rpc.request('config/read', { includeLayers: false, cwd: tmpdir() }, 15_000))
    if (!names || !names.every(isPlainServerName)) {
      unsafe = true
      throw new TextUnsafe()
    }
    const started = await rpc.request<{ thread: { id: string } }>('thread/start', {
      cwd: tmpdir(),
      model,
      ephemeral: true,
      // 'untrusted': ogni comando, anche di sola lettura, chiede un'approvazione, che si rifiuta (provato su Codex 0.167 con cat, ls, pwd, git --version; con 'never' e 'on-request' un comando di sola lettura parte senza chiedere).
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      developerInstructions: system,
      config: codexTextConfig(names)
    })
    threadId = started.thread.id
    const turn = await rpc.request<{ turn?: { id?: string } }>('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      effort: 'low',
      serviceTierForTurn: 'default'
    })
    turnId = turn.turn?.id ?? turnId
    const ok = await done
    if (blocked === null) return ok ? reply : null
  } catch {
    if (blocked === null && !unsafe) return null
  } finally {
    clearTimeout(timer)
    rpc.kill()
  }
  // Arriva qui solo se uno strumento è stato tentato o la configurazione non si può rendere sicura: mai restituire testo.
  if (unsafe) throw new TextUnsafe()
  console.warn(`[text] tool attempt blocked: ${blocked}`)
  throw new TextToolAttempt(blocked ?? 'unknown')
}
