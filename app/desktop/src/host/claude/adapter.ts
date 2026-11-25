// Adapter Claude Code: una sessione di Ladder = un `query()` dell'Agent SDK con input in streaming.
import { randomUUID } from 'node:crypto'
import { relative } from 'node:path'
import {
  query,
  type CanUseTool,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SlashCommand as SDKSlashCommand
} from '@anthropic-ai/claude-agent-sdk'
import { localeTag, t } from '@shared/i18n'
import type { AgentStatus, Attachment, Effort, PermissionLevel, Question, RequestOption, RequestResponse, SlashCommand, ToolKind, UsageWindow } from '@shared/protocol'
import { agentInstructions, BROWSER_MCP_NAME, LADDER_MCP_NAME, ladderDetail } from '../agents/common'
import type { SubagentUpdate } from '../subagents'
import { readOnlyHooks } from './read-only'
import { claudeAccountLabel, claudeEnv, claudeModels, claudeUsage, readClaudeDefaults } from './environment'

export const PERMISSION_MODE: Record<PermissionLevel, PermissionMode> = {
  plan: 'plan',
  ask: 'default',
  edit: 'acceptEdits',
  full: 'bypassPermissions'
}

export interface ToolUpdate {
  id: string
  tool: ToolKind
  name: string
  title: string
  detail: string | null
  status: 'running' | 'done' | 'error' | 'denied'
  output: string | null
}

export interface UserRequest {
  requestType: 'permission' | 'question'
  toolName: string
  title: string
  command: string | null
  path: string | null
  reason: string | null
  options: RequestOption[]
  questions: Question[] | null
  preview?: { text: string; lines: number; truncated: boolean } | null
  /** Tutti i file toccati, quando sono più di uno (apply_patch di Codex). */
  paths?: string[]
}

const PREVIEW_MAX_LINES = 400

/** Modifica proposta da Edit, MultiEdit e Write come righe "- " e "+ ": serve alla card e a "In attesa". */
export function editPreview(toolName: string, input: Record<string, unknown>): UserRequest['preview'] {
  const lines: string[] = []
  const add = (prefix: string, text: unknown) => {
    if (typeof text !== 'string' || text === '') return
    for (const line of text.replace(/\n$/, '').split('\n')) lines.push(`${prefix}${line}`)
  }
  if (toolName === 'Edit') {
    add('-', input.old_string)
    add('+', input.new_string)
  } else if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    for (const edit of input.edits as Record<string, unknown>[]) {
      if (lines.length) lines.push('…')
      add('-', edit.old_string)
      add('+', edit.new_string)
    }
  } else if (toolName === 'Write') {
    add('+', input.content)
  } else {
    return null
  }
  if (lines.length === 0) return null
  const counted = lines.filter((l) => l !== '…').length
  return { text: lines.slice(0, PREVIEW_MAX_LINES).join('\n'), lines: counted, truncated: lines.length > PREVIEW_MAX_LINES }
}

export interface TurnResult {
  status: 'completed' | 'interrupted' | 'error'
  durationMs: number
  costUsd: number | null
  error: string | null
  context: { used: number; window: number; compactAt?: number | null } | null
}

export interface AdapterEvents {
  init(info: { externalId: string; model: string | null; effort?: Effort | null }): void
  assistant(id: string, text: string, streaming: boolean): void
  tool(update: ToolUpdate): void
  activity(text: string | null): void
  request(request: UserRequest, signal: AbortSignal): Promise<RequestResponse>
  turnEnd(result: TurnResult): void
  /** L'agente ha aperto un turno da solo: un messaggio inserito che ha superato un'interruzione. L'host apre il turno. */
  turnStart?(uuids: string[]): void
  notice(tone: 'info' | 'error', text: string): void
  account(info: { account: string | null; email?: string | null; models: AgentStatus['models']; limits?: string | null }): void
  /** Finestre dei limiti del piano: si uniscono a quelle già note, per chiave. */
  usage(windows: UsageWindow[]): void
  /** Sotto-agenti avviati dalla sessione: aggiornamenti parziali, uniti dall'host. */
  subagent(update: SubagentUpdate): void
  /** Elenco dei comandi / dell'agente: sostituisce quello noto. */
  commands(commands: SlashCommand[]): void
  /** Contesto compattato, a mano o in automatico. */
  compacted(info: { trigger: 'manual' | 'auto'; preTokens: number | null; postTokens: number | null }): void
  /** Contesto aggiornato dopo il turno (arriva in ritardo rispetto a turnEnd): sostituisce quello noto. */
  context?(context: NonNullable<TurnResult['context']>): void
  exit(error: string | null): void
}

export interface StartOptions {
  cwd: string
  cli: string | null
  /** Cartella di configurazione del profilo (CLAUDE_CONFIG_DIR); null = quella della CLI. */
  configDir?: string | null
  model: string | null
  effort: Effort | null
  permission: PermissionLevel
  resume: string | null
  /** Istruzione di autonomia nel prompt di sistema (HostPrefs.autonomyHint), solo con permesso edit o full. */
  autonomyHint?: boolean
  /** LAD-57 parte 2: server MCP del browser dell'agente (URL e token della sessione); assente = nessuna registrazione. */
  browserTools?: { url: string; token: string } | null
  /** Ladder MCP server (session URL and token); absent = no registration. */
  ladderTools?: { url: string; token: string } | null
  /** Read-only child session: write tools and plan exit are removed, not just refused. */
  readOnly?: boolean
  /** Project delegates in the system prompt. */
  delegateHint?: string | null
}


/** Dopo quanto un turno implicito senza messaggi del thread principale si considera mai partito. */
const IMPLICIT_TURN_MS = 45_000

