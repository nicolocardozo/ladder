import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REMOTE_FRAME_END, REMOTE_FRAME_MORE, REMOTE_PROTOCOL_VERSION } from '../protocol.ts'
import { FrameReassembler, REMOTE_MAX_FRAME, splitFrames } from './frames.ts'
import { generateKeyPair } from './noise.ts'
import { clientHandshake, serverHandshake, type RemoteSession } from './session.ts'

function pair(): { client: RemoteSession; server: RemoteSession } {
  const identity = generateKeyPair()
  const c = clientHandshake({ macPublicKey: identity.publicKey, hello: { device: 'test' } })
  const s = serverHandshake({ identity, hello: { mac: 'mac', app: '0' } })
  const { reply, session: server } = s.accept(c.start())
  const { session: client, hello } = c.finish(reply)
  assert.deepEqual(hello, { v: REMOTE_PROTOCOL_VERSION, mac: 'mac', app: '0' })
  return { client, server }
}

test('un JSON corto è un solo frame END', () => {
  const frames = splitFrames('{"a":1}')
  assert.equal(frames.length, 1)
  assert.equal(frames[0][0], REMOTE_FRAME_END)
})

test('un JSON lungo si spezza in frame da al massimo 65519 byte e si ricompone', () => {
  const json = JSON.stringify({ text: 'è'.repeat(200_000) }) // UTF-8 a più byte: il taglio cade anche dentro un carattere
  const frames = splitFrames(json)
  assert.ok(frames.length > 4)
  for (const f of frames) assert.ok(f.length <= REMOTE_MAX_FRAME)
  frames.slice(0, -1).forEach((f) => assert.equal(f[0], REMOTE_FRAME_MORE))
  assert.equal(frames.at(-1)![0], REMOTE_FRAME_END)
  const r = new FrameReassembler()
  const out = frames.map((f) => r.push(f)).filter((x) => x !== null)
  assert.deepEqual(out, [json])
})

test('frame esattamente al limite', () => {
  const json = 'x'.repeat(REMOTE_MAX_FRAME - 1)
  const frames = splitFrames(json)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].length, REMOTE_MAX_FRAME)
  assert.equal(splitFrames(json + 'x').length, 2)
})

test('messaggi consecutivi si ricompongono separatamente', () => {
  const r = new FrameReassembler()
  assert.equal(r.push(splitFrames('"uno"')[0]), '"uno"')
  assert.equal(r.push(splitFrames('"due"')[0]), '"due"')
})

test('un messaggio oltre il limite fa lanciare il reassembler', () => {
  const r = new FrameReassembler(100_000)
  const frames = splitFrames('"' + 'a'.repeat(150_000) + '"')
  assert.equal(r.push(frames[0]), null)
  assert.throws(() => r.push(frames[1]))
})

test('flag non valido, frame vuoto e UTF-8 rotto sono rifiutati', () => {
  assert.throws(() => new FrameReassembler().push(Uint8Array.of(7, 65)))
  assert.throws(() => new FrameReassembler().push(new Uint8Array(0)))
  assert.throws(() => new FrameReassembler().push(Uint8Array.of(REMOTE_FRAME_END, 0xff, 0xfe)))
})

test('RemoteSession: JSON oltre 65519 byte arriva intero su più messaggi Noise', () => {
  const { client, server } = pair()
  const message = { kind: 'event', blob: 'z'.repeat(300_000) }
  const sealed = client.seal(message)
  assert.ok(sealed.length > 1)
  for (const m of sealed) assert.ok(m.length <= 65535)
  const results = sealed.map((m) => server.open<typeof message>(m))
  assert.deepEqual(results.slice(0, -1), new Array(sealed.length - 1).fill(null))
  assert.deepEqual(results.at(-1), message)
})

