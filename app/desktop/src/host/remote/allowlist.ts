// Allowlist of remote channel commands. Relative imports and only `import type` from the protocol: the file also runs under `node --test`.
import { REMOTE_MAX_ATTACHMENTS } from '../../shared/protocol.ts'
import { cleanAttachments } from './attachments.ts'
import { FILE_SEARCH_MAX_QUERY } from './file-search.ts'
import { cleanNotifyPrefs } from './push-policy.ts'
import type { Effort, PermissionLevel, RemoteAllowedType, RemoteCommand, RemoteEvent, ToRemoteHost } from '../../shared/protocol.ts'

// `satisfies Record<…, true>` makes the typecheck fail if a type is added (or removed) in only one place:
// missing key or extra key.
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

/** Commands specific to the remote channel, which do not go through Host.handle. */
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

/** Host events forwarded as-is; `snapshot` is not: it is rebuilt as RemoteSnapshot. */
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

// Limits on text fields: the phone's commands are small, and anything larger is not a well-behaved app.
const MAX_ID = 256
const MAX_TEXT = 200_000
const MAX_QUEUE = 50
const MAX_ANSWERS = 32
const MAX_PUSH_TOKEN = 512
const EFFORTS = { low: true, medium: true, high: true, xhigh: true, max: true } satisfies Record<Effort, true>
/** The only `session.create` keys accepted from the phone; anything else (worktree, command…) gets the request rejected. `attachments` are validated images. */
const CREATE_KEYS = new Set(['type', 'projectId', 'agent', 'text', 'model', 'effort', 'permission', 'profileId', 'mode', 'attachments'])

const has = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key)

export function isRemoteCommandType(type: unknown): type is RemoteCommand['type'] {
  return typeof type === 'string' && (has(HOST_COMMANDS, type) || has(REMOTE_ONLY, type))
}

export function isForwardedEventType(type: string): boolean {
  return has(EVENTS, type)
}

export class RemoteCommandError extends Error {
  /** Id of the request, if it could be read: the error comes back with that rid. */
  readonly rid?: string
  /** The error comes from the attachments (the gateway counts it: repeated ones close the connection). */
  readonly attachments: boolean
  constructor(message: string, rid?: string, attachments = false) {
    super(message)
    this.rid = rid
    this.attachments = attachments
  }
}

/** Keys allowed in `session.send` from the phone (the only ones the rebuilt command carries over). */
const SEND_KEYS = new Set(['type', 'sessionId', 'text', 'busy', 'attachments'])
const ATTACHMENT_KEYS = new Set(['name', 'mediaType', 'data'])
/** Commands with arguments: at most this many characters. */
const MAX_ARGS = 2000

/**
 * The number of attachments declared by a raw message, from its shape ONLY (no validation or decoding of the content):
 * used to count images against the limits before working on the bytes. 0 if it is not a `session.send`/`session.create` with an array.
 */
export function declaredAttachments(message: unknown): number {
  if (!isObject(message) || !isObject(message.command)) return 0
  const { type, attachments } = message.command
  return (type === 'session.send' || type === 'session.create') && Array.isArray(attachments) ? attachments.length : 0
}

/**
 * Only these messages may exceed REMOTE_MAX_COMMAND (1 MiB): `session.send`/`session.create` with known fields only and
 * an array of 1..REMOTE_MAX_ATTACHMENTS attachments made of known keys only (parseRemoteMessage validates the content right after).
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

/** {optionId, message?} or {answers}: nothing else, with limited lengths. */
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

/** Each queue item counts only for its id and text: other fields (attachments) are discarded, the real ones stay on the Mac. */
function cleanQueue(queue: unknown): { id: string; text: string }[] | null {
  if (!Array.isArray(queue) || queue.length > MAX_QUEUE) return null
  const out: { id: string; text: string }[] = []
  for (const q of queue) {
    if (!isObject(q) || !isId(q.id) || !isString(q.text) || q.text.length > MAX_TEXT) return null
    out.push({ id: q.id, text: q.text })
  }
  return out
}

/** Checks the shape of a remote client message and that the command is in the allowlist. `messages`: error texts, already translated by the caller. */
export function parseRemoteMessage(value: unknown, messages: { invalid: string; notAllowed: string; attachments?: string }): ToRemoteHost {
  if (!isObject(value)) throw new RemoteCommandError(messages.invalid)
  // A rid that is present but malformed (not text, empty, too long) is a client that does not follow the protocol: the connection is closed.
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
      // `via` is not read: the gateway forces it.
      return ok(isId(command.sessionId) && isId(command.requestId) && validResponse(command.response))
    case 'session.queue.set': {
      const queue = cleanQueue(command.queue)
      return ok(isId(command.sessionId) && queue !== null, queue ? { type: 'session.queue.set', sessionId: command.sessionId as string, queue } : undefined)
    }
    case 'session.queue.deliver':
      return ok(isId(command.sessionId) && isId(command.id) && (command.how === 'steer' || command.how === 'now'))
    case 'session.command': {
      // Name (without "/" or spaces) and arguments; whether the command exists is checked by the gateway against the session's list.
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
      // No extra fields (attachments, command, worktree, branch, source, title…): they do not exist for the phone. `mode`: only 'chat'.
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
      // session.read, session.interrupt, subagent.list: sessionId only.
      return ok(isId(command.sessionId))
  }
}
