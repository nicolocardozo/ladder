// Prove dei predefiniti della nuova sessione per il telefono (LAD-89).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentStatus } from '../../shared/protocol.ts'
import { capPermission, isValidEffort, resolveRemoteDefaults } from './defaults.ts'

const claude = { agent: 'claude-code', available: true, models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'high'], isDefault: true, defaultEffort: 'high' }, { id: 'haiku', label: 'Haiku', efforts: [] }] } as Pick<AgentStatus, 'agent' | 'available' | 'models'>
const codex = { agent: 'codex', available: true, models: [{ id: 'gpt', label: 'GPT', efforts: ['medium'], defaultEffort: 'medium' }] } as Pick<AgentStatus, 'agent' | 'available' | 'models'>
const none = () => null

test('agente: progetto, poi TOML, poi globale, poi ultimo; ammessi e disponibili soltanto', () => {
  const base = { agents: [claude, codex], allowed: [] as never[], maxPermission: null, agentDefaults: none }
  assert.equal(resolveRemoteDefaults({ ...base, project: { agent: 'codex' }, tomlAgent: 'claude-code' }).agent, 'codex')
  assert.equal(resolveRemoteDefaults({ ...base, tomlAgent: 'codex', global: { agent: 'claude-code' } }).agent, 'codex')
  assert.equal(resolveRemoteDefaults({ ...base, global: { agent: 'codex' }, lastAgent: 'claude-code' }).agent, 'codex')
  assert.equal(resolveRemoteDefaults({ ...base, lastAgent: 'codex' }).agent, 'codex')
  assert.equal(resolveRemoteDefaults(base).agent, 'claude-code')
  // Non ammesso: si ripiega; lastAgent resta riportato com'è.
  const limited = resolveRemoteDefaults({ ...base, allowed: ['claude-code'], project: { agent: 'codex' }, lastAgent: 'codex' })
  assert.equal(limited.agent, 'claude-code')
  assert.equal(limited.lastAgent, 'codex')
  assert.deepEqual(Object.keys(limited.launch), ['claude-code'])
  assert.equal(resolveRemoteDefaults({ ...base, agents: [{ ...claude, available: false }] }).agent, null)
})

test('modello ed effort: solo quelli scelti da Ladder (progetto, poi globale), altrimenti null; non validi ignorati', () => {
  const base = { agents: [claude], allowed: [] as never[], maxPermission: null, agentDefaults: none }
  assert.deepEqual(resolveRemoteDefaults(base).launch['claude-code'], { model: null, effort: null })
  assert.deepEqual(resolveRemoteDefaults({ ...base, project: { models: { 'claude-code': 'haiku' } } }).launch['claude-code'], { model: 'haiku', effort: null })
  assert.deepEqual(resolveRemoteDefaults({ ...base, global: { models: { 'claude-code': 'opus' }, efforts: { 'claude-code': 'low' } } }).launch['claude-code'], { model: 'opus', effort: 'low' })
  // Modello sconosciuto: null; effort validato contro il modello con cui parte l'agente (opus: max non c'è).
  assert.deepEqual(resolveRemoteDefaults({ ...base, global: { models: { 'claude-code': 'gone' }, efforts: { 'claude-code': 'max' } } }).launch['claude-code'], { model: null, effort: null })
  assert.deepEqual(resolveRemoteDefaults({ ...base, global: { efforts: { 'claude-code': 'low' } } }).launch['claude-code'], { model: null, effort: 'low' })
  // Effort valido per il predefinito dell'agente per il progetto, non per l'isDefault.
  assert.deepEqual(resolveRemoteDefaults({ ...base, global: { efforts: { 'claude-code': 'low' } }, agentDefaults: () => ({ model: 'haiku', effort: null, known: true }) }).launch['claude-code'], { model: null, effort: null })
})

test('permesso: progetto, poi globale, poi edit; ridotto al tetto', () => {
  const base = { agents: [claude], allowed: [] as never[], agentDefaults: none }
  assert.equal(resolveRemoteDefaults({ ...base, maxPermission: null }).permission, 'edit')
  assert.equal(resolveRemoteDefaults({ ...base, maxPermission: null, global: { permission: 'full' }, project: { permission: 'ask' } }).permission, 'ask')
  assert.equal(resolveRemoteDefaults({ ...base, maxPermission: 'ask', global: { permission: 'full' } }).permission, 'ask')
  assert.equal(capPermission('plan', 'ask'), 'plan')
})

test('isValidEffort: solo agenti nativi e livelli del modello', () => {
  assert.equal(isValidEffort(claude, 'opus', 'high'), true)
  assert.equal(isValidEffort(claude, 'opus', 'max'), false)
  assert.equal(isValidEffort(claude, 'haiku', 'low'), false)
  assert.equal(isValidEffort({ agent: 'acp:x', models: [] }, null, 'low'), false)
})
