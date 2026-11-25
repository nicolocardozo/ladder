// Prove di Noise_NK_25519_ChaChaPoly_SHA256: `node --test src/shared/remote/*.test.ts` (Node 24, type stripping).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPair, keyPairFromSecret, NoiseInitiator, NoiseResponder, type NoiseTransport } from './noise.ts'

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'))
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex')
const text = (s: string): Uint8Array => new TextEncoder().encode(s)
const prologue = text('test-prologue')

function handshake(): { client: NoiseTransport; server: NoiseTransport } {
  const mac = generateKeyPair()
  const init = new NoiseInitiator({ prologue, remoteStatic: mac.publicKey })
  const resp = new NoiseResponder({ prologue, staticKey: mac })
  assert.deepEqual(resp.readMessage1(init.writeMessage1(text('hello'))), text('hello'))
  const { message, transport: server } = resp.writeMessage2(text('world'))
  const { payload, transport: client } = init.readMessage2(message)
  assert.deepEqual(payload, text('world'))
  return { client, server }
}

// Vettore ufficiale (cacophony, usato anche da snow): Noise_NK_25519_ChaChaPoly_SHA256.
test('vettore ufficiale cacophony per NK 25519 ChaChaPoly SHA256', () => {
  const v = {
    prologue: hex('4a6f686e2047616c74'),
    initEphemeral: hex('893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a'),
    initRemoteStatic: hex('31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62'),
    respStatic: hex('4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893'),
    respEphemeral: hex('bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b'),
    handshakeHash: '2efa38a9c7c93ac98f3a097af25c2f58b9e7673787717bc27e98827118c2c1a5',
    messages: [
      ['4c756477696720766f6e204d69736573', 'ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79448134d00711fdb390a0d178fa008f6d47d2891e5ea18ae136c3b4c23ac384efb0'],
      ['4d757272617920526f746862617264', '95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088438ea16e3701bc0d77744f117bee22451c9afa7f4cdbbcff00c04a8ee0913c88'],
      ['462e20412e20486179656b', 'a62de29ce27cb80245d440d986ed816c156e9d757d7008df2198b0'],
      ['4361726c204d656e676572', '174a35f11c689f4530d7208618e0564ae12f2f50ba8eb4df5382ff'],
      ['4a65616e2d426170746973746520536179', '337e475ebb8eae60f91974c4e455a5af38d1d8628d1803b160d60442874b0a1777'],
      ['457567656e2042f6686d20766f6e2042617765726b', '047e80e060b7bb08b53c5a23dfe9920cae135b9d1dc6302fc475003062723700366346ac9d']
    ]
  }
  const staticKey = keyPairFromSecret(v.respStatic)
  assert.equal(toHex(staticKey.publicKey), toHex(v.initRemoteStatic))
  const init = new NoiseInitiator({ prologue: v.prologue, remoteStatic: v.initRemoteStatic, ephemeral: keyPairFromSecret(v.initEphemeral) })
  const resp = new NoiseResponder({ prologue: v.prologue, staticKey, ephemeral: keyPairFromSecret(v.respEphemeral) })

  const m1 = init.writeMessage1(hex(v.messages[0][0]))
  assert.equal(toHex(m1), v.messages[0][1])
  assert.equal(toHex(resp.readMessage1(m1)), v.messages[0][0])
  const { message: m2, transport: server } = resp.writeMessage2(hex(v.messages[1][0]))
  assert.equal(toHex(m2), v.messages[1][1])
  const { payload, transport: client } = init.readMessage2(m2)
  assert.equal(toHex(payload), v.messages[1][0])
  assert.equal(toHex(client.handshakeHash), v.handshakeHash)
  assert.equal(toHex(server.handshakeHash), v.handshakeHash)

  // Dal terzo messaggio in poi: trasporto, a turno iniziatore e responder.
  v.messages.slice(2).forEach(([plain, cipher], i) => {
    const [sender, receiver] = i % 2 === 0 ? [client, server] : [server, client]
    const sealed = sender.encrypt(hex(plain))
    assert.equal(toHex(sealed), cipher)
    assert.equal(toHex(receiver.decrypt(sealed)), plain)
  })
})

