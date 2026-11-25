import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatItem, Project, SessionSummary } from '../../../desktop/src/shared/protocol.ts'
import { DEFAULT_FOLLOW, markDismissed, MAX_LIVE, REFRESH_MS, STALE_AFTER_MS, activityKey, currentTurn, describe, follows, livePhase, normalizeFollow, reconcile, sessionLink, type ActivityProps, type Item, type Tracks } from './live-activity.ts'

const text = { running: 'Working', waiting: 'Waiting for you', done: 'Finished', error: 'Error', stale: 'Out of date' }
const session = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, projectId: 'p', title: `T ${id}`, agent: 'claude-code', run: 'idle', unread: false, queue: [], archived: false, openRequests: 0, waitingSince: null, waitingLabel: null, activity: null, activityAt: 1, createdAt: 1, ...patch }) as unknown as SessionSummary
const project = { id: 'p', name: 'ladder', path: '/p', branch: null, isGit: true, addedAt: 0 } as Project
const tool = (seq: number, turnId: string, at: number) => ({ id: `i${seq}`, turnId, seq, at, kind: 'tool', tool: 'command', name: 'Bash', title: 'x', detail: null, status: 'done', output: null, endedAt: null }) as ChatItem
const user = (seq: number, turnId: string, at: number) => ({ id: `u${seq}`, turnId, seq, at, kind: 'user', text: 'hi' }) as ChatItem

const props = (id: string, patch: Partial<ActivityProps> = {}): ActivityProps => ({ sessionId: id, title: `T ${id}`, project: 'ladder', mark: 'claude', initial: 'C', phase: 'running', detail: '', steps: null, startedAt: 1000, took: null, link: sessionLink(id), text, ...patch })
const item = (id: string, phase: Item['phase'], patch: Partial<ActivityProps> = {}, wants = true): Item => ({ id, phase, wants, props: props(id, { phase: phase === 'idle' ? 'done' : phase, ...patch }) })
const opts = (now: number, connected = true) => ({ now, connected })

test('livePhase: working, waiting, error; the rest is idle', () => {
  assert.equal(livePhase(session('a', { run: 'running' })), 'running')
  assert.equal(livePhase(session('a', { run: 'starting' })), 'running')
  assert.equal(livePhase(session('a', { run: 'waiting' })), 'waiting')
  assert.equal(livePhase(session('a', { run: 'error' })), 'error')
  assert.equal(livePhase(session('a', { unread: true })), 'idle')
})

test('currentTurn: steps and start of the last turn', () => {
  assert.equal(currentTurn(undefined), null)
  const t = currentTurn([user(1, 't1', 100), tool(2, 't1', 110), user(3, 't2', 500), tool(4, 't2', 520), tool(5, 't2', 530)])
  assert.deepEqual(t, { steps: 2, startedAt: 500 })
})

test('describe: title, project, detail from the phase and duration only when the turn is finished', () => {
  const base = { project, items: [user(1, 't', 1_000), tool(2, 't', 2_000)], now: 61_000, text, stepsLabel: (n: number) => `${n} steps`, durationLabel: (ms: number) => `${Math.round(ms / 1000)} s`, seenSince: 9_000 }
  const r = describe({ ...base, session: session('a', { activity: 'Runs pnpm test', waitingLabel: 'Approval' }), phase: 'running' })
  assert.equal(r.title, 'T a')
  assert.equal(r.project, 'ladder')
  assert.equal(r.detail, 'Runs pnpm test')
  assert.equal(r.steps, '1 steps')
  assert.equal(r.startedAt, 1_000)
  assert.equal(r.took, null)
  assert.equal(describe({ ...base, session: session('a', { waitingLabel: 'Approval' }), phase: 'waiting' }).detail, 'Approval')
  const done = describe({ ...base, session: session('a'), phase: 'done' })
  assert.equal(done.took, '60 s')
  assert.equal(done.detail, '')
  // without a chat in memory: start from when it was seen live, and no steps
  const noItems = describe({ ...base, items: undefined, session: session('a'), phase: 'running' })
  assert.equal(noItems.startedAt, 9_000)
  assert.equal(noItems.steps, null)
})

