// Tests for the new-session defaults for the phone.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentStatus } from '../../shared/protocol.ts'
import { capPermission, isValidEffort, resolveRemoteDefaults } from './defaults.ts'

const claude = { agent: 'claude-code', available: true, models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'high'], isDefault: true, defaultEffort: 'high' }, { id: 'haiku', label: 'Haiku', efforts: [] }] } as Pick<AgentStatus, 'agent' | 'available' | 'models'>
const codex = { agent: 'codex', available: true, models: [{ id: 'gpt', label: 'GPT', efforts: ['medium'], defaultEffort: 'medium' }] } as Pick<AgentStatus, 'agent' | 'available' | 'models'>
const none = () => null

test('agent: project, then TOML, then global, then last used; only allowed and available ones', () => {
  const base = { agents: [claude, codex], allowed: [] as never[], maxPermission: null, agentDefaults: none }
  assert.equal(resolveRemoteDefaults({ ...base, project: { agent: 'codex' }, tomlAgent: 'claude-code' }).agent, 'codex')
  assert.equal(resolveRemoteDefaults({ ...base, tomlAgent: 'codex', global: { agent: 'claude-code' } }).agent, 'codex')
  assert.equal(resolveRemoteDefaults({ ...base, global: { agent: 'codex' }, lastAgent: 'claude-code' }).agent, 'codex')
  assert.equal(resolveRemoteDefaults({ ...base, lastAgent: 'codex' }).agent, 'codex')
  assert.equal(resolveRemoteDefaults(base).agent, 'claude-code')
  // Not allowed: falls back; lastAgent is reported as it is.
  const limited = resolveRemoteDefaults({ ...base, allowed: ['claude-code'], project: { agent: 'codex' }, lastAgent: 'codex' })
  assert.equal(limited.agent, 'claude-code')
  assert.equal(limited.lastAgent, 'codex')
  assert.deepEqual(Object.keys(limited.launch), ['claude-code'])
  assert.equal(resolveRemoteDefaults({ ...base, agents: [{ ...claude, available: false }] }).agent, null)
})

test('model and effort: only those chosen in Ladder (project, then global), otherwise null; invalid ones ignored', () => {
  const base = { agents: [claude], allowed: [] as never[], maxPermission: null, agentDefaults: none }
  assert.deepEqual(resolveRemoteDefaults(base).launch['claude-code'], { model: null, effort: null })
  assert.deepEqual(resolveRemoteDefaults({ ...base, project: { models: { 'claude-code': 'haiku' } } }).launch['claude-code'], { model: 'haiku', effort: null })
  assert.deepEqual(resolveRemoteDefaults({ ...base, global: { models: { 'claude-code': 'opus' }, efforts: { 'claude-code': 'low' } } }).launch['claude-code'], { model: 'opus', effort: 'low' })
  // Unknown model: null; effort validated against the model the agent starts with (opus: no max).
  assert.deepEqual(resolveRemoteDefaults({ ...base, global: { models: { 'claude-code': 'gone' }, efforts: { 'claude-code': 'max' } } }).launch['claude-code'], { model: null, effort: null })
  assert.deepEqual(resolveRemoteDefaults({ ...base, global: { efforts: { 'claude-code': 'low' } } }).launch['claude-code'], { model: null, effort: 'low' })
  // Valid effort for the agent's default for the project, not for isDefault.
  assert.deepEqual(resolveRemoteDefaults({ ...base, global: { efforts: { 'claude-code': 'low' } }, agentDefaults: () => ({ model: 'haiku', effort: null, known: true }) }).launch['claude-code'], { model: null, effort: null })
})

test('permission: project, then global, then edit; capped at the maximum', () => {
  const base = { agents: [claude], allowed: [] as never[], agentDefaults: none }
  assert.equal(resolveRemoteDefaults({ ...base, maxPermission: null }).permission, 'edit')
  assert.equal(resolveRemoteDefaults({ ...base, maxPermission: null, global: { permission: 'full' }, project: { permission: 'ask' } }).permission, 'ask')
  assert.equal(resolveRemoteDefaults({ ...base, maxPermission: 'ask', global: { permission: 'full' } }).permission, 'ask')
  assert.equal(capPermission('plan', 'ask'), 'plan')
})

test('isValidEffort: native agents and model levels only', () => {
  assert.equal(isValidEffort(claude, 'opus', 'high'), true)
  assert.equal(isValidEffort(claude, 'opus', 'max'), false)
  assert.equal(isValidEffort(claude, 'haiku', 'low'), false)
  assert.equal(isValidEffort({ agent: 'acp:x', models: [] }, null, 'low'), false)
})
