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

test('nuova sessione dal telefono: upsert prima del risultato, poi la chat risponde', async () => {
  const host = new FakeHost({ speed: 0.05 })
  const events: RemoteEvent[] = []
  host.onEvent((e) => events.push(e))
  const created = (await host.handle({ type: 'session.create', projectId: 'p-web', agent: 'claude-code', text: 'Fix the flaky test', model: null, effort: null, permission: 'ask', mode: 'chat' })) as { id: string; permission: string; title: string }
  assert.equal(created.title, 'Fix the flaky test')
  assert.equal(events.some((e) => e.type === 'session.upsert' && e.session.id === created.id), true)
  assert.ok(host.snapshot().sessions.some((s) => s.id === created.id))
  await wait(300)
  const page = host.pageItems(created.id)
  assert.equal(page.items.some((i) => i.kind === 'user'), true)
  host.dispose()
})

test('nuova sessione: errori come l’host, permesso ridotto al tetto del progetto', async () => {
  const host = new FakeHost({ speed: 0.05 })
  const base = { type: 'session.create' as const, agent: 'claude-code' as const, model: null, effort: null, mode: 'chat' as const }
  await assert.rejects(host.handle({ ...base, projectId: 'nope', text: 'x', permission: 'ask' }), /Project not found/)
  await assert.rejects(host.handle({ ...base, projectId: 'p-web', text: '  ', permission: 'ask' }), /empty/)
  await assert.rejects(host.handle({ ...base, projectId: 'p-api', agent: 'acp:gemini-cli', text: 'x', permission: 'ask' }), /not allowed/)
  const capped = (await host.handle({ ...base, projectId: 'p-ds', text: 'x', permission: 'full' })) as { permission: string }
  assert.equal(capped.permission, 'ask')
  host.dispose()
})

test('limiti d’uso: la lettura rimette l’ora ed emette agent.status; ACP non li ha', async () => {
  const host = new FakeHost()
  const events: RemoteEvent[] = []
  host.onEvent((e) => events.push(e))
  const before = host.snapshot().agents.find((a) => a.agent === 'claude-code' && !a.profileId)!.usageAt!
  const read = (await host.handle({ type: 'agents.usage', agent: 'claude-code' })) as { usageAt: number; usage: unknown[] }
  assert.ok(read.usageAt > before)
  assert.equal(read.usage.length, 2)
  assert.equal(events.some((e) => e.type === 'agent.status'), true)
  assert.equal(await host.handle({ type: 'agents.usage', agent: 'acp:gemini-cli' }), null)
  const snap = host.snapshot()
  assert.ok(snap.profiles.length >= 3)
  assert.ok(snap.defaults['p-web'])
  host.dispose()
})

test('allegati: l’invio e la nuova sessione portano i nomi nella chat (LAD-92)', async () => {
  const host = new FakeHost({ speed: 0.05 })
  const events: RemoteEvent[] = []
  host.onEvent((e) => events.push(e))
  const idle = host.snapshot().sessions.find((s) => s.run === 'idle' && !s.archived)!.id
  await host.handle({ type: 'session.send', sessionId: idle, text: '', attachments: [{ name: 'shot-1.jpg', mediaType: 'image/jpeg', data: 'AAAA' }] })
  const user = events.flatMap((e) => (e.type === 'session.items' ? e.items : [])).find((i) => i.kind === 'user' && i.attachments?.length)
  assert.ok(user && user.kind === 'user')
  assert.deepEqual(user.attachments, [{ name: 'shot-1.jpg', mediaType: 'image/jpeg' }])
  await assert.rejects(host.handle({ type: 'session.send', sessionId: idle, text: '  ' }), /empty/)
  host.dispose()
})

test('comandi e ricerca dei file nella demo (LAD-92)', async () => {
  const host = new FakeHost()
  const commands = (await host.handle({ type: 'session.commands', sessionId: 's1' })) as { name: string }[]
  assert.ok(commands.some((c) => c.name === 'review'))
  const files = (await host.handle({ type: 'project.files.search', projectId: 'p-web', query: 'FILTERS', limit: 3 })) as string[]
  assert.ok(files.length > 0 && files.length <= 3)
  assert.ok(files.every((f) => f.toLowerCase().includes('filters')))
  assert.equal(((await host.handle({ type: 'project.files.search', projectId: 'p-web', query: '' })) as string[]).length, 19)
  await assert.rejects(host.handle({ type: 'project.files.search', projectId: 'nope', query: 'a' }), /not found/)
  host.dispose()
})
