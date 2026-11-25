// Allowlist dei comandi del canale remoto. Import relativi e solo `import type` dal protocollo: il file gira anche sotto `node --test`.
import { REMOTE_MAX_ATTACHMENTS } from '../../shared/protocol.ts'
import { cleanAttachments } from './attachments.ts'
import { FILE_SEARCH_MAX_QUERY } from './file-search.ts'
import { cleanNotifyPrefs } from './push-policy.ts'
import type { Effort, PermissionLevel, RemoteAllowedType, RemoteCommand, RemoteEvent, ToRemoteHost } from '../../shared/protocol.ts'

// `satisfies Record<…, true>` fa fallire il typecheck se un tipo viene aggiunto (o tolto) da una parte sola:
// chiave mancante o chiave in più.
const HOST_COMMANDS = {
  hello: true,
  'session.read': true,
  'session.send': true,
  'session.interrupt': true,
  'session.respond': true,
  'session.queue.set': true,
  'session.queue.deliver': true,
  'session.permission.set': true,
  'session.commands': true,
  'session.command': true,
  'subagent.list': true
} satisfies Record<RemoteAllowedType, true>

/** Comandi propri del canale remoto, che non passano da Host.handle. */
const REMOTE_ONLY = {
  'session.page': true,
  'session.watch': true,
  'device.push.set': true,
  'device.notify.set': true,
  'device.state': true,
  'project.sessions.archived': true,
  'session.create': true,
  'project.files.search': true,
  'agents.usage': true
} satisfies Record<Exclude<RemoteCommand['type'], RemoteAllowedType>, true>

/** Eventi dell'host inoltrati as-is; `snapshot` no: si ricostruisce come RemoteSnapshot. */
const EVENTS = {
  'remote.prefs': true,
  'remote.defaults': true,
  'profile.upsert': true,
  'profile.removed': true,
  'session.upsert': true,
  'session.items': true,
  'session.subagents': true,
  'sessions.autoArchived': true,
  'project.upsert': true,
  'project.removed': true,
  'projectGroups.changed': true,
  'agent.status': true
} satisfies Record<Exclude<RemoteEvent['type'], 'snapshot'>, true>

const PERMISSIONS = { plan: true, ask: true, edit: true, full: true } satisfies Record<PermissionLevel, true>

// Limiti dei campi di testo: i comandi del telefono sono piccoli, quello che li supera non è un'app che si comporta bene.
const MAX_ID = 256
const MAX_TEXT = 200_000
const MAX_QUEUE = 50
const MAX_ANSWERS = 32
const MAX_PUSH_TOKEN = 512
const EFFORTS = { low: true, medium: true, high: true, xhigh: true, max: true } satisfies Record<Effort, true>
/** LAD-89: le sole chiavi di `session.create` dal telefono; tutto il resto (worktree, comando…) fa rifiutare la richiesta. LAD-92: `attachments` sono immagini validate. */
const CREATE_KEYS = new Set(['type', 'projectId', 'agent', 'text', 'model', 'effort', 'permission', 'profileId', 'mode', 'attachments'])

const has = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key)

export function isRemoteCommandType(type: unknown): type is RemoteCommand['type'] {
  return typeof type === 'string' && (has(HOST_COMMANDS, type) || has(REMOTE_ONLY, type))
}

export function isForwardedEventType(type: string): boolean {
  return has(EVENTS, type)
}

export class RemoteCommandError extends Error {
  /** Id della richiesta, se è stato possibile leggerlo: l'errore torna con quel rid. */
  readonly rid?: string
  /** LAD-92: l'errore viene dagli allegati (il gateway lo conta: ripetuti, chiudono la connessione). */
  readonly attachments: boolean
  constructor(message: string, rid?: string, attachments = false) {
    super(message)
    this.rid = rid
    this.attachments = attachments
  }
}

/** Chiavi ammesse in `session.send` dal telefono (le sole che il comando ricostruito riporta). */
const SEND_KEYS = new Set(['type', 'sessionId', 'text', 'busy', 'attachments'])
const ATTACHMENT_KEYS = new Set(['name', 'mediaType', 'data'])
/** Commandi con argomenti: al massimo tanti caratteri. */
const MAX_ARGS = 2000

/**
 * LAD-92: il numero di allegati dichiarati da un messaggio grezzo, SOLO dalla forma (nessuna validazione né decodifica del contenuto):
 * serve a contare le immagini sui limiti prima di lavorare sui byte. 0 se non è un `session.send`/`session.create` con un array.
 */
