// Allowlist dei comandi del canale remoto. Import relativi e solo `import type` dal protocollo: il file gira anche sotto `node --test`.
import { cleanNotifyPrefs } from './push-policy.ts'
import type { PermissionLevel, RemoteAllowedType, RemoteCommand, RemoteEvent, ToRemoteHost } from '../../shared/protocol.ts'

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
  'subagent.list': true
} satisfies Record<RemoteAllowedType, true>

/** Comandi propri del canale remoto, che non passano da Host.handle. */
const REMOTE_ONLY = {
  'session.page': true,
  'session.watch': true,
  'device.push.set': true,
  'device.notify.set': true,
  'device.state': true,
  'project.sessions.archived': true
} satisfies Record<Exclude<RemoteCommand['type'], RemoteAllowedType>, true>

/** Eventi dell'host inoltrati as-is; `snapshot` no: si ricostruisce come RemoteSnapshot. */
const EVENTS = {
  'remote.prefs': true,
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
  constructor(message: string, rid?: string) {
    super(message)
    this.rid = rid
  }
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
export function parseRemoteMessage(value: unknown, messages: { invalid: string; notAllowed: string }): ToRemoteHost {
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
    case 'session.send':
      return ok(isId(command.sessionId) && isString(command.text) && command.text.length <= MAX_TEXT && (command.busy === undefined || command.busy === 'queue' || command.busy === 'steer'))
    case 'session.respond':
      // `via` non si legge: lo forza il gateway.
      return ok(isId(command.sessionId) && isId(command.requestId) && validResponse(command.response))
    case 'session.queue.set': {
      const queue = cleanQueue(command.queue)
      return ok(isId(command.sessionId) && queue !== null, queue ? { type: 'session.queue.set', sessionId: command.sessionId as string, queue } : undefined)
    }
    case 'session.queue.deliver':
      return ok(isId(command.sessionId) && isId(command.id) && (command.how === 'steer' || command.how === 'now'))
    case 'session.permission.set':
      return ok(isId(command.sessionId) && isString(command.permission) && has(PERMISSIONS, command.permission))
    case 'session.page':
      return ok(isId(command.sessionId) && (command.before === undefined || isCount(command.before)) && (command.limit === undefined || isCount(command.limit)))
    case 'session.watch':
      return ok(isId(command.sessionId) && typeof command.on === 'boolean')
    case 'project.sessions.archived':
      return ok(isId(command.projectId) && (command.before === undefined || isCount(command.before)) && (command.limit === undefined || isCount(command.limit)))
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
