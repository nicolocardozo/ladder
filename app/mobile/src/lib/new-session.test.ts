import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Project, RemoteAgentStatus, RemoteProfile, RemoteProjectDefaults } from '../../../desktop/src/shared/protocol.ts'
import { createCommand, findCreated, messageError, permissionLevels, pickProject, projectSections, resolveForm, usableAgents, type FormInput } from './new-session.ts'

const project = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, path: `/p/${id}`, branch: 'main', isGit: true, addedAt: 1, ...extra })
const claude: RemoteAgentStatus = {
  agent: 'claude-code',
  name: 'Claude Code',
  kind: 'native',
  available: true,
  version: '1',
  account: 'Claude Max',
  error: null,
  models: [
    { id: 'opus', label: 'Opus 4.7', efforts: ['low', 'high', 'xhigh'], isDefault: true, defaultEffort: 'high' },
    { id: 'sonnet', label: 'Sonnet 4.6', efforts: ['low', 'high'] }
  ]
}
const codex: RemoteAgentStatus = { agent: 'codex', name: 'Codex', kind: 'native', available: true, version: '1', account: 'ChatGPT Pro', error: null, models: [{ id: 'gpt', label: 'GPT-5.5', efforts: ['low', 'medium'], isDefault: true }] }
const gemini: RemoteAgentStatus = { agent: 'acp:gemini-cli', name: 'Gemini', kind: 'acp', available: true, version: '1', account: null, error: null, models: [{ id: 'g3', label: 'Gemini 3', isDefault: true }] }
const work: RemoteAgentStatus = { ...claude, profileId: 'p-work', account: 'Claude Team', models: [{ id: 'opus', label: 'Opus 4.7', efforts: ['low', 'high'], isDefault: true }] }
const profiles: RemoteProfile[] = [
  { id: 'default:claude-code', agent: 'claude-code', name: 'Personal', isDefault: true },
  { id: 'p-work', agent: 'claude-code', name: 'Work', isDefault: false }
]
const def = (patch: Partial<RemoteProjectDefaults> = {}): RemoteProjectDefaults => ({
  allowed: [],
  agent: 'claude-code',
  lastAgent: 'codex',
  launch: { 'claude-code': { model: 'sonnet', effort: 'low' }, codex: { model: null, effort: null }, 'acp:gemini-cli': { model: null, effort: null } },
  permission: 'edit',
  ...patch
})
const input = (patch: Partial<FormInput> = {}): FormInput => ({
  projects: [project('a'), project('b'), project('c')],
  projectGroups: { groups: [{ id: 'g', name: 'Work', collapsed: false, projectIds: ['b', 'c'] }], ungrouped: ['a'] },
  defaults: { a: def(), b: def({ agent: 'codex' }), c: def({ allowed: ['codex'], agent: 'codex' }) },
  agents: [claude, work, codex, gemini],
  profiles,
  permissionsMax: { a: null, b: 'ask', c: null },
  allowFull: true,
  ...patch
})

test('progetto: dove si è, poi l’ultimo usato, poi il primo del Mac', () => {
  assert.equal(pickProject({ ...input(), contextProjectId: 'c', lastProjectId: 'b' }), 'c')
  assert.equal(pickProject({ ...input(), contextProjectId: 'gone', lastProjectId: 'b' }), 'b')
  assert.equal(pickProject({ ...input(), contextProjectId: null, lastProjectId: null }), 'a')
  assert.equal(pickProject({ ...input(), projects: [], projectGroups: undefined }), null)
})

test('le sezioni del Mac: senza titolo i progetti fuori da ogni sezione', () => {
  const s = projectSections(input().projects, input().projectGroups)
  assert.deepEqual(s.map((x) => [x.name, x.projects.map((p) => p.id)]), [[null, ['a']], ['Work', ['b', 'c']]])
})

