import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RemoteEvent } from '../../../desktop/src/shared/protocol.ts'
import { FakeHost } from './fake-host.ts'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('approvare una richiesta la risolve e la sessione riparte', async () => {
  const host = new FakeHost({ speed: 0.05 })
  const events: RemoteEvent[] = []
  host.onEvent((e) => events.push(e))
  const s2 = host.snapshot().sessions.find((s) => s.id === 's2')!
  assert.equal(s2.run, 'waiting')
  await host.handle({ type: 'session.respond', sessionId: 's2', requestId: s2.request!.requestId, response: { optionId: 'allow' } })
  assert.equal(host.snapshot().sessions.find((s) => s.id === 's2')!.run, 'running')
  await wait(400)
  assert.equal(host.snapshot().sessions.find((s) => s.id === 's2')!.run, 'idle')
  host.dispose()
})

test('permesso oltre il massimo del progetto rifiutato', async () => {
  const host = new FakeHost()
  await assert.rejects(host.handle({ type: 'session.permission.set', sessionId: 's6', permission: 'full' }), /at most edit/)
  const ok = (await host.handle({ type: 'session.permission.set', sessionId: 's6', permission: 'plan' })) as { appliesFrom: string }
  assert.equal(ok.appliesFrom, 'now')
  host.dispose()
})

test('invio con sessione in corso accoda, stop interrompe', async () => {
  const host = new FakeHost({ speed: 0.05 })
  await host.handle({ type: 'session.send', sessionId: 's1', text: 'then deploy', busy: 'queue' })
  assert.equal(host.snapshot().sessions.find((s) => s.id === 's1')!.queue.length, 1)
  await host.handle({ type: 'session.interrupt', sessionId: 's1' })
  await wait(200)
  host.dispose()
})
