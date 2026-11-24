// Canale remoto (LAD-51): comandi della finestra, stato, rigenerazione della chiave. WebSocket locale su porta libera, niente relay.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { RemotePairStart, RemoteStatus } from '../../shared/protocol.ts'
import { decodePairingUrl, keyFingerprint } from '../../shared/remote/pairing.ts'
import { openDb } from '../db.ts'
import { RemoteChannel } from './channel.ts'

const dirs: string[] = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ladder-channel-'))
  dirs.push(dir)
  const statuses: RemoteStatus[] = []
  const channel = new RemoteChannel({
    host: { snapshot: async () => ({}) as never, handle: async () => null, pageItems: () => ({ sessionId: '', items: [], hasMore: false }), connectionClosed: () => undefined },
    db: openDb(join(dir, 'ladder.db')),
    dataDir: dir,
    appVersion: '1',
    onStatus: (s) => statuses.push(s)
  })
  return { channel, statuses, dir }
}

test('canale spento: niente QR, stato senza impronta né identità creata', async () => {
  delete process.env.LADDER_REMOTE_PORT
  delete process.env.LADDER_RELAY_URL
  const { channel, dir } = setup()
  await channel.configure({ enabled: false, relayUrl: null })
  const status = channel.status()
  assert.equal(status.enabled, false)
  assert.equal(status.fingerprint, null)
  assert.equal(status.allowFull, true)
  await assert.rejects(() => channel.handleCommand({ type: 'remote.pair.start' }), /turned off/)
  assert.deepEqual(await import('node:fs').then((fs) => fs.readdirSync(dir).filter((f) => f.startsWith('remote-'))), [])
  await channel.close()
})

test('QR, password, revoca e rigenerazione della chiave', async () => {
  process.env.LADDER_REMOTE_PORT = '0'
  delete process.env.LADDER_RELAY_URL
  try {
    const { channel, statuses } = setup()
    await channel.configure({ enabled: false, relayUrl: null, allowFull: false })
    const status = channel.status()
    assert.equal(status.enabled, true) // in sviluppo basta LADDER_REMOTE_PORT
    assert.equal(status.allowFull, false)
    assert.ok(status.fingerprint)

    const start = (await channel.handleCommand({ type: 'remote.pair.start' })) as RemotePairStart
    const payload = decodePairingUrl(start.url)
    assert.equal(keyFingerprint(decodeKey(payload.key)), status.fingerprint)
    assert.match(payload.ws ?? '', /^ws:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(payload.relay, undefined)
    assert.equal(start.fingerprint, status.fingerprint)
    assert.equal(channel.status().pairing?.expiresAt, start.expiresAt)
    await channel.handleCommand({ type: 'remote.pair.cancel' })
    assert.equal(channel.status().pairing, null)

    await channel.handleCommand({ type: 'remote.password.set', password: 'abcd1234' })
    assert.equal(channel.status().hasPassword, true)
    await assert.rejects(() => channel.handleCommand({ type: 'remote.password.set', password: 'x' }), /between/)
    await channel.handleCommand({ type: 'remote.password.set', password: null })

    // Un dispositivo finto (riga nel database) si rinomina e si revoca; uno sconosciuto dà errore.
    const device = (channel.access as unknown as { insertDevice(k: string, n: string, p: 'ios'): { id: string } }).insertDevice('K'.repeat(43), 'Old name', 'ios')
    await channel.handleCommand({ type: 'remote.device.rename', deviceId: device.id, name: '  Zoë’s iPhone ' })
    assert.equal(channel.status().devices[0].name, 'Zoë’s iPhone')
    await channel.handleCommand({ type: 'remote.device.revoke', deviceId: device.id })
    assert.equal(channel.status().devices.length, 0)
    await assert.rejects(() => channel.handleCommand({ type: 'remote.device.revoke', deviceId: 'nope' }), /not found/)

    // Rigenerazione: impronta nuova, dispositivi revocati, codice annullato.
    const second = (channel.access as unknown as { insertDevice(k: string, n: string, p: 'ios'): { id: string } }).insertDevice('L'.repeat(43), 'Phone', 'ios')
    await channel.handleCommand({ type: 'remote.pair.start' })
    const before = channel.status().fingerprint
    await channel.handleCommand({ type: 'remote.key.regenerate' })
    const after = channel.status()
    assert.notEqual(after.fingerprint, before)
    assert.equal(after.devices.length, 0)
    assert.equal(after.pairing, null)
    assert.equal(channel.access.device(second.id)?.revokedAt !== null, true)
    assert.ok(statuses.length > 5)
    // Il nuovo QR usa la chiave nuova.
    const again = (await channel.handleCommand({ type: 'remote.pair.start' })) as RemotePairStart
    assert.equal(again.fingerprint, after.fingerprint)
    assert.deepEqual((await channel.handleCommand({ type: 'remote.log.list' })) as unknown, { entries: [], hasMore: false })
    await channel.close()
  } finally {
    delete process.env.LADDER_REMOTE_PORT
  }
})

const decodeKey = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64url'))

test('QR senza strada per il Mac: errore tradotto invece di un QR inutile', async () => {
  delete process.env.LADDER_REMOTE_PORT
  delete process.env.LADDER_RELAY_URL
  const { channel } = setup()
  // Relay con indirizzo non valido: non parte, e non c'è il WebSocket locale.
  await channel.configure({ enabled: true, relayUrl: 'http://not-a-relay.example' })
  await assert.rejects(() => channel.handleCommand({ type: 'remote.pair.start' }), /Cannot reach the relay/)
  await channel.close()
})

test('QR e rigenerazione in fila: il QR non nasce con la chiave vecchia', async () => {
  process.env.LADDER_REMOTE_PORT = '0'
  try {
    const { channel } = setup()
    await channel.configure({ enabled: true, relayUrl: null })
    const regen = channel.handleCommand({ type: 'remote.key.regenerate' })
    const start = channel.handleCommand({ type: 'remote.pair.start' }) as Promise<RemotePairStart>
    await regen
    assert.equal((await start).fingerprint, channel.status().fingerprint)
    await channel.close()
  } finally {
    delete process.env.LADDER_REMOTE_PORT
  }
})