test('RemoteSession: un messaggio sopra REMOTE_MAX_MESSAGE chiude (lancia) in ricezione', () => {
  const identity = generateKeyPair()
  const c = clientHandshake({ macPublicKey: identity.publicKey, hello: { device: 'test' } })
  const s = serverHandshake({ identity, hello: { mac: 'mac', app: '0' } })
  const { reply, session: server } = s.accept(c.start())
  const { session: client } = c.finish(reply)
  // 16 MiB + 1 byte di JSON: il limite è sui byte ricomposti.
  const sealed = client.seal('a'.repeat(16 * 1024 * 1024))
  assert.throws(() => {
    for (const m of sealed) server.open(m)
  })
})

test('RemoteSession: replay, riordino e riflessione chiudono', () => {
  const a = pair()
  const [m1] = a.client.seal({ n: 1 })
  assert.deepEqual(a.server.open(m1), { n: 1 })
  assert.throws(() => a.server.open(m1))

  const b = pair()
  const [x, y] = [b.client.seal({ n: 1 })[0], b.client.seal({ n: 2 })[0]]
  assert.throws(() => b.server.open(y))
  assert.throws(() => b.server.open(x))

  const c = pair()
  assert.throws(() => c.client.open(c.client.seal({ n: 1 })[0]))
})

test('handshake: versione diversa rifiutata dal Mac', () => {
  const identity = generateKeyPair()
  const s = serverHandshake({ identity, hello: { mac: 'mac', app: '0' } })
  // Un client del futuro: stesso handshake ma v diversa. Si ottiene sostituendo l'hello a mano.
  const bad = clientHandshake({ macPublicKey: identity.publicKey, hello: { device: 'x', v: REMOTE_PROTOCOL_VERSION + 1 } as never })
  assert.throws(() => s.accept(bad.start()), /versione/)
})

test('un frame MORE non pieno (vuoto o corto) è rifiutato: niente memoria consumata a costo zero', () => {
  const r = new FrameReassembler()
  assert.throws(() => r.push(Uint8Array.of(REMOTE_FRAME_MORE)))
  assert.throws(() => new FrameReassembler().push(Uint8Array.of(REMOTE_FRAME_MORE, 65, 66)))
  const full = new Uint8Array(REMOTE_MAX_FRAME)
  full[0] = REMOTE_FRAME_MORE
  assert.equal(new FrameReassembler().push(full), null)
})

test('milioni di frame MORE pieni si fermano al limite del messaggio', () => {
  const r = new FrameReassembler(1024 * 1024)
  const full = new Uint8Array(REMOTE_MAX_FRAME)
  full[0] = REMOTE_FRAME_MORE
  let pushed = 0
  assert.throws(() => {
    for (;;) {
      r.push(full)
      pushed++
    }
  })
  assert.ok(pushed <= 17)
})

test('l’host accetta comandi fino a REMOTE_MAX_COMMAND, il client fino a REMOTE_MAX_MESSAGE', () => {
  const identity = generateKeyPair()
  const c = clientHandshake({ macPublicKey: identity.publicKey, hello: { device: 't' } })
  const s = serverHandshake({ identity, hello: { mac: 'm', app: '0' } })
  const { reply, session: server } = s.accept(c.start())
  const { session: client } = c.finish(reply)
  const big = 'a'.repeat(2 * 1024 * 1024)
  assert.throws(() => {
    for (const m of client.seal(big)) server.open(m)
  })
  // Nel verso opposto (snapshot) lo stesso messaggio è ammesso.
  const pair2 = pair()
  const sealed = pair2.server.seal(big)
  assert.equal(sealed.map((m) => pair2.client.open<string>(m)).at(-1), big)
})

test('LAD-92: lastSize è la dimensione UTF-8 del messaggio ricomposto, senza ricodificarlo', () => {
  const r = new FrameReassembler()
  const json = JSON.stringify({ text: 'è'.repeat(100_000) })
  let out: string | null = null
  for (const f of splitFrames(json)) out = r.push(f)
  assert.equal(out, json)
  assert.equal(r.lastSize, new TextEncoder().encode(json).length)
  const { client, server } = pair()
  const msg = { a: 'è'.repeat(70_000) }
  let got: unknown = null
  for (const bytes of client.seal(msg)) got = server.open(bytes) ?? got
  assert.deepEqual(got, msg)
  assert.equal(server.lastSize, new TextEncoder().encode(JSON.stringify(msg)).length)
})
