import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Project, SessionSummary } from '../../../desktop/src/shared/protocol.ts'
import { WIDGET_STALE_AFTER_MS, WIDGET_TOP, buildSnapshot, isStale, snapshotKey, widgetProps, widgetTimeline, type WidgetText } from './widget-snapshot.ts'

const text: WidgetText = { working: 'Working', waiting: 'Waiting', quiet: 'All quiet', updated: 'Updated', open: 'Open Ladder', offline: 'Offline' }
const session = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, projectId: 'p', title: `T ${id}`, agent: 'claude-code', run: 'idle', unread: false, queue: [], archived: false, openRequests: 0, waitingSince: null, activityAt: 1, ...patch }) as unknown as SessionSummary
const projects = [{ id: 'p', name: 'ladder' }] as Project[]

test('buildSnapshot: counts working and waiting, waiting titles from the oldest', () => {
  const s = buildSnapshot(
    [session('a', { run: 'running' }), session('b', { run: 'running' }), session('c', { run: 'waiting', waitingSince: 50 }), session('d', { run: 'waiting', waitingSince: 10 }), session('e')],
    projects,
    1000,
    true,
    { showTitles: true }
  )
  assert.equal(s.working, 2)
  assert.equal(s.waiting, 2)
  assert.deepEqual(s.top.map((t) => t.id), ['d', 'c'])
  assert.equal(s.top[0].project, 'ladder')
  assert.equal(s.updatedAt, 1000)
})

test('buildSnapshot: at most WIDGET_TOP titles, but the count is full', () => {
  const many = Array.from({ length: 6 }, (_, i) => session(`w${i}`, { run: 'waiting', waitingSince: i }))
  const s = buildSnapshot(many, projects, 1, true, { showTitles: true })
  assert.equal(s.waiting, 6)
  assert.equal(s.top.length, WIDGET_TOP)
})

test('snapshotKey ignores the time and sees changes', () => {
  const a = buildSnapshot([session('a', { run: 'running' })], projects, 1, true)
  const b = buildSnapshot([session('a', { run: 'running' })], projects, 99, true)
  assert.equal(snapshotKey(a), snapshotKey(b))
  assert.notEqual(snapshotKey(a), snapshotKey({ ...a, connected: false }))
})

test('isStale triggers after ten minutes', () => {
  const s = buildSnapshot([], projects, 0, true)
  assert.equal(isStale(s, WIDGET_STALE_AFTER_MS - 1), false)
  assert.equal(isStale(s, WIDGET_STALE_AFTER_MS), true)
})

const ago = (m: number) => `Updated ${m} min ago`

test('widgetTimeline: now and, from ten minutes on, the same thing marked not updated with the age written', () => {
  const s = buildSnapshot([session('a', { run: 'running' })], projects, 1000, true)
  const t = widgetTimeline(s, text, 1000, ago)
  assert.equal(t[0].props.stale, false)
  assert.equal(t[0].props.agoLabel, null)
  assert.equal(t[1].props.stale, true)
  assert.equal(t[1].date.getTime(), 1000 + WIDGET_STALE_AFTER_MS)
  assert.equal(t[1].props.agoLabel, 'Updated 10 min ago')
  assert.equal(t[2].props.agoLabel, 'Updated 15 min ago')
  // republished when already old: the first entry is already marked, with the real age
  const late = widgetTimeline(s, text, 1000 + 12 * 60_000, ago)
  assert.equal(late[0].props.stale, true)
  assert.equal(late[0].props.agoLabel, 'Updated 12 min ago')
  assert.equal(late[1].props.agoLabel, 'Updated 15 min ago')
})

test('without titles (default) the snapshot contains no titles or projects', () => {
  const sessions = [session('a', { run: 'waiting', waitingSince: 1, title: 'Secret plan' })]
  const off = buildSnapshot(sessions, projects, 1, true)
  assert.equal(off.waiting, 1)
  assert.deepEqual(off.top, [])
  assert.ok(!JSON.stringify(widgetTimeline(off, text, 1, ago)).includes('Secret plan'))
  assert.ok(!JSON.stringify(off).includes('ladder'))
  assert.equal(buildSnapshot(sessions, projects, 1, true, { showTitles: true }).top[0].title, 'Secret plan')
})

test('updatedAt stays that of the last write with the Mac, and archived ones do not count', () => {
  const s = buildSnapshot([session('a', { run: 'running' }), session('b', { run: 'running', archived: true })], projects, 9000, false, { updatedAt: 500 })
  assert.equal(s.updatedAt, 500)
  assert.equal(s.working, 1)
})

test('widgetProps: the tap opens Waiting if something is waiting, otherwise the app', () => {
  assert.equal(widgetProps(buildSnapshot([session('a', { run: 'waiting' })], projects, 1, true), text, false).link, 'ladder://waiting')
  assert.equal(widgetProps(buildSnapshot([], projects, 1, true), text, false).link, 'ladder://')
})

test('the snapshot travels as JSON', () => {
  const t = widgetTimeline(buildSnapshot([session('a', { run: 'waiting', waitingSince: 1 })], projects, 5, true, { showTitles: true }), text, 5, ago)
  const p = t[0].props
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p)
})