test('props travel as JSON and carry only phone-side text', () => {
  const p = props('a', { detail: 'Runs pnpm test', steps: '3 steps' })
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p)
})

test('follows: master switch, per-session choice, automatic only for open sessions', () => {
  const p = { ...DEFAULT_FOLLOW }
  assert.equal(follows(p, 'a', true), true)
  assert.equal(follows(p, 'a', false), false)
  assert.equal(follows({ ...p, overrides: { a: 'on' } }, 'a', false), true)
  assert.equal(follows({ ...p, overrides: { a: 'off' } }, 'a', true), false)
  assert.equal(follows({ ...p, auto: false }, 'a', true), false)
  assert.equal(follows({ ...p, enabled: false, overrides: { a: 'on' } }, 'a', true), false)
})

test('normalizeFollow: corrupted values fall back to the default, per-session choices are limited', () => {
  assert.deepEqual(normalizeFollow(null), DEFAULT_FOLLOW)
  assert.deepEqual(normalizeFollow({ enabled: 'x', auto: false, overrides: { a: 'on', b: 'maybe' } }), { enabled: true, auto: false, overrides: { a: 'on' } })
  const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`s${i}`, 'on']))
  assert.equal(Object.keys(normalizeFollow({ overrides: many }).overrides).length, 60)
})

test('reconcile: starts when the followed session works, not for idle or unfollowed ones', () => {
  const a = reconcile({}, [item('a', 'running'), item('b', 'idle'), item('c', 'running', {}, false)], opts(1000))
  assert.deepEqual(a.ops.map((o) => [o.type, o.sessionId]), [['start', 'a']])
  assert.equal(a.tracks.a.live, true)
  assert.equal(a.tracks.b, undefined)
})

test('reconcile: updates only when what is visible changes, and renews the expiry if the Mac answers', () => {
  let r = reconcile({}, [item('a', 'running')], opts(0))
  r = reconcile(r.tracks, [item('a', 'running')], opts(10_000))
  assert.equal(r.ops.length, 0)
  r = reconcile(r.tracks, [item('a', 'running', { detail: 'Reads x.ts' })], opts(11_000))
  assert.deepEqual(r.ops.map((o) => o.type), ['update'])
  r = reconcile(r.tracks, [item('a', 'running', { detail: 'Reads x.ts' })], opts(11_000 + REFRESH_MS))
  assert.deepEqual(r.ops.map((o) => o.type), ['update'])
  // without the Mac it is not renewed: the Live Activity ages on its own, and must
  const off = reconcile(r.tracks, [item('a', 'running', { detail: 'Reads x.ts' })], opts(11_000 + 3 * REFRESH_MS, false))
  assert.equal(off.ops.length, 0)
  assert.ok(STALE_AFTER_MS > REFRESH_MS * 2)
})

test('reconcile: waiting changes the phase and updates', () => {
  let r = reconcile({}, [item('a', 'running')], opts(0))
  r = reconcile(r.tracks, [item('a', 'waiting', { detail: 'Approval' })], opts(1))
  assert.deepEqual(r.ops.map((o) => [o.type, (o as { props: ActivityProps }).props.phase]), [['update', 'waiting']])
})

test('reconcile: at turn end closes with "done", on error with "error", and then does not restart by itself', () => {
  let r = reconcile({}, [item('a', 'running'), item('b', 'running')], opts(0))
  r = reconcile(r.tracks, [item('a', 'idle'), item('b', 'error')], opts(5))
  const ends = r.ops.filter((o) => o.type === 'end') as Extract<(typeof r.ops)[number], { type: 'end' }>[]
  assert.deepEqual(ends.map((o) => [o.sessionId, o.props?.phase, o.immediate]), [['a', 'done', false], ['b', 'error', false]])
  assert.equal(r.tracks.a.live, false)
  // the session stays idle: no other operation
  r = reconcile(r.tracks, [item('a', 'idle'), item('b', 'error')], opts(9))
  assert.equal(r.ops.length, 0)
  // a new turn restarts it
  r = reconcile(r.tracks, [item('a', 'running'), item('b', 'error')], opts(20))
  assert.deepEqual(r.ops.map((o) => [o.type, o.sessionId]), [['start', 'a']])
})