export function declaredAttachments(message: unknown): number {
  if (!isObject(message) || !isObject(message.command)) return 0
  const { type, attachments } = message.command
  return (type === 'session.send' || type === 'session.create') && Array.isArray(attachments) ? attachments.length : 0
}

/**
 * LAD-92: solo questi messaggi possono superare REMOTE_MAX_COMMAND (1 MiB): `session.send`/`session.create` con soli campi noti e
 * un array di 1..REMOTE_MAX_ATTACHMENTS allegati fatti di sole chiavi note (il contenuto lo valida parseRemoteMessage subito dopo).
 */
export function carriesAttachmentsShape(message: unknown): boolean {
  if (!isObject(message) || !isObject(message.command) || !Object.keys(message).every((k) => k === 'rid' || k === 'command')) return false
  const { command } = message
  const keys = command.type === 'session.send' ? SEND_KEYS : command.type === 'session.create' ? CREATE_KEYS : null
  const list = command.attachments
  return !!keys && Object.keys(command).every((k) => keys.has(k)) && Array.isArray(list) && list.length >= 1 && list.length <= REMOTE_MAX_ATTACHMENTS && list.every((a) => isObject(a) && Object.keys(a).every((k) => ATTACHMENT_KEYS.has(k)))
}

const isString = (v: unknown): v is string => typeof v === 'string'
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
const isId = (v: unknown): v is string => isString(v) && v.length > 0 && v.length <= MAX_ID

/** {optionId, message?} oppure {answers}: nient'altro, con lunghezze limitate. */
function validResponse(response: unknown): boolean {
  if (!isObject(response)) return false
  const keys = Object.keys(response)
  if ('answers' in response) {
    const { answers } = response
    if (keys.length !== 1 || !isObject(answers)) return false
    const entries = Object.entries(answers)
    return entries.length <= MAX_ANSWERS && entries.every(([k, v]) => k.length <= MAX_ID && isString(v) && v.length <= MAX_TEXT)
  }
  if (!isId(response.optionId) || keys.some((k) => k !== 'optionId' && k !== 'message')) return false
  return response.message === undefined || (isString(response.message) && response.message.length <= MAX_TEXT)
}

/** Ogni elemento della coda conta solo per id e testo: altri campi (allegati) si scartano, quelli veri restano sul Mac. */
function cleanQueue(queue: unknown): { id: string; text: string }[] | null {
  if (!Array.isArray(queue) || queue.length > MAX_QUEUE) return null
  const out: { id: string; text: string }[] = []
  for (const q of queue) {
    if (!isObject(q) || !isId(q.id) || !isString(q.text) || q.text.length > MAX_TEXT) return null
    out.push({ id: q.id, text: q.text })
  }
  return out
}

