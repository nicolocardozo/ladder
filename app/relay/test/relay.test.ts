// Relay tests on a local wrangler dev: `pnpm --filter @ladder/relay test`.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { encodeFrame, RELAY_CLOSE, RELAY_FRAME_CLOSE, RELAY_FRAME_DATA, RELAY_FRAME_OPEN, RELAY_MAX_PHONES, relayEndpoint, relayOrigin, signAuth, type RelayToPhone } from '../../desktop/src/shared/remote/relay-protocol.ts'
import { connectMac, connectPhone, newMacKey, startDev, TestSocket, type Dev } from './harness.ts'

let dev: Dev
before(async () => {
  dev = await startDev()
})
after(async () => {
  await dev?.stop()
})

const bytes = (...n: number[]) => Uint8Array.from(n)
const ready = (mac: TestSocket) => mac.nextJson<{ t: string; maxPhones: number }>((m) => m.t === 'ready')
const status = (phone: TestSocket, from = 0) => phone.nextJson<RelayToPhone>((m) => m.t === 'mac', from)

describe('relay', () => {
  it('answers ping without waking anyone and rejects wrong addresses', async () => {
    assert.equal((await fetch(`${dev.url}/v1/nope?role=mac`)).status, 404)
    const key = newMacKey()
    assert.equal((await fetch(`${dev.url}/v1/${key.id}?role=boh`)).status, 400)
    assert.equal((await fetch(`${dev.url}/v1/${key.id}?role=phone`)).status, 426)
    const phone = await connectPhone(dev, key.id)
    await phone.opened()
    phone.ws.send('ping')
    await phone.until(() => phone.texts.includes('pong'))
    phone.close()
  })

  it('a phone without a Mac receives the status: unknown, never seen', async () => {
    const phone = await connectPhone(dev, newMacKey().id)
    assert.deepEqual(await status(phone), { t: 'mac', online: false, since: null, reason: 'unknown' })
    phone.close()
  })

  it('rejects a Mac with a wrong signature or with a key that does not give that id', async () => {
    const key = newMacKey()
    const bad = await connectMac(dev, key, { tamper: true })
    assert.equal((await bad.until(() => bad.closed)).code, RELAY_CLOSE.authFailed)

    // Valid key but another's id: whoever knows the id cannot take the place.
    const victim = newMacKey()
    const attackerSecret = ed25519.utils.randomSecretKey()
    const mac = new TestSocket(relayEndpoint(dev.url, victim.id, 'mac'))
    const challenge = await mac.nextJson<{ nonce: string }>((m) => 'nonce' in m)
    mac.ws.send(JSON.stringify(signAuth(attackerSecret, relayOrigin(dev.url), victim.id, challenge.nonce)))
    assert.equal((await mac.until(() => mac.closed)).code, RELAY_CLOSE.authFailed)
  })

  it('forwards bytes both ways, without mixing phones', async () => {
    const key = newMacKey()
    const mac = await connectMac(dev, key)
    assert.equal((await ready(mac)).maxPhones, RELAY_MAX_PHONES)
    const a = await connectPhone(dev, key.id)
    assert.deepEqual(await status(a), { t: 'mac', online: true })
    // Wait for a's OPEN before connecting b: that way the frame order is certain.
    const idA = (await mac.until(() => mac.frames().find((f) => f.type === RELAY_FRAME_OPEN))).connId
    const b = await connectPhone(dev, key.id)
    await status(b)
    const idB = (await mac.until(() => mac.frames().filter((f) => f.type === RELAY_FRAME_OPEN)[1])).connId
    assert.notEqual(idA, idB)

    await a.opened()
    a.ws.send(bytes(1, 2, 3))
    const fromA = await mac.until(() => mac.frames().find((f) => f.type === RELAY_FRAME_DATA))
    assert.deepEqual([...fromA.payload], [1, 2, 3])
    assert.equal(fromA.connId, idA)

    mac.ws.send(encodeFrame(RELAY_FRAME_DATA, idB, bytes(9, 9)))
    await b.until(() => b.binaries.length === 1)
    assert.deepEqual([...b.binaries[0]], [9, 9])
    assert.equal(a.binaries.length, 0)

    // A phone that leaves: the Mac receives CLOSE. A Mac that closes a phone: the phone is closed.
    a.close()
    await mac.until(() => mac.frames().find((f) => f.type === RELAY_FRAME_CLOSE && f.connId === idA))
    mac.ws.send(encodeFrame(RELAY_FRAME_CLOSE, idB))
    assert.equal((await b.until(() => b.closed)).code, RELAY_CLOSE.macClosed)
    mac.close()
  })

  it('with the Mac absent drops the phone bytes; when the Mac disappears it notifies with the reason', async () => {
    const key = newMacKey()
    const mac = await connectMac(dev, key)
    const phone = await connectPhone(dev, key.id)
    await status(phone)
    await phone.opened()
    // Disappearance without notice: 'offline', with the time it was last seen.
    const before = Date.now()
    mac.ws.close()
    const off = (await phone.nextJson<Extract<RelayToPhone, { online: false }>>((m) => m.t === 'mac' && !m.online))
    assert.equal(off.reason, 'offline')
    assert.ok(off.since! >= before - 1000 && off.since! <= Date.now() + 1000)
    phone.ws.send(bytes(5))
    phone.close()
    // A new phone sees the same state.
    const late = await connectPhone(dev, key.id)
    assert.deepEqual(await status(late), { t: 'mac', online: false, since: off.since, reason: 'offline' })
    late.close()
  })

  it('asleep and quit: phones know right away; when the Mac returns the link resumes', async () => {
    const key = newMacKey()
    const mac = await connectMac(dev, key)
    await ready(mac)
    const phone = await connectPhone(dev, key.id)
    await status(phone)
    mac.ws.send(JSON.stringify({ t: 'state', state: 'asleep' }))
    const off = await phone.nextJson<Extract<RelayToPhone, { online: false }>>((m) => m.t === 'mac' && !m.online)
    assert.equal(off.reason, 'asleep')
    assert.ok(off.since)
    const late = await connectPhone(dev, key.id)
    assert.deepEqual(await status(late), { t: 'mac', online: false, since: off.since, reason: 'asleep' })
    late.close()

    const mac2 = await connectMac(dev, key)
    await ready(mac2)
    // The phone still connected receives "online" again and the new Mac opens it.
    await phone.nextJson<RelayToPhone>((m) => m.t === 'mac' && m.online, 1)
    await mac2.until(() => mac2.frames().find((f) => f.type === RELAY_FRAME_OPEN))
    mac2.ws.send(JSON.stringify({ t: 'state', state: 'quit' }))
    const quit = await phone.nextJson<Extract<RelayToPhone, { online: false }>>((m) => m.t === 'mac' && !m.online && m.reason === 'quit')
    assert.equal(quit.reason, 'quit')
    phone.close()
  })

  it('rekeyed: the reason stays on the old id, for those who connect later', async () => {
    const key = newMacKey()
    const mac = await connectMac(dev, key)
    await ready(mac)
    const phone = await connectPhone(dev, key.id)
    await status(phone)
    mac.ws.send(JSON.stringify({ t: 'state', state: 'rekeyed' }))
    const off = await phone.nextJson<Extract<RelayToPhone, { online: false }>>((m) => m.t === 'mac' && !m.online)
    assert.equal(off.reason, 'rekeyed')
    assert.ok(off.since)
    phone.close()
    // A phone that arrives later, with the Mac already gone, knows anyway.
    const late = await connectPhone(dev, key.id)
    assert.deepEqual(await status(late), { t: 'mac', online: false, since: off.since, reason: 'rekeyed' })
    late.close()
  })

  it('an authenticated Mac takes the place of the previous one without triggering "offline"', async () => {
    const key = newMacKey()
    const first = await connectMac(dev, key)
    await ready(first)
    const phone = await connectPhone(dev, key.id)
    await status(phone)
    const second = await connectMac(dev, key)
    await ready(second)
    assert.equal((await first.until(() => first.closed)).code, RELAY_CLOSE.replaced)
    await second.until(() => second.frames().find((f) => f.type === RELAY_FRAME_OPEN))
    assert.ok(!phone.json<RelayToPhone>().some((m) => m.t === 'mac' && !m.online))
    phone.close()
    second.close()
  })

  it(`at most ${RELAY_MAX_PHONES} phones per Mac`, async () => {
    const key = newMacKey()
    // With the Mac online the seats are not freed by kicking anyone out: the ninth is refused.
    const mac = await connectMac(dev, key)
    await ready(mac)
    const phones = await Promise.all(Array.from({ length: RELAY_MAX_PHONES }, () => connectPhone(dev, key.id)))
    for (const p of phones) await status(p)
    const extra = await connectPhone(dev, key.id)
    assert.equal((await extra.until(() => extra.closed)).code, RELAY_CLOSE.tooManyPhones)
    assert.ok(phones.every((p) => !p.closed))
    for (const p of phones) p.close()
    mac.close()
  })

  it('a seat freed by a phone that left is immediately reusable', async () => {
    const key = newMacKey()
    const mac = await connectMac(dev, key)
    await ready(mac)
    const phones = await Promise.all(Array.from({ length: RELAY_MAX_PHONES }, () => connectPhone(dev, key.id)))
    for (const p of phones) await status(p)
    phones[0].close()
    await mac.until(() => mac.frames().find((f) => f.type === RELAY_FRAME_CLOSE))
    const again = await connectPhone(dev, key.id)
    assert.deepEqual(await status(again), { t: 'mac', online: true })
    assert.ok(!again.closed)
    for (const p of [...phones, again]) p.close()
    mac.close()
  })

  it('Mac offline: the phone waiting longest makes room for a new one', async () => {
    const key = newMacKey()
    const phones: TestSocket[] = []
    for (let i = 0; i < RELAY_MAX_PHONES; i++) {
      const p = await connectPhone(dev, key.id)
      await status(p)
      phones.push(p)
      await new Promise((r) => setTimeout(r, 5))
    }
    const fresh = await connectPhone(dev, key.id)
    assert.equal((await status(fresh)).t, 'mac')
    const evicted = await phones[0].until(() => phones[0].closed)
    assert.equal(evicted.code, RELAY_CLOSE.idle)
    assert.ok(!fresh.closed)
    for (const p of [...phones, fresh]) p.close()
  })

  it('with too many pending challenges the oldest is closed, and the real Mac still authenticates', async () => {
    const key = newMacKey()
    const pending: TestSocket[] = []
    for (let i = 0; i < 5; i++) {
      const m = new TestSocket(relayEndpoint(dev.url, key.id, 'mac'))
      m.ws.addEventListener('open', () => m.ws.send('ping'))
      await m.nextJson((x) => 'nonce' in (x as object))
      pending.push(m)
    }
    assert.equal((await pending[0].until(() => pending[0].closed)).code, RELAY_CLOSE.authFailed)
    assert.ok(pending.slice(1).every((m) => !m.closed))
    const real = await connectMac(dev, key)
    assert.equal((await ready(real)).maxPhones, RELAY_MAX_PHONES)
    for (const m of pending) m.close()
    real.close()
  })

  it('the Mac signature is valid only for the relay it is meant for', async () => {
    const key = newMacKey()
    const mac = await connectMac(dev, key, { origin: 'https://other-relay.example.com' })
    assert.equal((await mac.until(() => mac.closed)).code, RELAY_CLOSE.authFailed)
  })

  it('a Mac without authentication is closed within about 10 seconds', async () => {
    const mac = new TestSocket(relayEndpoint(dev.url, newMacKey().id, 'mac'))
    mac.ws.addEventListener('open', () => mac.ws.send('ping'))
    const started = Date.now()
    const closed = await mac.until(() => mac.closed, 15_000)
    const elapsed = Date.now() - started
    assert.equal(closed.code, RELAY_CLOSE.authFailed)
    assert.ok(elapsed >= 9000 && elapsed < 13_000, `closed after ${elapsed} ms`)
  })

  it('a Mac sending too many messages is not closed (all phones would drop): the excess is discarded', async () => {
    const key = newMacKey()
    const mac = await connectMac(dev, key)
    await ready(mac)
    const phone = await connectPhone(dev, key.id)
    await status(phone)
    const id = (await mac.until(() => mac.frames().find((f) => f.type === RELAY_FRAME_OPEN))).connId
    for (let i = 0; i < 1500; i++) mac.ws.send(encodeFrame(RELAY_FRAME_DATA, 999, bytes(1)))
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(mac.closed, null)
    assert.equal(phone.closed, null)
    // With the bucket still almost empty, useful traffic resumes as soon as it refills.
    await new Promise((r) => setTimeout(r, 1500))
    mac.ws.send(encodeFrame(RELAY_FRAME_DATA, id, bytes(7)))
    await phone.until(() => phone.binaries.length === 1)
    phone.close()
    mac.close()
  })

  it('closes whoever sends a message that is too large or too many messages', async () => {
    const key = newMacKey()
    const big = await connectPhone(dev, key.id)
    await big.opened()
    big.ws.send(new Uint8Array(65536))
    assert.equal((await big.until(() => big.closed)).code, RELAY_CLOSE.tooBig)

    const flood = await connectPhone(dev, key.id)
    await flood.opened()
    for (let i = 0; i < 400; i++) flood.ws.send(bytes(i & 255))
    assert.equal((await flood.until(() => flood.closed)).code, RELAY_CLOSE.rateLimit)
  })
})