/** Coda di messaggi utente letta dall'SDK come prompt in streaming. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false
  push(text: string, attachments: Attachment[] = [], extra: Pick<SDKUserMessage, 'uuid' | 'priority'> = {}): void {
    const content = attachments.length
      ? [
          ...attachments.map((a) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: a.mediaType as 'image/png', data: a.data } })),
          { type: 'text' as const, text }
        ]
      : text
    this.items.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, ...extra })
    this.wake?.()
  }
  close(): void {
    this.closed = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      while (this.items.length) yield this.items.shift()!
      if (this.closed) return
      await new Promise<void>((resolve) => (this.wake = resolve))
      this.wake = null
    }
  }
}

type Block = Record<string, unknown>

function asEffortLevel(value: unknown): Effort | null {
  return typeof value === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(value) ? (value as Effort) : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isAgentTool(name: string): boolean {
  return name === 'Task' || name === 'Agent'
}

function firstLine(text: string, max = 80): string {
  const line = text.split('\n')[0]
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Titolo leggibile e categoria di una tool call di Claude Code. */
export function describeTool(name: string, input: Block, cwd: string): Pick<ToolUpdate, 'tool' | 'title' | 'detail'> {
  const rel = (p: unknown) => {
    const path = str(p)
    if (!path) return null
    const r = relative(cwd, path)
    return r && !r.startsWith('..') ? r : path
  }
  switch (name) {
    case 'Bash': {
      const command = str(input.command) ?? ''
      return { tool: 'command', title: t('Runs {command}', { command: firstLine(command) }), detail: command }
    }
    case 'Read':
      return { tool: 'read', title: t('Reads {file}', { file: rel(input.file_path) ?? t('a file') }), detail: rel(input.file_path) }
    case 'Write':
      return { tool: 'edit', title: t('Writes {file}', { file: rel(input.file_path) ?? t('a file') }), detail: rel(input.file_path) }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { tool: 'edit', title: t('Edits {file}', { file: rel(input.file_path ?? input.notebook_path) ?? t('a file') }), detail: rel(input.file_path ?? input.notebook_path) }
    case 'Grep':
      return { tool: 'search', title: t('Searches “{pattern}”', { pattern: firstLine(str(input.pattern) ?? '', 50) }), detail: str(input.pattern) }
    case 'Glob':
      return { tool: 'search', title: t('Searches files {pattern}', { pattern: firstLine(str(input.pattern) ?? '', 50) }), detail: str(input.pattern) }
    case 'WebSearch':
      return { tool: 'web', title: t('Searches the web: {query}', { query: firstLine(str(input.query) ?? '', 60) }), detail: str(input.query) }
    case 'WebFetch':
      return { tool: 'web', title: t('Reads {file}', { file: firstLine(str(input.url) ?? t('a page'), 60) }), detail: str(input.url) }
    case 'Task':
    case 'Agent':
      return { tool: 'agent', title: t('Subagent: {task}', { task: firstLine(str(input.description) ?? t('task'), 60) }), detail: str(input.prompt) }
    case 'TodoWrite':
      return { tool: 'plan', title: t('Updates the plan'), detail: null }
    case 'ExitPlanMode':
      return { tool: 'plan', title: t('Proposes the plan'), detail: str(input.plan) }
    default:
      if (name.startsWith('mcp__')) {
        const [, server, tool] = name.split('__')
        return { tool: 'other', title: t('Uses {tool}', { tool: `${server} · ${tool}` }), detail: server === LADDER_MCP_NAME ? ladderDetail(input) : null }
      }
      return { tool: 'other', title: t('Uses {tool}', { tool: name }), detail: null }
  }
}

function toolResultText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && (part as Block).type === 'text' ? String((part as Block).text ?? '') : ''))
      .join('\n')
  }
  return null
}