test('reconcile: an old error seen for the first time starts nothing', () => {
  const r = reconcile({}, [item('a', 'error')], opts(0))
  assert.equal(r.ops.length, 0)
})

test('reconcile: unfollowing or archiving closes immediately', () => {
  let r = reconcile({}, [item('a', 'running'), item('b', 'running')], opts(0))
  r = reconcile(r.tracks, [item('a', 'running', {}, false)], opts(5))
  assert.deepEqual(r.ops.map((o) => [o.type, o.sessionId, (o as { immediate: boolean }).immediate]).sort(), [['end', 'a', true], ['end', 'b', true]])
  assert.deepEqual(r.tracks, {})
})

test('reconcile: no more than MAX_LIVE at once; starts when a slot frees up', () => {
  const many = ['a', 'b', 'c', 'd', 'e'].map((id) => item(id, 'running'))
  let r = reconcile({}, many, opts(0))
  assert.equal(r.ops.filter((o) => o.type === 'start').length, MAX_LIVE)
  r = reconcile(r.tracks, [item('a', 'idle'), ...many.slice(1)], opts(5))
  assert.deepEqual(r.ops.map((o) => [o.type, o.sessionId]), [['end', 'a'], ['start', 'd']])
})

test('activityKey: changes with phase and text, not with the time', () => {
  assert.equal(activityKey(props('a')), activityKey(props('a', { startedAt: 5 })))
  assert.notEqual(activityKey(props('a')), activityKey(props('a', { phase: 'waiting' })))
  assert.notEqual(activityKey(props('a')), activityKey(props('a', { steps: '2 steps' })))
})

test('traces: a trace finished over an hour ago is forgotten', () => {
  const tracks: Tracks = { a: { live: false, key: 'x', sentAt: 0, endedAt: 0 } }
  assert.deepEqual(reconcile(tracks, [item('a', 'idle')], opts(30 * 60_000)).tracks, tracks)
  assert.deepEqual(reconcile(tracks, [item('a', 'idle')], opts(61 * 60_000)).tracks, {})
})

test('reconcile: with no Mac connected nothing starts, but what exists stays', () => {
  const none = reconcile({}, [item('a', 'running')], { now: 0, connected: false, canStart: false })
  assert.equal(none.ops.length, 0)
  let r = reconcile({}, [item('a', 'running')], opts(0))
  r = reconcile(r.tracks, [item('a', 'running', { detail: 'x' })], { now: 5, connected: false, canStart: false })
  assert.deepEqual(r.ops.map((o) => o.type), ['update'])
})

test('reconcile: a Live Activity removed by the user frees the slot and does not restart in the same turn', () => {
  let r = reconcile({}, [item('a', 'running')], opts(0))
  const gone = markDismissed(r.tracks, 'a', 'running', 5)
  assert.equal(gone.a.live, false)
  // phase unchanged or changed within the same turn: no restart
  r = reconcile(gone, [item('a', 'running')], opts(10))
  assert.equal(r.ops.length, 0)
  r = reconcile(r.tracks, [item('a', 'waiting')], opts(11))
  assert.equal(r.ops.length, 0)
  // the slot is free for others
  const full = reconcile({}, ['a', 'b', 'c'].map((id) => item(id, 'running')), opts(0))
  const freed = reconcile(markDismissed(full.tracks, 'a', 'running', 1), ['a', 'b', 'c', 'd'].map((id) => item(id, 'running')), opts(2))
  assert.deepEqual(freed.ops.map((o) => [o.type, o.sessionId]), [['start', 'd']])
  // when the turn is over the choice is forgotten and the next turn starts again
  r = reconcile(r.tracks, [item('a', 'idle')], opts(20))
  assert.deepEqual(r.tracks, {})
  r = reconcile(r.tracks, [item('a', 'running')], opts(30))
  assert.deepEqual(r.ops.map((o) => o.type), ['start'])
})

test('reconcile: a failed start is not retried while the session is "blocked"', () => {
  const blocked = new Set(['a'])
  assert.equal(reconcile({}, [item('a', 'running')], { now: 0, connected: true, blocked }).ops.length, 0)
  assert.equal(reconcile({}, [item('a', 'running')], { now: 0, connected: true }).ops.length, 1)
})
