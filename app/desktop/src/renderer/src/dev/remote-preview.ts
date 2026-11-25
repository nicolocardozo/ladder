// Fake host for phones: answers remote.* commands as the real host would and sends `remote.status`, `remote.paired` and `remote.log`,
// so Settings → Devices, the QR, revocation and the indicator in the top bar can be tried without Electron.
import { REMOTE_PAIRING_TTL_MS, REMOTE_PASSWORD_MAX, REMOTE_PASSWORD_MIN, type HostCommand, type RemoteDeviceInfo, type RemoteLogEntry, type RemoteStatus } from '@shared/protocol'
import { useApp } from '@/store/app-store'
import { emitPreviewEvent, registerPreviewHandler } from './shortcuts-preview'

let installed = false
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

const FINGERPRINT = '7F3A 91C2 · E04B 5D18'
const device = (id: string, name: string, platform: RemoteDeviceInfo['platform'], patch: Partial<RemoteDeviceInfo>): RemoteDeviceInfo => ({
  id,
  name,
  platform,
  createdAt: Date.now() - 12 * DAY,
  lastSeenAt: null,
  connected: false,
  ...patch
})

function twoDevices(): RemoteDeviceInfo[] {
  const now = Date.now()
  return [
    device('d-iphone', 'Zoë’s iPhone', 'ios', { createdAt: now - 12 * DAY, lastSeenAt: now, connected: true }),
    device('d-pixel', 'Pixel 9', 'android', { createdAt: now - 40 * DAY, lastSeenAt: now - 3 * HOUR })
  ]
}

let status: RemoteStatus = {
  enabled: false,
  relayUrl: null,
  relayId: 'mac-4f2a9c',
  macName: 'Zoë’s MacBook Pro',
  fingerprint: FINGERPRINT,
  hasPassword: true,
  allowFull: true,
  devices: twoDevices(),
  connectedCount: 1,
  pairing: null
}

/** Log entries, most recent first. The first two point to the subagents preview session (when it exists, it opens with a click). */
function logEntries(): RemoteLogEntry[] {
  const now = Date.now()
  const rows: [string, string, RemoteLogEntry['action'], string | null, string][] = [
    ['d-iphone', 'Zoë’s iPhone', 'respond', 'preview-agents', 'Approved: Run command'],
    ['d-iphone', 'Zoë’s iPhone', 'send', 'preview-agents', 'Message (42 chars)'],
    ['d-iphone', 'Zoë’s iPhone', 'permission', null, 'Permission → Edit'],
    ['d-pixel', 'Pixel 9', 'interrupt', null, 'Stopped'],
    ['d-pixel', 'Pixel 9', 'queue', null, 'Queued message (18 chars)'],
    ['d-pixel', 'Pixel 9', 'respond', null, 'Rejected: Edit file'],
    ['d-iphone', 'Zoë’s iPhone', 'respond', null, 'Approved: Run command'],
    ['d-iphone', 'Zoë’s iPhone', 'send', null, 'Message (96 chars)'],
    ['d-pixel', 'Pixel 9', 'respond', null, 'Approved: Write file'],
    ['d-iphone', 'Zoë’s iPhone', 'permission', null, 'Permission → Plan'],
    ['d-iphone', 'Zoë’s iPhone', 'respond', null, 'Approved: Run command'],
    ['d-pixel', 'Pixel 9', 'send', null, 'Message (12 chars)']
  ]
  const gaps = [2 * MIN, 14 * MIN, 52 * MIN, 3 * HOUR, 5 * HOUR, 9 * HOUR, 1 * DAY, 1 * DAY + 2 * HOUR, 2 * DAY, 2 * DAY + HOUR, 3 * DAY, 4 * DAY]
  return rows.map(([deviceId, deviceName, action, sessionId, detail], i) => ({ id: rows.length - i, deviceId, deviceName, at: now - gaps[i], action, sessionId, detail }))
}
let log = logEntries()

const publish = (): void => {
  status = { ...status, connectedCount: status.devices.filter((d) => d.connected).length }
  useApp.setState({ remote: status })
  emitPreviewEvent({ type: 'remote.status', status })
}

/** Fake address, as long as a real one (about 330 characters): the QR has the same density. It is not a valid code. */
function fakePairUrl(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let seed = Date.now() % 9973
  let out = ''
  for (let i = 0; i < 330; i++) {
    seed = (seed * 31 + 17) % 9973
    out += alphabet[seed % alphabet.length]
  }
  return `ladder://pair#${out}`
}

let expiry: number | undefined
function setPairing(expiresAt: number | null): void {
  window.clearTimeout(expiry)
  status = { ...status, pairing: expiresAt ? { expiresAt } : null }
  if (expiresAt) expiry = window.setTimeout(() => (setPairing(null), publish()), Math.max(0, expiresAt - Date.now()))
}

export type PhoneScenario = 'off' | 'on' | 'empty' | 'busy'