test('agenti ammessi: allowed vuoto = tutti i disponibili, senza doppioni', () => {
  assert.deepEqual(usableAgents(input().agents, def()), ['claude-code', 'codex', 'acp:gemini-cli'])
  assert.deepEqual(usableAgents(input().agents, def({ allowed: ['codex'] })), ['codex'])
  assert.deepEqual(usableAgents([{ ...codex, available: false }], def()), [])
})

test('agente: quello del Mac, poi l’ultimo usato, poi il primo ammesso', () => {
  assert.equal(resolveForm(input(), { projectId: 'a' }).agent, 'claude-code')
  assert.equal(resolveForm(input(), { projectId: 'b' }).agent, 'codex')
  // `agent` non ammesso: ripiega sull'ultimo usato se ammesso
  const i = input({ defaults: { a: def({ agent: null, allowed: ['codex'], lastAgent: 'codex' }) } })
  assert.equal(resolveForm(i, { projectId: 'a' }).agent, 'codex')
  assert.equal(resolveForm(i, { projectId: 'a', agent: 'claude-code' }).agent, 'codex')
  assert.equal(resolveForm(input({ agents: [] })).agent, null)
})

test('modello ed effort partono da `launch`, com’è; null mostra il predefinito dell’agente', () => {
  const v = resolveForm(input(), { projectId: 'a' })
  assert.equal(v.model, 'sonnet')
  assert.equal(v.effort, 'low')
  assert.equal(v.effectiveModelLabel, 'Sonnet 4.6')
  const c = resolveForm(input(), { projectId: 'a', agent: 'codex' })
  assert.equal(c.model, null)
  assert.equal(c.effectiveModelLabel, 'GPT-5.5')
  assert.deepEqual(c.effortOptions, ['low', 'medium'])
  assert.equal(c.effort, null)
  const d = resolveForm(input({ defaults: { a: def({ launch: { 'claude-code': { model: null, effort: null } } }) } }), { projectId: 'a' })
  assert.equal(d.effectiveModelLabel, 'Opus 4.7')
  assert.equal(d.defaultEffort, 'high')
})

test('l’utente può tornare al predefinito (null) e uno non valido cade a null', () => {
  assert.equal(resolveForm(input(), { projectId: 'a', model: null }).model, null)
  assert.equal(resolveForm(input(), { projectId: 'a', model: 'nope' }).model, null)
  // effort non accettato dal modello scelto: torna al predefinito
  assert.equal(resolveForm(input(), { projectId: 'a', model: 'sonnet', effort: 'xhigh' }).effort, null)
  assert.equal(resolveForm(input(), { projectId: 'a', model: 'opus', effort: 'xhigh' }).effort, 'xhigh')
})

test('agente senza effort (ACP): nessuna scelta di effort', () => {
  const v = resolveForm(input(), { projectId: 'a', agent: 'acp:gemini-cli' })
  assert.deepEqual(v.effortOptions, [])
  assert.equal(v.effort, null)
  assert.equal(v.profileOptions.length, 0)
  assert.equal(v.profile, null)
})

test('account: quello del progetto, poi il predefinito; si manda sempre l’id scelto', () => {
  // anche il predefinito: senza, il Mac userebbe l'account assegnato al progetto
  assert.equal(resolveForm(input(), { projectId: 'a' }).profileId, 'default:claude-code')
  assert.equal(resolveForm(input(), { projectId: 'a', agent: 'acp:gemini-cli' }).profileId, undefined)
  assert.equal(resolveForm(input(), { projectId: 'a' }).profile?.name, 'Personal')
  const assigned = input({ projects: [project('a', { profiles: { 'claude-code': 'p-work' } })] })
  const v = resolveForm(assigned, { projectId: 'a' })
  assert.equal(v.profileId, 'p-work')
  // con l'account di lavoro un modello che quell'account non ha cade al predefinito
  assert.equal(v.model, null)
  assert.equal(v.status?.account, 'Claude Team')
  // scelta esplicita dell'account predefinito (null)
  assert.equal(resolveForm(assigned, { projectId: 'a', profileId: null }).profileId, 'default:claude-code')
})

