// Local WebSocket: the Origin sent by React Native (http://<host>:<port>) passes, the one from a web page does not.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import WebSocket from 'ws'
import { generateKeyPair } from '../../shared/remote/noise.ts'
import { openDb } from '../db.ts'
import { RemoteAccess } from './access.ts'
import { RemoteGateway } from './gateway.ts'
import { originAllowed, startLocalWsServer } from './ws-server.ts'

test('originAllowed: loopback Host with the right port; Origin absent or equal to the Host', () => {
  const req = (host?: string) => ({ headers: { host } })
  assert.equal(originAllowed({ origin: '', req: req('127.0.0.1:7777') }, 7777), true)
  assert.equal(originAllowed({ origin: 'http://127.0.0.1:7777', req: req('127.0.0.1:7777') }, 7777), true)
  assert.equal(originAllowed({ origin: 'http://localhost:7777', req: req('localhost:7777') }, 7777), true)
  assert.equal(originAllowed({ origin: '', req: req('[::1]:7777') }, 7777), true)
  assert.equal(originAllowed({ origin: 'http://evil.example', req: req('127.0.0.1:7777') }, 7777), false)
  assert.equal(originAllowed({ origin: 'https://127.0.0.1:7777', req: req('127.0.0.1:7777') }, 7777), false)
  assert.equal(originAllowed({ origin: 'http://127.0.0.1:7777', req: req('127.0.0.1:8888') }, 7777), false)
  assert.equal(originAllowed({ origin: 'http://127.0.0.1:7777', req: req(undefined) }, 7777), false)
  // DNS rebinding: a name pointing to 127.0.0.1 sends its own Host, even without Origin.
  assert.equal(originAllowed({ origin: '', req: req('rebind.evil.example:7777') }, 7777), false)
  assert.equal(originAllowed({ origin: 'http://rebind.evil.example:7777', req: req('rebind.evil.example:7777') }, 7777), false)
  assert.equal(originAllowed({ origin: '', req: req('127.0.0.1') }, 7777), false)
})

test('real server: React Native Origin accepted, web page rejected', async () => {
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
  // Fake Host (DNS rebinding), even with a matching Origin.
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