/** Puts the state into a scenario: on/off, with 2 phones, without phones, or with 3 connected phones (indicator with the number). */
export function setPhoneScenario(scenario: PhoneScenario): void {
  const prefs = useApp.getState().prefs
  const enabled = scenario !== 'off'
  if (prefs) useApp.getState().setPrefs({ ...prefs, remote: { enabled, relayUrl: prefs.remote?.relayUrl ?? null, allowFull: prefs.remote?.allowFull ?? true } })
  const now = Date.now()
  const devices =
    scenario === 'empty'
      ? []
      : scenario === 'busy'
        ? [...twoDevices().map((d) => ({ ...d, connected: true, lastSeenAt: now })), device('d-ipad', 'iPad mini', 'ios', { connected: true, lastSeenAt: now, createdAt: now - 3 * DAY })]
        : twoDevices()
  setPairing(null)
  status = { ...status, enabled, devices }
  log = scenario === 'empty' ? [] : logEntries()
  publish()
}

/** A phone pairs: `remote.paired` event (the QR dialog shows the outcome and closes) and `remote.status` with the new device. */
export function emitPhonePaired(): void {
  const added = device(`d-new-${Date.now()}`, 'Marta’s iPhone', 'ios', { createdAt: Date.now(), lastSeenAt: Date.now(), connected: true })
  setPairing(null)
  status = { ...status, devices: [added, ...status.devices] }
  emitPreviewEvent({ type: 'remote.paired', device: added })
  publish()
}

/** A new log entry, as when the phone answers a request. */
export function emitPhoneLog(): void {
  const entry: RemoteLogEntry = { id: (log[0]?.id ?? 0) + 1, deviceId: 'd-iphone', deviceName: 'Zoë’s iPhone', at: Date.now(), action: 'respond', sessionId: 'preview-agents', detail: 'Approved: Run command' }
  log = [entry, ...log]
  emitPreviewEvent({ type: 'remote.log', entry })
}

export function installRemotePreview(): void {
  if (installed) return
  installed = true
  // The "Access from your phone" switch changes the main preference; the fake host follows it as the real one would.
  let lastEnabled = Boolean(useApp.getState().prefs?.remote?.enabled)
  useApp.subscribe((state) => {
    const enabled = Boolean(state.prefs?.remote?.enabled)
    if (enabled === lastEnabled) return
    lastEnabled = enabled
    if (!enabled) setPairing(null)
    status = { ...status, enabled }
    publish()
  })
  const prefsRelay = () => useApp.getState().prefs?.remote?.relayUrl ?? null
  registerPreviewHandler((command: HostCommand) => {
    switch (command.type) {
      case 'remote.status':
        return { ok: true, data: { ...status, relayUrl: status.enabled ? prefsRelay() ?? 'wss://relay.ladder.app' : null } }
      case 'remote.pair.start': {
        if (!status.enabled) return { ok: false, error: 'Turn on “Access from your phone” in Settings first.' }
        const expiresAt = Date.now() + REMOTE_PAIRING_TTL_MS
        setPairing(expiresAt)
        publish()
        return { ok: true, data: { url: fakePairUrl(), payload: {}, fingerprint: FINGERPRINT, expiresAt } }
      }
      case 'remote.pair.cancel':
        if (status.pairing) (setPairing(null), publish())
        return { ok: true, data: null }
      case 'remote.password.set': {
        const { password } = command
        if (password !== null && (password.length < REMOTE_PASSWORD_MIN || password.length > REMOTE_PASSWORD_MAX)) return { ok: false, error: `The password must have ${REMOTE_PASSWORD_MIN} to ${REMOTE_PASSWORD_MAX} characters.` }
        status = { ...status, hasPassword: password !== null }
        publish()
        return { ok: true, data: null }
      }
      case 'remote.device.revoke':
        status = { ...status, devices: status.devices.filter((d) => d.id !== command.deviceId) }
        publish()
        return { ok: true, data: null }
      case 'remote.device.rename': {
        const name = command.name.trim()
        if (!name || name.length > 80) return { ok: false, error: 'The name must have 1 to 80 characters.' }
        status = { ...status, devices: status.devices.map((d) => (d.id === command.deviceId ? { ...d, name } : d)) }
        publish()
        return { ok: true, data: null }
      }
      case 'remote.key.regenerate':
        setPairing(null)
        status = { ...status, devices: [], fingerprint: 'B81D 04E7 · 5A2C 93F0', relayId: 'mac-91d7e0' }
        publish()
        return { ok: true, data: null }
      case 'remote.log.list': {
        const from = command.before === undefined ? log : log.filter((entry) => entry.id < command.before!)
        const limit = Math.min(command.limit ?? 50, 200)
        return { ok: true, data: { entries: from.slice(0, limit), hasMore: from.length > limit } }
      }
      default:
        return undefined
    }
  })
}