test('permesso: parte da quello del Mac; sopra il tetto o Full spento = livello spento', () => {
  assert.equal(resolveForm(input(), { projectId: 'a' }).permission, 'edit')
  const b = resolveForm(input(), { projectId: 'b' })
  assert.deepEqual(b.levels.map((l) => [l.level, l.allowed, l.reason]), [['plan', true, null], ['ask', true, null], ['edit', false, 'max'], ['full', false, 'max']])
  assert.equal(b.permission, 'ask')
  assert.equal(resolveForm(input(), { projectId: 'b', permission: 'full' }).permission, 'ask')
  const off = permissionLevels(null, false)
  assert.deepEqual(off.map((l) => l.reason), [null, null, null, 'full-off'])
  assert.equal(resolveForm(input({ allowFull: false }), { projectId: 'a', permission: 'full' }).permission, 'edit')
  assert.equal(resolveForm(input(), { projectId: 'a', permission: 'plan' }).permission, 'plan')
})

test('messaggio: obbligatorio dopo trim, con un limite', () => {
  assert.equal(messageError('  \n '), 'empty')
  assert.equal(messageError('ciao'), null)
  assert.equal(messageError('x'.repeat(200_001)), 'long')
})

test('comando di creazione: solo le chiavi ammesse, profileId per gli agenti con account', () => {
  const v = resolveForm(input(), { projectId: 'a' })
  assert.deepEqual(createCommand(v, '  fix it \n'), { type: 'session.create', projectId: 'a', agent: 'claude-code', text: 'fix it', model: 'sonnet', effort: 'low', permission: 'edit', profileId: 'default:claude-code', mode: 'chat' })
  const acp = createCommand(resolveForm(input(), { projectId: 'a', agent: 'acp:gemini-cli' }), 'x')!
  assert.equal('profileId' in acp, false)
  const w = resolveForm(input(), { projectId: 'a', profileId: 'p-work' })
  assert.equal((createCommand(w, 'x') as { profileId?: string }).profileId, 'p-work')
  assert.equal(createCommand(resolveForm(input({ agents: [] })), 'x'), null)
})

const made = (patch: Partial<import('../../../desktop/src/shared/protocol.ts').SessionSummary>) =>
  ({ id: 's-new', projectId: 'a', agent: 'claude-code', profileId: undefined, title: 'Fix the flaky test', mode: 'chat', archived: false, createdAt: 1_000_000, ...patch }) as import('../../../desktop/src/shared/protocol.ts').SessionSummary
const cmd = { projectId: 'a', agent: 'claude-code' as const, text: 'Fix the flaky test and more', profileId: 'default:claude-code' }

test('dopo un timeout: la sessione nata nel frattempo si riconosce, così non si rimanda', () => {
  const known = new Set(['old'])
  assert.equal(findCreated([made({ id: 'old' })], known, cmd, 1_000_000), null)
  assert.equal(findCreated([made({})], known, cmd, 1_000_000)?.id, 's-new')
  // altro progetto, altro agente, vecchia o archiviata: no
  assert.equal(findCreated([made({ projectId: 'b' })], known, cmd, 1_000_000), null)
  assert.equal(findCreated([made({ agent: 'codex' })], known, cmd, 1_000_000), null)
  assert.equal(findCreated([made({ createdAt: 100 })], known, cmd, 1_000_000), null)
  assert.equal(findCreated([made({ archived: true })], known, cmd, 1_000_000), null)
  // con due candidate vince il titolo uguale al primo messaggio; senza titolo uguale non si indovina
  const two = [made({ id: 'x', title: 'Other' }), made({ id: 'y' })]
  assert.equal(findCreated(two, known, cmd, 1_000_000)?.id, 'y')
  assert.equal(findCreated([made({ id: 'x', title: 'Other' }), made({ id: 'z', title: 'Another' })], known, cmd, 1_000_000), null)
})