const OUTPUT_LIMIT = 8000
/** Voci di task_id → sotto-agente che restano per le riprese. */
const TASK_MAP_LIMIT = 500
/** Tolleranza prima di dare per finito un background assente da background_tasks_changed: l'ordine rispetto a task_started/notification non è garantito. */
const BG_GRACE_MS = 3000
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export class ClaudeSession {
  private input = new InputQueue()
  private q: Query | null = null
  /** Token dell'ultimo messaggio assistant del loop principale (ultimo per message.id), ripiego se getContextUsage fallisce. */
  private lastMainUsed: number | null = null
  private lastWindow: number | null = null
  private contextSeq = 0
  private abort = new AbortController()
  private toolInputs = new Map<string, { name: string; input: Block }>()
  /** Blocchi di testo in streaming: indice del blocco → id dell'elemento. */
  private streamBlocks = new Map<number, string>()
  /** Blocchi di testo aperti nello stream e non ancora chiusi dal messaggio completo, in ordine. */
  private openTextIds: string[] = []
  private textCounter = 0
  private deniedTools = new Set<string>()
  /** tool_use di Agent/Task a ogni livello: diventano i nodi della mappa degli agenti. */
  private agentTools = new Set<string>()
  /**
   * task_id dell'SDK (e agentId dell'output di Agent) → id del sotto-agente (il suo tool_use, se c'è).
   * Non si svuota a fine turno: una ripresa porta lo stesso task_id e deve ritrovare la voce originale. Limitata a TASK_MAP_LIMIT.
   */
  private taskIds = new Map<string, string>()
  /** Ultimo run_id visto per task_id: i messaggi di una run precedente, arrivati in ritardo, non toccano la ripresa. */
  private taskRuns = new Map<string, string>()
  /** task_id dei sotto-agenti in background ancora in corso secondo noi: li confronta background_tasks_changed. */
  private bgTasks = new Set<string>()
  /** Insieme dei task in background vivi dall'ultimo background_tasks_changed (null: mai ricevuto). */
  private liveTasks: Set<string> | null = null
  /** Task in background vivi di ogni tipo (comandi in background, monitor, sotto-agenti) dall'ultimo background_tasks_changed. */
  private liveBackground = 0
  private bgTimer: ReturnType<typeof setTimeout> | null = null
  /** Sotto-agenti seguiti dagli eventi task_*: la fine la dice task_notification, non il tool_result. */
  private trackedTasks = new Set<string>()
  /** Agent/Task visti dal tool_use e non ancora collegati a un task_started: servono per abbinare i task senza tool_use_id. */
  private unlinkedAgents = new Map<string, string>()
  /** Sotto-agenti il cui modello è già noto (da input.model o dal primo messaggio): non si sovrascrive. */
  private modelKnown = new Set<string>()
  /** Sotto-agenti finiti: a fine turno le loro voci escono dalle mappe sopra. */
  private doneAgents = new Set<string>()
  /** Strumenti dei sotto-agenti (id → nome e titolo): al risultato se ne aggiorna lo stato nel buffer dell'agente. */
  private subTools = new Map<string, { name: string; title: string; parent: string }>()
  private currentMessageId: string | null = null
  private turnStartedAt = 0
  private running = false
  private interrupted = false
  /** Il turno in corso nasce da un comando /; il testo mostrato (assistente o output locale) evita il doppio. */
  private commandTurn = false
  private turnText = false
  /** Messaggi inseriti (uuid) che la CLI non ha ancora unito a un turno: se il turno finisce, girano da soli. */
  private pendingSteers = new Set<string>()
  /** Il turno in corso l'ha aperto la CLI per un messaggio inserito, non l'host. */
  private implicitTurn = false
  /** Nel turno implicito è già arrivato qualcosa dalla CLI. */
  private implicitActive = false
  /** Scatta se il turno implicito non produce nulla: i pendenti non sono mai partiti e non vanno aspettati. */
  private implicitTimer: ReturnType<typeof setTimeout> | null = null
  /** Stop: ciò che gira da solo dopo l'interruzione va fermato anche lui (vedi stopSurvivors). */
  private stopSurvivors = new Set<string>()
  /** Senza elenco degli uuid, lo Stop vale per il primo turno implicito che parte entro questa data. */
  private stopFirstUntil = 0
  /** Il turno implicito aperto contiene messaggi che uno Stop ha già chiesto di fermare. */
  private implicitStop = false

  constructor(
    private readonly options: StartOptions,
    private readonly events: AdapterEvents
  ) {}

  get isRunning(): boolean {
    return this.running
  }

  get pendingSteerCount(): number {
    return this.pendingSteers.size
  }

  /** Turno aperto per messaggi inseriti che la CLI non ha ancora fatto partire. */
  get idleImplicitTurn(): boolean {
    return this.implicitTurn && !this.implicitActive && this.running
  }

  start(): void {
    const { cwd, cli, configDir, model, effort, permission, resume, autonomyHint } = this.options
    const canUseTool: CanUseTool = (toolName, input, opts) => this.handlePermission(toolName, input, opts)
    this.q = query({
      prompt: this.input,
      options: {
        cwd,
        // Il token del browser dell'agente viaggia nell'ambiente del processo, non negli argomenti (`ps` li mostra a tutti).
        env: { ...claudeEnv(configDir ?? null), ...(this.options.browserTools ? { LADDER_BROWSER_TOKEN: this.options.browserTools.token } : {}), ...(this.options.ladderTools ? { LADDER_MCP_TOKEN: this.options.ladderTools.token } : {}) },
        abortController: this.abort,
        ...(cli ? { pathToClaudeCodeExecutable: cli } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(resume ? { resume } : {}),
        permissionMode: PERMISSION_MODE[permission],
        // Read-only: write tools removed and a hook that decides before the settings allow rules (see read-only.ts).
        ...(this.options.readOnly ? { disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'ExitPlanMode'], hooks: readOnlyHooks } : {}),
        // Sempre il prompt di Claude Code (senza, l'SDK userebbe un prompt vuoto). Snapshot predefinito: il prompt è registrato alla
        // prima richiesta e riusato (cache stabile), quindi l'istruzione di autonomia vale dalla creazione della sessione
        // (permesso e preferenza di quel momento); riprese e cambi di permesso successivi non la cambiano.
        systemPrompt: {
          type: 'preset' as const,
          preset: 'claude_code' as const,
          append: agentInstructions(autonomyHint && (permission === 'edit' || permission === 'full'), this.options.delegateHint)
        },
        // Sempre attivo: senza, una sessione nata in Ask non potrebbe passare a Full access (setPermissionMode verrebbe rifiutato).
        allowDangerouslySkipPermissions: !this.options.readOnly,
        includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
        // Con il login dell'abbonamento la CLI collegherebbe i connettori di claude.ai (posta, calendario…).
        settings: { disableClaudeAiConnectors: true },
        // LAD-57 parte 2: browser dell'agente. Le conferme (click, digitazione, indirizzi fuori da localhost) le chiede il server
        // stesso con le card di approvazione e secondo il livello della sessione: qui gli strumenti non chiedono una seconda volta.
        // Ladder MCP server (handoff, delegation, result). Permissions are handled by the server (handoff confirmation) and, for
        // read-only children, by the hook (only list_agents and report_result).
        ...(this.options.browserTools || this.options.ladderTools
          ? {
              mcpServers: {
                ...(this.options.browserTools ? { [BROWSER_MCP_NAME]: { type: 'http' as const, url: this.options.browserTools.url, headers: { Authorization: 'Bearer ${LADDER_BROWSER_TOKEN}' }, timeout: 660_000 } } : {}),
                ...(this.options.ladderTools ? { [LADDER_MCP_NAME]: { type: 'http' as const, url: this.options.ladderTools.url, headers: { Authorization: 'Bearer ${LADDER_MCP_TOKEN}' }, timeout: 3_600_000 } } : {})
              },
              allowedTools: [...(this.options.browserTools ? [`mcp__${BROWSER_MCP_NAME}`] : []), ...(this.options.ladderTools ? [`mcp__${LADDER_MCP_NAME}`] : [])]
            }
          : {}),
        canUseTool
      }
    })
    void this.consume()
    void this.loadAccount()
    void this.loadCommands()
  }

  send(text: string, attachments: Attachment[] = []): void {
    this.resetStop()
    this.running = true
    this.interrupted = false
    this.commandTurn = false
    this.turnText = false
    this.turnStartedAt = Date.now()
    this.events.activity(t('Thinking…'))
    // Con l'uuid la CLI lo elenca nel result del turno.
    this.input.push(text, attachments, { uuid: randomUUID() })
  }

  /**
   * Inserisce un messaggio nel turno in corso: la CLI lo accoda e lo unisce al turno tra un giro di strumenti
   * e l'altro. Non tocca stato e durata del turno. False se non c'è un turno da cui entrare.
   */
  async steer(text: string, attachments: Attachment[] = [], id?: string): Promise<boolean> {
    if (!this.running || this.interrupted) return false
    const uuid = (id ?? randomUUID()) as ReturnType<typeof randomUUID>
    this.pendingSteers.add(uuid)
    this.input.push(text, attachments, { uuid, priority: 'next' })
    return true
  }

  /** Un comando / è un messaggio utente come gli altri: lo gestisce la CLI. */
  command(name: string, args: string): void {
    this.send(`/${name} ${args}`.trim())
    this.commandTurn = true
  }

  /**
   * `all`: Stop, ferma anche i messaggi inseriti non ancora uniti (l'SDK non espone cancel_queued: se girano,
   * il loro turno parte e si interrompe subito, con l'output che resta visibile). Gli uuid sopravvissuti si
   * ricordano: lo Stop vale solo per un turno che li contiene, mai per uno aperto da un sotto-agente in background.
   * Senza `all` ("invia ora") i pendenti restano e girano insieme al messaggio nuovo.
   */
  async interrupt(all = false): Promise<void> {
    this.interrupted = true
    try {
      await this.afterReceipt(all)
    } catch (error) {
      this.resetStop()
      this.events.notice('error', t('Interrupt failed: {message}', { message: (error as Error).message }))
    }
  }

  /**
   * "Invia ora" con messaggi inseriti pendenti: interrompe e, subito dopo la ricevuta, mette il messaggio nello
   * stream. Così la CLI lo unisce ai pendenti in un solo turno, e l'host ne apre uno (quello implicito, che
   * riassegna la riga 'user' creata da `beforePush`). False se l'interruzione è fallita.
   */
  async interruptThenSend(text: string, attachments: Attachment[], id: string, beforePush: () => void): Promise<boolean> {
    this.interrupted = true
    try {
      await this.afterReceipt(false)
      beforePush()
      this.pendingSteers.add(id)
      this.input.push(text, attachments, { uuid: id as ReturnType<typeof randomUUID> })
      if (!this.running) this.armImplicit()
      return true
    } catch (error) {
      this.events.notice('error', t('Interrupt failed: {message}', { message: (error as Error).message }))
      return false
    }
  }

  private async afterReceipt(all: boolean): Promise<void> {
    // La ricevuta elenca i messaggi ancora in coda, che girerebbero da soli: gli altri sono già nel turno.
    const receipt = await this.q?.interrupt()
    if (Array.isArray(receipt?.still_queued)) {
      for (const uuid of this.pendingSteers) if (!receipt.still_queued.includes(uuid)) this.pendingSteers.delete(uuid)
      if (all) this.stopSurvivors = new Set([...this.pendingSteers])
    } else if (all) {
      const hadPending = this.pendingSteers.size > 0
      this.pendingSteers.clear()
      this.stopSurvivors.clear()
      if (hadPending && !this.implicitTurn) this.stopFirstUntil = Date.now() + IMPLICIT_TURN_MS
    }
    // Turno implicito non ancora partito: "invia ora" lo chiude per far posto al messaggio (i pendenti restano e
    // si uniscono ad esso). Stop lo chiude solo se non resta nulla in coda; altrimenti resta aperto e ferma ciò che parte.
    if (this.idleImplicitTurn && (!all || this.pendingSteers.size === 0)) this.closeTurn('interrupted')
    if (!this.running && this.stopSurvivors.size === 0) this.resetStop()
  }

  private resetStop(): void {
    this.stopSurvivors.clear()
    this.stopFirstUntil = 0
    this.implicitStop = false
  }

  async setPermission(level: PermissionLevel): Promise<void> {
    // Se l'agente rifiuta l'errore risale: il livello salvato non cambia.
    await this.q?.setPermissionMode(PERMISSION_MODE[level])
    // Un riavvio della sessione riparte dal livello nuovo.
    this.options.permission = level
  }

  async setEffort(effort: Effort): Promise<void> {
    // Vale dal prossimo messaggio; con una sessione non ancora avviata basta la scelta salvata.
    this.options.effort = effort
    await this.q?.applyFlagSettings({ effortLevel: effort })
  }

  async setModel(model: string): Promise<void> {
    await this.q?.setModel(model)
  }

  close(): void {
    if (this.bgTimer) clearTimeout(this.bgTimer)
    this.bgTimer = null
    this.input.close()
    this.abort.abort()
    this.pendingSteers.clear()
    this.resetStop()
    this.closeTurn('interrupted')
  }

  /** Chiude il turno in corso, se c'è, e ferma il timer del turno implicito. */
  private closeTurn(status: 'interrupted' | 'error', error: string | null = null): void {
    if (this.implicitTimer) clearTimeout(this.implicitTimer)
    this.implicitTimer = null
    if (this.running) this.finishTurn({ status, durationMs: Date.now() - this.turnStartedAt, costUsd: null, error, context: null })
  }

  /** Apre il turno per i messaggi pendenti, in attesa che la CLI parta; se non parte, il timer lo chiude. */
  private armImplicit(): void {
    this.openImplicit()
    // Solo un suggerimento: se la CLI non parte, il timer chiude il turno vuoto e svuota i pendenti e lo Stop;
    // se poi la CLI parte, la rete di sicurezza in handle() lo riapre.
    this.implicitTimer = setTimeout(() => {
      this.implicitTimer = null
      if (!this.idleImplicitTurn) return
      this.pendingSteers.clear()
      this.stopSurvivors.clear()
      this.closeTurn('interrupted')
    }, IMPLICIT_TURN_MS)
  }

  /** Apre un turno che la CLI ha cominciato da sola (un messaggio inserito che ha superato un'interruzione). */
  private openImplicit(): void {
    this.running = true
    this.interrupted = false
    this.commandTurn = false
    this.turnText = false
    this.implicitTurn = true
    this.implicitActive = false
    this.turnStartedAt = Date.now()
    const uuids = [...this.pendingSteers]
    // Lo Stop vale per questo turno solo se contiene un sopravvissuto, o se è il primo dopo uno Stop senza elenco.
    this.implicitStop = uuids.some((uuid) => this.stopSurvivors.has(uuid)) || Date.now() < this.stopFirstUntil
    if (Date.now() < this.stopFirstUntil) this.stopFirstUntil = 0
    this.events.turnStart?.(uuids)
    this.events.activity(t('Thinking…'))
  }

  private async loadAccount(): Promise<void> {
    if (!this.q) return
    try {
      const [account, models] = await Promise.all([this.q.accountInfo(), this.q.supportedModels()])
      this.events.account({
        account: claudeAccountLabel(account),
        email: account.email ?? null,
        models: claudeModels(models, readClaudeDefaults(this.options.configDir ?? null))
      })
    } catch {
      // Le informazioni sull'account sono un di più: senza, la sessione funziona lo stesso.
    }
  }

  private async loadCommands(): Promise<void> {
    if (!this.q) return
    try {
      this.setCommands(await this.q.supportedCommands())
    } catch {
      // Senza l'elenco la sessione funziona lo stesso.
    }
  }

  /** Sostituisce l'elenco. Righe con lo stesso nome: vale quella di Claude Code, che è la eseguita da /nome. */
  private setCommands(raw: SDKSlashCommand[]): void {
    const byName = new Map<string, SlashCommand>()
    for (const c of raw) {
      if (byName.has(c.name) && !c.builtin) continue
      byName.set(c.name, {
        name: c.name,
        description: c.description,
        hint: str(c.argumentHint),
        source: c.builtin ? 'builtin' : 'custom',
        ...(c.aliases?.length ? { aliases: c.aliases } : {})
      })
    }
    this.events.commands([...byName.values()])
  }

  private async consume(): Promise<void> {
    if (!this.q) return
    try {
      for await (const message of this.q) this.handle(message)
      this.pendingSteers.clear()
      this.resetStop()
      this.closeTurn('interrupted')
      this.events.exit(null)
    } catch (error) {
      const text = (error as Error).message
      this.pendingSteers.clear()
      this.resetStop()
      this.closeTurn('error', text)
      this.events.exit(this.abort.signal.aborted ? null : text)
    }
  }

  private handle(message: SDKMessage): void {
    const m = message as Block & { type: string }
    // Rete di sicurezza: l'output del thread principale non si perde mai. Se arriva senza un turno aperto
    // (messaggio inserito sopravvissuto a un'interruzione, tentativo dell'API), se ne apre uno.
    const main =
      !m.parent_tool_use_id && (m.type === 'assistant' || m.type === 'stream_event' || (m.type === 'system' && m.subtype === 'api_retry'))
    if (main && !this.running) {
      this.openImplicit()
      this.implicitActive = true
    }
    if (this.implicitTurn && !this.implicitActive && main) this.implicitActive = true
    if (main && this.implicitTurn) {
      if (this.implicitTimer) clearTimeout(this.implicitTimer)
      this.implicitTimer = null
      // Stop con messaggi sopravvissuti: il loro turno è partito, si ferma subito.
      if (this.implicitStop && !this.interrupted) void this.interrupt(true)
    }
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') this.events.init({ externalId: String(m.session_id), model: str(m.model), effort: asEffortLevel(m.effort) })
        else if (m.subtype === 'commands_changed') this.setCommands(m.commands as SDKSlashCommand[])
        else if (m.subtype === 'compact_boundary') {
          const meta = (m.compact_metadata ?? {}) as Block
          const postTokens = num(meta.post_tokens) ?? null
          if (postTokens !== null) this.lastMainUsed = postTokens
          this.events.compacted({ trigger: meta.trigger === 'auto' ? 'auto' : 'manual', preTokens: num(meta.pre_tokens) ?? null, postTokens })
        } else if (m.subtype === 'background_tasks_changed') this.syncBackground(m.tasks)
        else if (typeof m.subtype === 'string' && m.subtype.startsWith('task_')) this.handleTask(m)
        return
      case 'stream_event':
        if (m.parent_tool_use_id) return // testo dei sotto-agenti: per ora non lo mostriamo
        this.handleStream(m.event as Block)
        return
      case 'assistant':
        if (m.parent_tool_use_id) this.handleSubagentAssistant(String(m.parent_tool_use_id), m.message as Block, str(m.agent_id))
        else this.handleAssistant(m.message as Block)
        return
      case 'user':
        this.handleLocalOutput(m.message as Block)
        this.handleToolResults(m.message as Block, m.parent_tool_use_id ? String(m.parent_tool_use_id) : null, m.tool_use_result)
        return
      case 'result':
        this.handleResult(m)
        return
      case 'rate_limit_event': {
        const info = (m.rate_limit_info ?? {}) as Block
        const window = claudeUsage(info)
        if (window) this.events.usage([window])
        if (info.status === 'rejected') {
          const reset = typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' }) : null
          this.events.notice('error', reset ? t('Usage limit reached: resets at {time}.', { time: reset }) : t('Usage limit reached.'))
        } else if (info.status === 'allowed_warning') {
          this.events.notice('info', t('You are getting close to your plan usage limit.'))
        }
        return
      }
      default:
        return
    }
  }

  private handleStream(event: Block): void {
    switch (event.type) {
      case 'message_start':
        this.currentMessageId = String((event.message as Block)?.id ?? `m${Date.now()}`)
        this.streamBlocks.clear()
        return
      case 'content_block_start': {
        const block = event.content_block as Block
        if (block?.type === 'text') {
          const id = `${this.currentMessageId}:${String(event.index)}`
          this.streamBlocks.set(Number(event.index), id)
          this.openTextIds.push(id)
          this.events.assistant(id, '', true)
          this.events.activity(t('Writing the reply'))
        } else if (block?.type === 'thinking') {
          this.events.activity(t('Thinking…'))
        }
        return
      }
      case 'content_block_delta': {
        const delta = event.delta as Block
        const id = this.streamBlocks.get(Number(event.index))
        if (id && delta?.type === 'text_delta') this.appendText(id, String(delta.text ?? ''))
        return
      }
      default:
        return
    }
  }

  private texts = new Map<string, string>()
  private appendText(id: string, chunk: string): void {
    const text = (this.texts.get(id) ?? '') + chunk
    this.texts.set(id, text)
    this.events.assistant(id, text, true)
  }

  private handleAssistant(message: Block): void {
    const messageId = String(message.id ?? this.currentMessageId ?? `m${Date.now()}`)
    // Il messaggio con lo stesso id torna più volte (un blocco alla volta): vale l'ultimo.
    const u = message.usage as Block | undefined
    if (u) this.lastMainUsed = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0)
    const content = Array.isArray(message.content) ? (message.content as Block[]) : []
    content.forEach((block) => {
      if (block.type === 'text') {
        // Il messaggio completo arriva un blocco alla volta: chiude il primo blocco di testo ancora aperto.
        const id = this.openTextIds.shift() ?? `${messageId}:t${++this.textCounter}`
        if (String(block.text ?? '').trim()) this.turnText = true
        this.texts.set(id, String(block.text ?? ''))
        this.events.assistant(id, String(block.text ?? ''), false)
      } else if (block.type === 'tool_use') {
        const id = String(block.id)
        const name = String(block.name)
        const input = (block.input ?? {}) as Block
        this.toolInputs.set(id, { name, input })
        if (name === 'AskUserQuestion') return // diventa una domanda, non una riga di attività
        if (isAgentTool(name)) this.startSubagent(id, null, input)
        const described = describeTool(name, input, this.options.cwd)
        this.events.tool({ id, name, ...described, status: 'running', output: null })
        this.events.activity(described.title)
      }
    })
  }

  /** Messaggio di un sotto-agente: i suoi strumenti diventano la sua attività, i suoi Agent dei figli. */
  private handleSubagentAssistant(parentToolId: string, message: Block, agentId: string | null): void {
    // agent_id è il task_id, invariato alla ripresa: porta alla voce originale. Un parent mai visto non crea voci.
    const parent = (agentId && this.taskIds.get(agentId)) || (this.knowsAgent(parentToolId) ? this.taskIds.get(parentToolId) ?? parentToolId : null)
    if (!parent) return
    const content = Array.isArray(message?.content) ? (message.content as Block[]) : []
    const model = str(message?.model)
    let activity: string | null = null
    for (const block of content) {
      if (block.type !== 'tool_use') continue
      const name = String(block.name)
      const input = (block.input ?? {}) as Block
      if (isAgentTool(name)) this.startSubagent(String(block.id), parent, input)
      const described = describeTool(name, input, this.options.cwd)
      activity = described.title
      this.subTools.set(String(block.id), { name, title: described.title, parent })
      this.events.subagent({ id: parent, tool: { id: String(block.id), name, title: described.title, status: 'running', at: Date.now() } })
    }
    const setModel = model && !this.modelKnown.has(parent)
    if (setModel) this.modelKnown.add(parent)
    if (activity || setModel) this.events.subagent({ id: parent, ...(activity ? { activity } : {}), ...(setModel ? { model } : {}) })
  }

  /**
   * background_tasks_changed: l'insieme completo dei task in background vivi (semantica replace).
   * I sotto-agenti in background che non ci sono più e di cui non è arrivata la notification risultano fermati.
   */
  private syncBackground(tasks: unknown): void {
    if (!Array.isArray(tasks)) return
    const live = new Set<string>()
    let background = 0
    for (const entry of tasks as Block[]) {
      const id = str(entry?.task_id)
      if (!id || entry.ambient === true) continue
      background++
      if (entry?.task_type === 'local_agent' || entry?.task_type === 'remote_agent') live.add(id)
    }
    this.liveTasks = live
    this.liveBackground = background
    if (this.bgTimer || ![...this.bgTasks].some((task) => !live.has(task))) return
    // Solo i task già mancanti ora: se sono ancora assenti alla scadenza della tolleranza, sono finiti.
    const missing = [...this.bgTasks].filter((task) => !live.has(task))
    this.bgTimer = setTimeout(() => {
      this.bgTimer = null
      for (const task of missing) {
        if (!this.bgTasks.has(task) || this.liveTasks?.has(task)) continue
        this.bgTasks.delete(task)
        const id = this.taskIds.get(task)
        if (!id || this.doneAgents.has(id)) continue
        this.doneAgents.add(id)
        this.events.subagent({ id, status: 'stopped' })
      }
    }, BG_GRACE_MS)
  }

  get hasBackgroundWork(): boolean {
    return this.liveBackground > 0
  }

  /** Voci dei sotto-agenti nell'ultimo background_tasks_changed (null: mai ricevuto): la rete di sicurezza dell'host non le tocca. */
  liveAgentIds(): Set<string> | null {
    if (!this.liveTasks) return null
    return new Set([...this.liveTasks].map((task) => this.taskIds.get(task) ?? task))
  }

  /** Il parent_tool_use_id è un agente che conosciamo (tool_use di Agent, task o alias)? */
  private knowsAgent(id: string): boolean {
    return this.agentTools.has(id) || this.trackedTasks.has(id) || this.taskIds.has(id)
  }

  private linkTask(taskId: string, id: string): void {
    this.taskIds.delete(taskId)
    this.taskIds.set(taskId, id)
    while (this.taskIds.size > TASK_MAP_LIMIT) {
      const oldest = this.taskIds.keys().next().value!
      this.taskIds.delete(oldest)
      this.taskRuns.delete(oldest)
      this.bgTasks.delete(oldest)
    }
  }

  private startSubagent(id: string, parentId: string | null, input: Block): void {
    this.agentTools.add(id)
    const title = firstLine(str(input.description) ?? '', 80) || t('Subagent')
    const effort = str(input.effort)
    if (str(input.model)) this.modelKnown.add(id)
    if (str(input.description)) this.unlinkedAgents.set(id, str(input.description)!)
    this.events.subagent({
      id,
      parentId,
      toolId: id,
      title,
      kind: str(input.subagent_type),
      ...(str(input.model) ? { model: str(input.model) } : {}),
      ...(effort && EFFORTS.includes(effort as Effort) ? { effort: effort as Effort } : {}),
      ...(str(input.prompt) ? { prompt: str(input.prompt) } : {}),
      status: 'running',
      background: input.run_in_background === true
    })
  }

  /** Eventi task_* dell'SDK: inizio, avanzamento con token e strumenti, fine. Solo i sotto-agenti, non i comandi in background. */
  private handleTask(m: Block): void {
    const taskId = String(m.task_id ?? '')
    if (!taskId) return
    // Messaggio di una run precedente a quella che si vede (ripresa): in ritardo, si ignora. Gli id di run si ordinano come stringhe.
    const run = str(m.run_id)
    const seen = this.taskRuns.get(taskId)
    if (run && seen && run < seen) return
    if (run && m.subtype !== 'task_started' && this.taskIds.has(taskId)) this.taskRuns.set(taskId, run)
    if (m.subtype === 'task_started') {
      const type = str(m.task_type)
      const isAgent = type ? type === 'local_agent' || type === 'remote_agent' : Boolean(m.subagent_type)
      if (!isAgent || m.ambient === true || m.skip_transcript === true) return
      if (run) this.taskRuns.set(taskId, run)
      // Task già visto (o agentId dell'output di Agent): è una ripresa, la voce è la stessa e torna in corso.
      const resumed = this.taskIds.get(taskId)
      const toolUse = resumed ? null : str(m.tool_use_id) ?? this.linkAgentTool(str(m.description))
      const id = resumed ?? toolUse ?? taskId
      this.unlinkedAgents.delete(id)
      this.linkTask(taskId, id)
      this.trackedTasks.add(id)
      this.doneAgents.delete(id)
      if (m.is_backgrounded === true) this.bgTasks.add(taskId)
      else this.bgTasks.delete(taskId)
      const parentTask = str(m.parent_task_id)
      const title = firstLine(str(m.description) ?? '', 80) || t('Subagent')
      this.events.subagent({
        id,
        ...(!resumed && parentTask && this.taskIds.has(parentTask) ? { parentId: this.taskIds.get(parentTask) } : {}),
        // Alla ripresa tipo e prompt restano quelli della voce originale, il titolo anche (la board non lo sovrascrive).
        title,
        ...(str(m.subagent_type) && !resumed ? { kind: str(m.subagent_type) } : {}),
        ...(toolUse ? { toolId: toolUse } : {}),
        ...(str(m.prompt) && !resumed ? { prompt: str(m.prompt) } : {}),
        status: 'running',
        background: m.is_backgrounded === true
      })
      return
    }
    const id = this.taskIds.get(taskId)
    if (!id) return
    const usage = (m.usage ?? null) as Block | null
    const counts = usage ? { tokens: num(usage.total_tokens), toolUses: num(usage.tool_uses) } : {}
    if (m.subtype === 'task_progress') {
      const summary = str(m.summary)
      this.events.subagent({ id, ...counts, ...(summary ? { activity: firstLine(summary, 100) } : {}) })
    } else if (m.subtype === 'task_updated') {
      const patch = (m.patch ?? {}) as Block
      const status = patch.status === 'completed' ? 'done' : patch.status === 'failed' ? 'error' : patch.status === 'killed' ? 'stopped' : undefined
      if (status) {
        this.doneAgents.add(id)
        this.bgTasks.delete(taskId)
      }
      if (patch.is_backgrounded === true) this.bgTasks.add(taskId)
      this.events.subagent({ id, ...(status ? { status } : {}), ...(typeof patch.is_backgrounded === 'boolean' ? { background: patch.is_backgrounded } : {}) })
    } else if (m.subtype === 'task_notification') {
      const status = m.status === 'completed' ? 'done' : m.status === 'failed' ? 'error' : 'stopped'
      const summary = str(m.summary)
      const outputFile = str(m.output_file)
      this.doneAgents.add(id)
      this.bgTasks.delete(taskId)
      this.events.subagent({ id, status, ...counts, ...(summary ? { report: summary } : {}), ...(outputFile ? { outputFile } : {}) })
    }
  }

  /** task_started senza tool_use_id: lo abbina al suo Agent/Task solo se la descrizione corrisponde a uno solo. */
  private linkAgentTool(description: string | null): string | null {
    if (!description) return null
    const found = [...this.unlinkedAgents].filter(([, d]) => d === description)
    return found.length === 1 ? found[0][0] : null
  }

  /** Output dei comandi locali (/context, /cost…): arriva come <local-command-stdout> in un messaggio utente. */
  private handleLocalOutput(message: Block): void {
    if (!this.commandTurn || this.turnText) return
    const content = message?.content
    const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? (content as Block[]).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')) : []
    for (const part of parts) {
      const found = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(part)
      const text = found?.[1].trim()
      if (!text) continue
      this.turnText = true
      this.events.assistant(`${this.currentMessageId ?? 'local'}:out${++this.textCounter}`, text, false)
      return
    }
  }

  private handleToolResults(message: Block, parent: string | null = null, toolUseResult: unknown = null): void {
    const content = Array.isArray(message?.content) ? (message.content as Block[]) : []
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const id = String(block.tool_use_id)
      this.unlinkedAgents.delete(id)
      // L'agentId dell'output di Agent è un alias del task: una ripresa con quel task_id ritrova la voce.
      const agentId = this.agentTools.has(id) && toolUseResult && typeof toolUseResult === 'object' ? str((toolUseResult as Block).agentId) : null
      if (agentId && !this.taskIds.has(agentId)) this.linkTask(agentId, id)
      // Fine di un sotto-agente senza eventi task_* (CLI più vecchie): la dice il risultato del suo Agent.
      if (this.agentTools.has(id) && !this.trackedTasks.has(id)) {
        this.events.subagent({ id, status: this.deniedTools.has(id) ? 'stopped' : block.is_error ? 'error' : 'done' })
        this.doneAgents.add(id)
      }
      // Il testo completo del risultato dell'Agent è il report del primo piano: sta nel buffer pesante, oltre il limite della riga.
      if (this.agentTools.has(id) && !this.deniedTools.has(id) && !block.is_error) {
        const full = toolResultText(block.content)?.trim()
        if (full) this.events.subagent({ id, result: full.slice(0, 60_000) })
      }
      if (parent) {
        // Lo stato dello strumento del sotto-agente: il titolo è quello già noto.
        const inner = this.subTools.get(id)
        if (inner) this.events.subagent({ id: parent, tool: { id, name: inner.name, title: inner.title, status: this.deniedTools.has(id) ? 'denied' : block.is_error ? 'error' : 'done', at: Date.now() } })
        this.subTools.delete(id)
        continue // risultati interni a un sotto-agente: nella chat non si mostrano
      }
      const known = this.toolInputs.get(id)
      if (!known || known.name === 'AskUserQuestion') continue
      const text = toolResultText(block.content)
      const described = describeTool(known.name, known.input, this.options.cwd)
      const denied = this.deniedTools.has(id)
      this.events.tool({
        id,
        name: known.name,
        ...described,
        status: denied ? 'denied' : block.is_error ? 'error' : 'done',
        output: text ? text.slice(0, OUTPUT_LIMIT) : null
      })
    }
    if (!parent) this.events.activity(t('Thinking…'))
  }

  private handleResult(m: Block): void {
    const usage = (m.modelUsage ?? {}) as Record<string, Block>
    const main = Object.values(usage).sort((a, b) => Number(b.contextWindow ?? 0) - Number(a.contextWindow ?? 0))[0]
    // Ripiego: l'ultimo messaggio del loop principale, mai m.usage (aggregato sul turno, la cache read conta N volte).
    const window = main && Number(main.contextWindow) > 0 ? Number(main.contextWindow) : this.lastWindow
    const context = window && this.lastMainUsed !== null ? { used: this.lastMainUsed, window } : null
    void this.refreshContext()
    // Gli uuid consumati dal turno: l'elenco, o l'ultimo messaggio per le CLI che non lo mandano. Senza nulla non si sa: niente pendenti appesi.
    if (Array.isArray(m.user_message_uuids)) for (const uuid of m.user_message_uuids as unknown[]) this.pendingSteers.delete(String(uuid))
    else this.pendingSteers.clear() // CLI senza elenco: i messaggi inseriti prima del result sono stati consumati
    const isError = m.subtype !== 'success' || m.is_error === true
    const status: TurnResult['status'] = this.interrupted ? 'interrupted' : isError ? 'error' : 'completed'
    // Un comando che finisce senza testo dell'assistente (/context, /cost…): il suo risultato è la risposta.
    if (this.commandTurn && !this.turnText && status === 'completed' && !isError && str(m.result)?.trim()) {
      this.turnText = true
      this.events.assistant(`result:${Date.now()}`, str(m.result)!.trim(), false)
    }
    // Risultato senza turno aperto: già chiuso da un'interruzione, o turno senza alcun output. Niente da chiudere.
    if (!this.running) {
      if (this.pendingSteers.size > 0) this.armImplicit()
      else this.resetStop()
      return
    }
    const errors = Array.isArray(m.errors) ? (m.errors as unknown[]).map(String).join('\n') : null
    this.finishTurn({
      status,
      durationMs: Number(m.duration_ms ?? Date.now() - this.turnStartedAt),
      costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null,
      error: status === 'error' ? errors || str(m.result) || t('The session stopped with an error.') : null,
      context
    })
    // Messaggi inseriti non ancora uniti a un turno girano da soli: il turno è già aperto per loro, l'output non si scarta.
    if (this.pendingSteers.size > 0) this.armImplicit()
    else this.resetStop()
  }

  /**
   * Contesto come lo conta /context: getContextUsage('summary') non fa chiamate di conteggio.
   * Non blocca la fine del turno: aggiorna il contesto appena risponde, entro un timeout.
   */
  private async refreshContext(): Promise<void> {
    const q = this.q
    if (!q) return
    const seq = ++this.contextSeq
    let timer: NodeJS.Timeout | undefined
    try {
      const usage = await Promise.race([
        q.getContextUsage({ detail: 'summary' }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), 4000)
        })
      ])
      if (seq !== this.contextSeq || usage.totalTokens <= 0) return
      // La finestra è quella con cui percentage = totalTokens / finestra: tra maxTokens e rawMaxTokens
      // i tipi non lo dicono, si sceglie quella che riproduce la percentuale (a pari merito, maxTokens).
      const fit = (w: number): number => (w > 0 ? Math.abs((usage.totalTokens / w) * 100 - usage.percentage) : Infinity)
      const window = fit(usage.rawMaxTokens) < fit(usage.maxTokens) ? usage.rawMaxTokens : usage.maxTokens
      if (!(window > 0)) return
      this.lastWindow = window
      this.lastMainUsed = usage.totalTokens
      this.events.context?.({ used: usage.totalTokens, window, compactAt: usage.isAutoCompactEnabled ? usage.autoCompactThreshold : null })
    } catch {
      // Senza: resta il ripiego calcolato a fine turno.
    } finally {
      clearTimeout(timer)
    }
  }

  private finishTurn(result: TurnResult): void {
    if (this.implicitTimer) clearTimeout(this.implicitTimer)
    this.implicitTimer = null
    this.implicitTurn = false
    this.implicitActive = false
    this.implicitStop = false
    this.running = false
    this.interrupted = false
    this.commandTurn = false
    this.turnText = false
    this.texts.clear()
    this.openTextIds = []
    this.events.activity(null)
    this.forgetFinishedAgents()
    this.events.turnEnd(result)
  }

  /** A fine turno le mappe tengono solo gli agenti ancora vivi (i background che finiranno dopo); taskIds resta per le riprese. */
  private forgetFinishedAgents(): void {
    for (const id of this.doneAgents) {
      this.agentTools.delete(id)
      this.trackedTasks.delete(id)
      this.unlinkedAgents.delete(id)
      this.modelKnown.delete(id)
      for (const [tool, sub] of this.subTools) if (sub.parent === id) this.subTools.delete(tool)
    }
    this.doneAgents.clear()
  }

  private async handlePermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; blockedPath?: string; decisionReason?: string; toolUseID?: string }
  ): Promise<PermissionResult> {
    if (toolName === 'AskUserQuestion') return this.handleQuestion(input, opts.signal)
    const described = describeTool(toolName, input, this.options.cwd)
    const options: RequestOption[] = [{ id: 'allow', label: t('Approve'), kind: 'allow' }]
    const suggestions = this.allowedSuggestions(opts.suggestions)
    if (suggestions.length) options.push({ id: 'always', label: t('Always allow'), kind: 'allow-always' })
    options.push({ id: 'deny', label: t('Deny'), kind: 'deny' })
    this.events.activity(t('Waiting for your approval'))
    const response = await this.events.request(
      {
        requestType: 'permission',
        toolName,
        title: described.title,
        command: toolName === 'Bash' ? str(input.command) : null,
        path: described.tool === 'edit' || described.tool === 'read' ? described.detail : opts.blockedPath ?? null,
        reason: str(input.description) ?? str(opts.decisionReason),
        options,
        questions: null,
        preview: editPreview(toolName, input)
      },
      opts.signal
    )
    this.events.activity(described.title)
    if ('optionId' in response && response.optionId === 'allow') return { behavior: 'allow', updatedInput: input }
    if ('optionId' in response && response.optionId === 'always')
      return { behavior: 'allow', updatedInput: input, updatedPermissions: suggestions }
    const message = 'optionId' in response && response.message ? response.message : t('The user denied this action.')
    if (opts.toolUseID) {
      this.deniedTools.add(opts.toolUseID)
      this.unlinkedAgents.delete(opts.toolUseID)
    }
    return { behavior: 'deny', message }
  }

  /** Toglie dai suggerimenti "Always allow" i cambi di modalità oltre il livello della sessione (mai bypassPermissions se non è Full access). */
  private allowedSuggestions(suggestions: PermissionUpdate[] | undefined): PermissionUpdate[] {
    const rank: Record<PermissionLevel, number> = { plan: 0, ask: 1, edit: 2, full: 3 }
    const limit = rank[this.options.permission]
    return (suggestions ?? []).filter((update) => {
      if (update.type !== 'setMode') return true
      const level = (Object.keys(PERMISSION_MODE) as PermissionLevel[]).find((l) => PERMISSION_MODE[l] === update.mode)
      return level !== undefined && rank[level] <= limit
    })
  }

  private async handleQuestion(input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    const raw = Array.isArray(input.questions) ? (input.questions as Block[]) : []
    const questions: Question[] = raw.map((q) => ({
      question: String(q.question ?? ''),
      header: str(q.header),
      multiSelect: q.multiSelect === true,
      options: (Array.isArray(q.options) ? (q.options as Block[]) : []).map((o) => ({ label: String(o.label ?? ''), description: str(o.description) }))
    }))
    this.events.activity(t('Waiting for your answer'))
    const response = await this.events.request(
      { requestType: 'question', toolName: 'AskUserQuestion', title: questions[0]?.question ?? t('Question'), command: null, path: null, reason: null, options: [], questions },
      signal
    )
    this.events.activity(t('Thinking…'))
    if ('answers' in response) return { behavior: 'allow', updatedInput: { ...input, answers: response.answers } }
    return { behavior: 'deny', message: t('The user did not answer the question.') }
  }
}