test('handshake e trasporto nei due versi', () => {
  const { client, server } = handshake()
  assert.deepEqual(client.handshakeHash, server.handshakeHash)
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(server.decrypt(client.encrypt(text(`a${i}`))), text(`a${i}`))
    assert.deepEqual(client.decrypt(server.encrypt(text(`b${i}`))), text(`b${i}`))
  }
})

test('un prologo diverso fa fallire l’handshake', () => {
  const mac = generateKeyPair()
  const init = new NoiseInitiator({ prologue, remoteStatic: mac.publicKey })
  const resp = new NoiseResponder({ prologue: text('other'), staticKey: mac })
  assert.throws(() => resp.readMessage1(init.writeMessage1(text('x'))))
})

test('un Mac con un’altra chiave statica non completa l’handshake', () => {
  const init = new NoiseInitiator({ prologue, remoteStatic: generateKeyPair().publicKey })
  const resp = new NoiseResponder({ prologue, staticKey: generateKeyPair() })
  assert.throws(() => resp.readMessage1(init.writeMessage1(text('x'))))
})

test('messaggi dell’handshake manomessi sono rifiutati', () => {
  const mac = generateKeyPair()
  const init = new NoiseInitiator({ prologue, remoteStatic: mac.publicKey })
  const m1 = init.writeMessage1(text('x'))
  m1[m1.length - 1] ^= 1
  assert.throws(() => new NoiseResponder({ prologue, staticKey: mac }).readMessage1(m1))

  const init2 = new NoiseInitiator({ prologue, remoteStatic: mac.publicKey })
  const resp2 = new NoiseResponder({ prologue, staticKey: mac })
  resp2.readMessage1(init2.writeMessage1(text('x')))
  const { message } = resp2.writeMessage2(text('y'))
  message[40] ^= 1
  assert.throws(() => init2.readMessage2(message))
})

test('messaggio di trasporto manomesso: errore, e il canale resta rotto', () => {
  const { client, server } = handshake()
  const sealed = client.encrypt(text('ciao'))
  sealed[0] ^= 1
  assert.throws(() => server.decrypt(sealed))
  // Anche il messaggio buono successivo non passa più.
  assert.throws(() => server.decrypt(client.encrypt(text('dopo'))))
})

test('messaggio ripetuto (replay) rifiutato', () => {
  const { client, server } = handshake()
  const sealed = client.encrypt(text('paga'))
  assert.deepEqual(server.decrypt(sealed), text('paga'))
  assert.throws(() => server.decrypt(sealed))
})

test('messaggi fuori ordine rifiutati', () => {
  const { client, server } = handshake()
  const first = client.encrypt(text('uno'))
  const second = client.encrypt(text('due'))
  assert.throws(() => server.decrypt(second))
  assert.throws(() => server.decrypt(first)) // rotto per sempre dopo il primo errore
})

test('messaggio riflesso (il proprio, rimandato indietro) rifiutato', () => {
  const { client, server } = handshake()
  const sealed = client.encrypt(text('eco'))
  assert.throws(() => client.decrypt(sealed))
  const { client: c2, server: s2 } = handshake()
  const fromServer = s2.encrypt(text('eco'))
  assert.throws(() => s2.decrypt(fromServer))
  // Un messaggio valido per l'altro lato resta valido (nuovi canali, nessuno stato condiviso).
  assert.deepEqual(c2.decrypt(fromServer), text('eco'))
  assert.deepEqual(server.decrypt(sealed), text('eco'))
})

test('limite di 65535 byte per messaggio di trasporto', () => {
  const { client, server } = handshake()
  const max = client.encrypt(new Uint8Array(65535 - 16))
  assert.equal(max.length, 65535)
  assert.equal(server.decrypt(max).length, 65535 - 16)
  const { client: c2 } = handshake()
  assert.throws(() => c2.encrypt(new Uint8Array(65535 - 16 + 1)))
  const { server: s3 } = handshake()
  assert.throws(() => s3.decrypt(new Uint8Array(65536)))
})

test('un messaggio più corto del tag è rifiutato', () => {
  const { server } = handshake()
  assert.throws(() => server.decrypt(new Uint8Array(15)))
})