/** Controlla la forma di un messaggio del client remoto e che il comando sia in allowlist. `messages`: testi degli errori, già tradotti dal chiamante. */
export function parseRemoteMessage(value: unknown, messages: { invalid: string; notAllowed: string; attachments?: string }): ToRemoteHost {
  if (!isObject(value)) throw new RemoteCommandError(messages.invalid)
  // Un rid presente ma storto (non testo, vuoto, troppo lungo) è un client che non rispetta il protocollo: la connessione si chiude.
  if (value.rid !== undefined && !(isString(value.rid) && value.rid.length > 0 && value.rid.length <= 128)) throw new Error('invalid rid')
  const rid = value.rid as string | undefined
  const command = value.command
  if (!isObject(command)) throw new RemoteCommandError(messages.invalid, rid)
  if (!isRemoteCommandType(command.type)) throw new RemoteCommandError(messages.notAllowed, rid)
  const ok = (valid: boolean, clean?: RemoteCommand): ToRemoteHost => {
    if (!valid) throw new RemoteCommandError(messages.invalid, rid)
    return { rid, command: clean ?? (command as unknown as RemoteCommand) }
  }
  switch (command.type) {
    case 'hello':
      return ok(true)
    case 'session.send': {
      const attachments = command.attachments === undefined || command.attachments === null ? [] : cleanAttachments(command.attachments)
      if (!attachments) throw new RemoteCommandError(messages.attachments ?? messages.invalid, rid, true)
      const valid = isId(command.sessionId) && isString(command.text) && command.text.length <= MAX_TEXT && (command.busy === undefined || command.busy === 'queue' || command.busy === 'steer')
      return ok(valid, valid ? ({ type: 'session.send', sessionId: command.sessionId, text: command.text, ...(command.busy ? { busy: command.busy } : {}), ...(attachments.length ? { attachments } : {}) } as RemoteCommand) : undefined)
    }
    case 'session.respond':
      // `via` non si legge: lo forza il gateway.
      return ok(isId(command.sessionId) && isId(command.requestId) && validResponse(command.response))
    case 'session.queue.set': {
      const queue = cleanQueue(command.queue)
      return ok(isId(command.sessionId) && queue !== null, queue ? { type: 'session.queue.set', sessionId: command.sessionId as string, queue } : undefined)
    }
    case 'session.queue.deliver':
      return ok(isId(command.sessionId) && isId(command.id) && (command.how === 'steer' || command.how === 'now'))
    case 'session.command': {
      // LAD-92: nome (senza "/" né spazi) e argomenti; che il comando esista lo controlla il gateway sull'elenco della sessione.
      const valid = Object.keys(command).every((k) => k === 'type' || k === 'sessionId' || k === 'name' || k === 'args') && isId(command.sessionId) && isString(command.name) && /^[^\s/]{1,128}$/.test(command.name) && isString(command.args) && command.args.length <= MAX_ARGS
      return ok(valid, valid ? ({ type: 'session.command', sessionId: command.sessionId, name: command.name, args: command.args } as RemoteCommand) : undefined)
    }
    case 'session.permission.set':
      return ok(isId(command.sessionId) && isString(command.permission) && has(PERMISSIONS, command.permission))
    case 'session.page':
      return ok(isId(command.sessionId) && (command.before === undefined || isCount(command.before)) && (command.limit === undefined || isCount(command.limit)))
    case 'session.watch':
      return ok(isId(command.sessionId) && typeof command.on === 'boolean')
    case 'project.sessions.archived':
      return ok(isId(command.projectId) && (command.before === undefined || isCount(command.before)) && (command.limit === undefined || isCount(command.limit)))
    case 'session.create': {
      // Nessun campo in più (allegati, command, worktree, branch, source, title…): per il telefono non esistono. `mode`: solo 'chat'.
      const strict = Object.keys(command).every((k) => CREATE_KEYS.has(k)) && (command.mode === undefined || command.mode === 'chat')
      const attachments = command.attachments === undefined || command.attachments === null ? [] : cleanAttachments(command.attachments)
      if (strict && !attachments) throw new RemoteCommandError(messages.attachments ?? messages.invalid, rid, true)
      const valid =
        strict &&
        isId(command.projectId) &&
        isId(command.agent) &&
        isString(command.text) &&
        (command.text.trim().length > 0 || (attachments?.length ?? 0) > 0) &&
        command.text.length <= MAX_TEXT &&
        (command.model == null || isId(command.model)) &&
        (command.effort == null || (isString(command.effort) && has(EFFORTS, command.effort))) &&
        isString(command.permission) &&
        has(PERMISSIONS, command.permission) &&
        (command.profileId === undefined || command.profileId === null || isId(command.profileId))
      return ok(valid, valid ? ({ type: 'session.create', projectId: command.projectId, agent: command.agent, text: command.text, model: (command.model as string | null | undefined) ?? null, effort: (command.effort as Effort | null | undefined) ?? null, permission: command.permission, ...(command.profileId ? { profileId: command.profileId } : {}), mode: 'chat', ...(attachments?.length ? { attachments } : {}) } as RemoteCommand) : undefined)
    }
    case 'project.files.search':
      return ok(isId(command.projectId) && isString(command.query) && command.query.length <= FILE_SEARCH_MAX_QUERY && (command.limit === undefined || isCount(command.limit)), isId(command.projectId) && isString(command.query) ? ({ type: 'project.files.search', projectId: command.projectId, query: command.query, ...(isCount(command.limit) ? { limit: command.limit as number } : {}) } as RemoteCommand) : undefined)
    case 'agents.usage':
      return ok(isId(command.agent) && (command.profileId === undefined || isId(command.profileId)), isId(command.agent) ? ({ type: 'agents.usage', agent: command.agent, ...(command.profileId ? { profileId: command.profileId } : {}) } as RemoteCommand) : undefined)
    case 'device.push.set':
      return ok((command.token === null || (isString(command.token) && command.token.length > 0 && command.token.length <= MAX_PUSH_TOKEN)) && (command.platform === 'ios' || command.platform === 'android'))
    case 'device.notify.set': {
      const prefs = cleanNotifyPrefs(command.prefs)
      return ok(prefs !== null, prefs ? { type: 'device.notify.set', prefs } : undefined)
    }
    case 'device.state':
      return ok(typeof command.foreground === 'boolean')
    default:
      // session.read, session.interrupt, subagent.list: solo sessionId.
      return ok(isId(command.sessionId))
  }
}
