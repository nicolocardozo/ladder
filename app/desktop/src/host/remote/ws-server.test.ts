// WebSocket locale: l'Origin che manda React Native (http://<host>:<porta>) passa, quello di una pagina web no.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import WebSocket from 'ws'
import { generateKeyPair } from '../../shared/remote/noise.ts'
import { openDb } from '../db.ts'
import { RemoteAccess } from './access.ts'
import { RemoteGateway } from './gateway.ts'
import { originAllowed, startLocalWsServer } from './ws-server.ts'

test('originAllowed: Host di loopback con la porta giusta; Origin assente o uguale all’Host', () => {
  const req = (host?: string) => ({ headers: { host } })
  assert.equal(originAllowed({ origin: '', req: req('127.0.0.1:7777') }, 7777), true)
  assert.equal(originAllowed({ origin: 'http://127.0.0.1:7777', req: req('127.0.0.1:7777') }, 7777), true)
  assert.equal(originAllowed({ origin: 'http://localhost:7777', req: req('localhost:7777') }, 7777), true)
  assert.equal(originAllowed({ origin: '', req: req('[::1]:7777') }, 7777), true)
  assert.equal(originAllowed({ origin: 'http://evil.example', req: req('127.0.0.1:7777') }, 7777), false)
  assert.equal(originAllowed({ origin: 'https://127.0.0.1:7777', req: req('127.0.0.1:7777') }, 7777), false)
  assert.equal(originAllowed({ origin: 'http://127.0.0.1:7777', req: req('127.0.0.1:8888') }, 7777), false)
  assert.equal(originAllowed({ origin: 'http://127.0.0.1:7777', req: req(undefined) }, 7777), false)
  // DNS rebinding: un nome che punta a 127.0.0.1 manda il proprio Host, anche senza Origin.
  assert.equal(originAllowed({ origin: '', req: req('rebind.evil.example:7777') }, 7777), false)
  assert.equal(originAllowed({ origin: 'http://rebind.evil.example:7777', req: req('rebind.evil.example:7777') }, 7777), false)
  assert.equal(originAllowed({ origin: '', req: req('127.0.0.1') }, 7777), false)
})

test('server vero: Origin di React Native accettata, pagina web rifiutata', async () => {
  const access = new RemoteAccess(openDb(':memory:'))
  const gateway = new RemoteGateway({ host: {} as never, identity: generateKeyPair(), access, macName: 'm', appVersion: '1' })
  const server = await startLocalWsServer(gateway, 0)
  const open = (origin?: string) =>
    new Promise<'open' | 'rejected'>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, origin ? { origin } : {})
      ws.on('open', () => {
        ws.close()
        resolve('open')
      })
      ws.on('error', () => resolve('rejected'))
    })
  assert.equal(await open(), 'open')
  assert.equal(await open(`http://127.0.0.1:${server.port}`), 'open')
  assert.equal(await open('http://evil.example'), 'rejected')
  assert.equal(await open('https://evil.example'), 'rejected')
  // Host falso (DNS rebinding), anche con Origin uguale.
  const rebind = (headers: Record<string, string>) =>
    new Promise<'open' | 'rejected'>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { headers })
      ws.on('open', () => {
        ws.close()
        resolve('open')
      })
      ws.on('error', () => resolve('rejected'))
    })
  assert.equal(await rebind({ Host: `rebind.evil.example:${server.port}` }), 'rejected')
  assert.equal(await rebind({ Host: `localhost:${server.port}` }), 'open')
  server.stop()
  gateway.close()
})
