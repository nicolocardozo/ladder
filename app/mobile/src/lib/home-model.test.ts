import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Project, SessionSummary } from '../../../desktop/src/shared/protocol.ts'
import { buildHome, groupProjectSessions } from './home-model.ts'

const project = (id: string): Project => ({ id, name: id, path: `/${id}`, branch: null, isGit: true, addedAt: 0 })
const session = (id: string, projectId: string, patch: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, projectId, title: id, run: 'idle', unread: false, queue: [], archived: false, openRequests: 0, waitingSince: null, activityAt: 1, createdAt: 1, ...patch }) as unknown as SessionSummary

test('Now ordina per urgenza e nasconde le sessioni ferme', () => {
  const m = buildHome({
    projects: [project('a'), project('b')],
    sessions: [session('s1', 'a', { unread: true }), session('s2', 'a', { run: 'running' }), session('s3', 'b', { run: 'waiting', waitingSince: 5, openRequests: 1 }), session('s4', 'b')],
    projectGroups: null,
    collapsed: {}
  })
  assert.deepEqual(m.now.map((s) => s.id), ['s3', 's2', 's1'])
  assert.equal(m.waitingCount, 1)
})

test('sezioni: aperte quelle vive, progetti senza sessioni in fondo', () => {
  const m = buildHome({
    projects: [project('a'), project('b'), project('c')],
    sessions: [session('s1', 'c', { run: 'running' })],
    projectGroups: { groups: [{ id: 'g1', name: 'Work', collapsed: false, projectIds: ['a', 'c'] }, { id: 'g2', name: 'Side', collapsed: false, projectIds: ['b'] }], ungrouped: [] },
    collapsed: {}
  })
  assert.equal(m.sections.length, 2)
  assert.deepEqual(m.sections[0].projects.map((p) => p.project.id), ['c', 'a'])
  assert.equal(m.sections[0].expanded, true)
  assert.equal(m.sections[1].expanded, false)
})

test('un solo progetto e preferenza salvata', () => {
  const one = buildHome({ projects: [project('a')], sessions: [], projectGroups: null, collapsed: {} })
  assert.equal(one.singleProject?.project.id, 'a')
  const m = buildHome({
    projects: [project('a'), project('b')],
    sessions: [session('s1', 'a', { run: 'running' })],
    projectGroups: { groups: [{ id: 'g1', name: 'Work', collapsed: false, projectIds: ['a', 'b'] }], ungrouped: [] },
    collapsed: { g1: true }
  })
  assert.equal(m.sections[0].expanded, false)
})

test('gruppi di sessioni del progetto', () => {
  const g = groupProjectSessions([session('s1', 'a'), session('s2', 'a')], { groups: [{ id: 'x', name: 'X' }], groupOf: { s2: 'x' } })
  assert.deepEqual(g.map((x) => [x.name, x.sessions.map((s) => s.id)]), [[null, ['s1']], ['X', ['s2']]])
})
