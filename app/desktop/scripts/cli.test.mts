// Tests for the CLI feature: socket allow-list, CLI arguments and outcomes, session.wait, MCP tool rules and a real round trip
// (real socket + CLI spawned as a process) against a fake host. Run with: node --no-warnings scripts/cli.test.mts
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentSessions, type AgentSessionsDeps, type ListedSession, type SessionInfo, type StartSpec } from '../src/host/agent-sessions.ts'
import { CLI_ALLOWED, CliSocket, checkCliCommand } from '../src/host/cli-socket.ts'
import { CliInstall } from '../src/host/cli-install.ts'
import { LadderMcpServer, parseReport, toolsForRole, type LadderBackend, type LadderToolName } from '../src/host/ladder-mcp.ts'
import { decideWait } from '../src/host/session-wait.ts'
import { exitCodeFor, parseArgs } from '../src/cli/args.ts'
import { connectSocket } from '../src/cli/client.ts'
import { Follower, findProject, findSession, run, type Io } from '../src/cli/index.ts'
import { discoverSocket, socketPathFor } from '../src/cli/socket-path.ts'
import type { ChatItem, HostCommand, HostEvent, PermissionLevel, SessionWaitResult } from '../src/shared/protocol.ts'

/** Backend whose tools are not under test: the ones a test needs are overridden. */
const unusedBackend: LadderBackend = {
  tools: () => null,
  listAgents: async () => ({ text: 'unused', isError: true }),
  handoff: async () => ({ text: 'unused', isError: true }),
  delegate: async () => ({ text: 'unused', isError: true }),
  report: async () => ({ text: 'unused', isError: true }),
  plan: async () => ({ text: 'unused', isError: true }),
  sessions: async () => ({ text: 'unused', isError: true })
}
const COORDINATOR_TOOLS: LadderToolName[] = ['propose_plan', 'revise_plan', 'ladder_list_sessions', 'ladder_start_session', 'ladder_send', 'ladder_wait']

let passed = 0
const step = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`  FAIL ${name}`)
    throw error
  }
}
const tmp = mkdtempSync(join(tmpdir(), 'ladder-cli-test-'))
let n = 0
const sockPath = () => join(tmp, `s${++n}`, 'run', 'ladder.sock')

// ── Arguments ───────────────────────────────────────────────────────────────

console.log('CLI · arguments and exit codes')

await step('commands, options and arguments', () => {
  const ok = parseArgs(['new', 'my-app', 'fix the bug', '--agent', 'codex', '--permission=plan', '--worktree', '--wait', '--json'])
  assert.ok(ok.ok)
  assert.deepEqual(ok.ok && ok.value.args, ['my-app', 'fix the bug'])
  assert.deepEqual(ok.ok && ok.value.flags, { '--agent': 'codex', '--permission': 'plan', '--worktree': true, '--wait': true, '--json': true })
  const dash = parseArgs(['send', 'abc', '-'])
  assert.deepEqual(dash.ok && dash.value.args, ['abc', '-'])
  assert.equal(parseArgs(['new', 'p']).ok, false, 'the prompt is missing')
  assert.match(parseArgs(['ls', '--nope']).ok ? '' : (parseArgs(['ls', '--nope']) as { error: string }).error, /Unknown option/)
  assert.match((parseArgs(['new', 'p', 't', '--agent']) as { error: string }).error, /needs a value/)
  assert.match((parseArgs(['frobnicate']) as { error: string }).error, /Unknown command/)
  assert.equal((parseArgs([]) as { help: boolean }).help, true)
  assert.equal((parseArgs(['wait', 'x', '--help']) as { error: string }).error, 'help:wait')
})

await step('wait exit codes', () => {
  assert.deepEqual(['completed', 'error', 'interrupted', 'needs-user', 'timeout', 'idle'].map(exitCodeFor), [0, 1, 2, 3, 4, 0])
})

await step('socket path: one per build, overridable, under the macOS limit', () => {
  assert.equal(discoverSocket({ LADDER_SOCKET: '/x/y.sock' }, '/h'), '/x/y.sock')
  assert.equal(discoverSocket({}, '/Users/me'), '/Users/me/Library/Application Support/Ladder/run/ladder.sock')
  assert.equal(discoverSocket({ LADDER_USER_DATA: '/data/dev' }, '/Users/me'), '/data/dev/run/ladder.sock')
  const long = socketPathFor('/Users/' + 'x'.repeat(120) + '/Application Support/Ladder', 501)
  assert.ok(Buffer.byteLength(long) < 104)
  assert.equal(long, socketPathFor('/Users/' + 'x'.repeat(120) + '/Application Support/Ladder', 501), 'same result for the same folder')
})

await step('project by name, folder or "."; session by prefix', () => {
  const projects = [
    { id: 'p1', name: 'App', path: '/dev/app' },
    { id: 'p2', name: 'Lib', path: '/dev/app/packages/lib' }
  ] as never[]
  assert.equal(findProject(projects, 'app', '/').id, 'p1')
  assert.equal(findProject(projects, '/dev/app', '/').id, 'p1')
  assert.equal(findProject(projects, '.', '/dev/app/src').id, 'p1')
  assert.equal(findProject(projects, '.', '/dev/app/packages/lib/src').id, 'p2', 'the innermost project wins')
  assert.throws(() => findProject(projects, 'nope', '/elsewhere'), /No Ladder project matches/)
  const sessions = [{ id: 'abc123' }, { id: 'abd999' }] as never[]
  assert.equal(findSession(sessions, 'abc').id, 'abc123')
  assert.throws(() => findSession(sessions, 'ab'), /matches 2 sessions/)
  assert.throws(() => findSession(sessions, 'zz'), /No session matches/)
})

// ── Allow-list and socket ─────────────────────────────────────────────────────

console.log('Socket · allow-list and security')

await step('only allow-listed commands pass, and the CLI does not open terminals', () => {
  for (const type of CLI_ALLOWED) assert.equal(typeof type, 'string')
  assert.equal(checkCliCommand({ type: 'hello' }), null)
  assert.equal(checkCliCommand({ type: 'session.wait', sessionId: 'x' }), null)
  assert.equal(checkCliCommand({ type: 'session.transcript', sessionId: 'x' }), null)
  for (const type of ['session.open', 'session.archive', 'project.remove', 'terminal.open', 'plan.approve', 'file.write', 'cli.install', 'connections.logout']) assert.match(checkCliCommand({ type }) ?? '', /not available/, type)
  assert.match(checkCliCommand({ type: 'session.create', mode: 'terminal', command: 'rm -rf ~', text: 'x' }) ?? '', /only start chat/)
  assert.match(checkCliCommand({ type: 'session.create', text: '  ' }) ?? '', /empty/)
  assert.match(checkCliCommand({ type: 'session.send', sessionId: 'x', text: 'hi', attachments: [{}] }) ?? '', /empty/)
  assert.equal(checkCliCommand(null), 'Invalid command.')
})

const seen: HostCommand[] = []
const handler = async (command: HostCommand): Promise<unknown> => {
  seen.push(command)
  return { ok: command.type }
}

await step('socket: folder 0700, socket 0600, allowed and rejected commands, events only to subscribers', async () => {
  const path = sockPath()
  const server = new CliSocket(path, { handle: handler })
  await server.start()
  assert.equal(server.socket, path)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(statSync(join(path, '..')).mode & 0o777, 0o700)
  const conn = await connectSocket(path)
  assert.deepEqual(await conn.request({ type: 'hello' } as HostCommand), { ok: 'hello' })
  await assert.rejects(conn.request({ type: 'session.archive', sessionId: 'x' } as HostCommand), /not available from the command line/)
  assert.ok(!seen.some((c) => c.type === 'session.archive'), 'the rejected command does not reach the host')
  const events: HostEvent[] = []
  await conn.subscribe('s1', (e) => events.push(e))
  server.publish({ type: 'session.items', sessionId: 's2', items: [], replace: false })
  server.publish({ type: 'session.items', sessionId: 's1', items: [], replace: true })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(events.length, 1)
  conn.close()
  server.close()
})

await step('stale socket cleaned up at start; a live one is not taken over', async () => {
  const path = sockPath()
  mkdirSync(join(path, '..'), { recursive: true })
  // Leftover of an abrupt shutdown: a socket with nobody listening.
  const dead = createServer()
  await new Promise<void>((resolve) => dead.listen(path, resolve))
  // Closing the server removes the file: closing the raw handle instead leaves the orphan socket file in place.
  ;(dead as unknown as { _handle: { close(): void } })._handle.close()
  writeFileSync(join(tmp, 'marker'), '')
  const first = new CliSocket(path, { handle: handler })
  await first.start()
  const second = new CliSocket(path, { handle: handler })
  await assert.rejects(second.start(), /already listening/)
  first.close()
})

// ── session.wait ────────────────────────────────────────────────────────────

console.log('session.wait · outcomes')

const item = (kind: string, extra: object): ChatItem => ({ kind, id: Math.random().toString(36), seq: 1, at: 0, turnId: 't1', ...extra }) as ChatItem
const base = { sessionId: 's', runState: 'idle', waitingLabel: null, planLabel: null, busy: false, background: false, continueLabel: null, queued: 0, seq: 9 }
const turn = (status: string, error: string | null = null) => [item('user', { text: 'q' }), item('assistant', { text: 'first', streaming: false }), item('assistant', { text: 'final answer\n', streaming: false, turnId: 't1' }), item('turn-end', { status, error, durationMs: 1 })]

await step('completed, error, interrupted: text of the last turn', () => {
  assert.deepEqual(decideWait({ ...base, items: turn('completed') }), { sessionId: 's', status: 'completed', text: 'final answer', error: null, waitingLabel: null, seq: 9 })
  const failed = decideWait({ ...base, runState: 'error', items: turn('error', 'Usage limit reached') })!
  assert.equal(failed.status, 'error')
  assert.equal(failed.error, 'Usage limit reached')
  assert.equal(decideWait({ ...base, items: turn('interrupted') })!.status, 'interrupted')
})

await step('still working (or queued): keep waiting; needs your answer: needs-user; no turn: idle', () => {
  assert.equal(decideWait({ ...base, busy: true, items: turn('completed') }), null)
  assert.equal(decideWait({ ...base, queued: 1, items: turn('completed') }), null)
  const waiting = decideWait({ ...base, runState: 'waiting', waitingLabel: 'Approval', busy: true, items: [] })!
  assert.deepEqual([waiting.status, waiting.waitingLabel], ['needs-user', 'Approval'])
  assert.equal(decideWait({ ...base, planLabel: 'Plan review', items: turn('completed') })!.status, 'needs-user')
  assert.equal(decideWait({ ...base, items: [] })!.status, 'idle')
})

await step('background sub-agents still working: not the final answer; "Continue" offered: needs the user', () => {
  assert.equal(decideWait({ ...base, background: true, items: turn('completed') }), null)
  const cont = decideWait({ ...base, continueLabel: 'Continue', items: turn('completed') })!
  assert.deepEqual([cont.status, cont.waitingLabel], ['needs-user', 'Continue'])
})

// ── MCP tools ───────────────────────────────────────────────────────────

console.log('MCP · rules of ladder_start_session, ladder_send, ladder_wait')

interface World {
  sessions: Map<string, SessionInfo & { state: string; title: string }>
  starts: StartSpec[]
  sends: { id: string; text: string }[]
  confirms: string[]
  answer: boolean
  clock: number
  rules: { allowed: string[]; available: string[]; permissionsMax: PermissionLevel | null }
  waitResult: SessionWaitResult | null
  git: boolean
  rulesDelay: number
  onConfirm: (() => void) | null
}

function world(callerPermission: PermissionLevel = 'edit') {
  const w: World = { sessions: new Map(), starts: [], sends: [], confirms: [], answer: true, clock: 1_000_000, rules: { allowed: [], available: ['claude-code', 'codex'], permissionsMax: null }, waitResult: null, git: true, rulesDelay: 0, onConfirm: null }
  const add = (id: string, permission: PermissionLevel, origin: SessionInfo['origin'] = null, state = 'idle') => w.sessions.set(id, { sessionId: id, projectId: 'p1', agent: 'claude-code', permission, origin, usable: true, state, title: id })
  add('root', callerPermission)
  let seq = 0
  const deps: AgentSessionsDeps = {
    now: () => w.clock,
    t: (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => String(vars[k] ?? m)) : text),
    info: (id) => w.sessions.get(id) ?? null,
    rules: async () => (w.rulesDelay ? await new Promise((r) => setTimeout(r, w.rulesDelay)) : undefined, w.rules as never),
    isGit: () => w.git,
    list: () => [...w.sessions.values()].map((s): ListedSession => ({ id: s.sessionId, title: s.title, agent: s.agent, model: null, state: s.state, origin: s.origin, cwd: `/proj/${s.sessionId}`, branch: 'main' })),
    start: async (spec) => {
      w.starts.push(spec)
      const id = `child-${++seq}`
      add(id, spec.permission, spec.origin, 'running')
      return { sessionId: id, cwd: spec.worktree ? `/wt/${id}` : '/proj', branch: spec.worktree ? `ladder/${id}` : 'main' }
    },
    send: async (id, text) => void w.sends.push({ id, text }),
    wait: async (id) => w.waitResult ?? { sessionId: id, status: 'completed', text: 'the answer', error: null, waitingLabel: null, seq: 3 },
    confirm: async (_id, title) => (w.confirms.push(title), w.onConfirm?.(), w.answer)
  }
  return { w, add, mcp: new AgentSessions(deps), signal: new AbortController().signal }
}
const start = (m: AgentSessions, caller: string, args: object, signal: AbortSignal) => m.call(caller, 'ladder_start_session', { agent: 'codex', prompt: 'review src/', ...args }, signal)

await step('the result carries the sessionId as JSON on the first line (the UI derives the link from it)', async () => {
  const { mcp, signal } = world()
  const r = await start(mcp, 'root', {}, signal)
  assert.equal(r.isError, false)
  assert.equal(JSON.parse(r.text.split('\n')[0]).sessionId, 'child-1')
  const sent = await mcp.call('root', 'ladder_send', { sessionId: 'child-1', message: 'more' }, signal)
  assert.equal(JSON.parse(sent.text.split('\n')[0]).sessionId, 'child-1')
  const waited = await mcp.call('root', 'ladder_wait', { sessionId: 'child-1', timeoutSec: 30 }, signal)
  assert.equal(JSON.parse(waited.text.split('\n')[0]).sessionId, 'child-1')
  assert.match(waited.text, /the answer/)
})

await step('permission: never above the caller nor the project maximum; a caller in plan starts only plan', async () => {
  const a = world('edit')
  assert.match((await start(a.mcp, 'root', { permission: 'full' }, a.signal)).text, /above what you can give/)
  assert.equal((await start(a.mcp, 'root', { permission: 'plan' }, a.signal)).isError, false)
  assert.equal(a.w.starts[0].permission, 'plan')
  const dflt = await start(a.mcp, 'root', {}, a.signal)
  assert.equal(dflt.isError, false)
  assert.equal(a.w.starts[1].permission, 'edit')
  const full = world('full')
  await start(full.mcp, 'root', {}, full.signal)
  assert.equal(full.w.starts[0].permission, 'edit', 'with no level requested: edit at most')
  await start(full.mcp, 'root', { permission: 'full' }, full.signal)
  assert.equal(full.w.starts[1].permission, 'full')
  const capped = world('full')
  capped.w.rules.permissionsMax = 'ask'
  assert.match((await start(capped.mcp, 'root', { permission: 'edit' }, capped.signal)).text, /project maximum is "ask"/)
  assert.equal((await start(capped.mcp, 'root', {}, capped.signal)).isError, false)
  assert.equal(capped.w.starts[0].permission, 'ask')
  const readonly = world('plan')
  assert.match((await start(readonly.mcp, 'root', { permission: 'ask' }, readonly.signal)).text, /above what you can give/)
  assert.equal((await start(readonly.mcp, 'root', {}, readonly.signal)).isError, false)
  assert.equal(readonly.w.starts[0].permission, 'plan')
})

await step('agent: only allowed and available ones', async () => {
  const a = world()
  a.w.rules.allowed = ['claude-code']
  assert.match((await start(a.mcp, 'root', { agent: 'codex' }, a.signal)).text, /not allowed in this project/)
  const b = world()
  assert.match((await start(b.mcp, 'root', { agent: 'acp:gemini' }, b.signal)).text, /not available/)
  assert.match((await start(b.mcp, 'root', { prompt: '  ' }, b.signal)).text, /prompt is required/)
  assert.equal(b.w.starts.length, 0)
})

await step('Ask level: approval card; if denied, nothing starts; Edit and Full do not ask', async () => {
  const ask = world('ask')
  ask.w.answer = false
  const denied = await start(ask.mcp, 'root', { permission: 'ask' }, ask.signal)
  assert.equal(denied.isError, true)
  assert.match(denied.text, /did not allow/)
  assert.deepEqual(ask.w.confirms, ['Start a codex session'])
  assert.equal(ask.w.starts.length, 0)
  ask.w.answer = true
  assert.equal((await start(ask.mcp, 'root', { permission: 'ask' }, ask.signal)).isError, false)
  assert.equal(ask.w.starts.length, 1)
  const edit = world('edit')
  await start(edit.mcp, 'root', {}, edit.signal)
  assert.equal(edit.w.confirms.length, 0)
})

await step('send and wait only on sessions started by the caller (children and grandchildren); the list is read-only', async () => {
  const { w, add, mcp, signal } = world()
  add('stranger', 'edit')
  const child = JSON.parse((await start(mcp, 'root', {}, signal)).text.split('\n')[0]).sessionId as string
  assert.match((await mcp.call('root', 'ladder_send', { sessionId: 'stranger', message: 'x' }, signal)).text, /only use sessions you started/)
  assert.match((await mcp.call('root', 'ladder_wait', { sessionId: 'stranger' }, signal)).text, /only use sessions you started/)
  assert.match((await mcp.call('child-1', 'ladder_wait', { sessionId: 'root' }, signal)).text, /only use sessions you started/, 'a child cannot reach up')
  const grand = JSON.parse((await start(mcp, child, {}, signal)).text.split('\n')[0]).sessionId as string
  assert.equal((await mcp.call('root', 'ladder_wait', { sessionId: grand }, signal)).isError, false, 'root can wait on a grandchild')
  assert.equal((await mcp.call('root', 'ladder_send', { sessionId: grand, message: 'hey' }, signal)).isError, false)
  assert.deepEqual(w.sends, [{ id: grand, text: 'hey' }])
  const list = JSON.parse((await mcp.call('root', 'ladder_list_sessions', {}, signal)).text.split('\n\n')[0]) as { sessions: { sessionId: string; yours: boolean }[] }
  assert.deepEqual(list.sessions.map((s) => [s.sessionId, s.yours]).sort(), [[child, true], [grand, true], ['root', false], ['stranger', false]].sort())
  assert.match((await mcp.call('root', 'ladder_wait', { sessionId: child, timeoutSec: 601 }, signal)).text, /timeoutSec must be/)
})

await step('maximum depth 2: a grandchild starts nothing', async () => {
  const { mcp, signal } = world()
  const child = JSON.parse((await start(mcp, 'root', {}, signal)).text.split('\n')[0]).sessionId as string
  const grand = JSON.parse((await start(mcp, child, {}, signal)).text.split('\n')[0]).sessionId as string
  const refused = await start(mcp, grand, {}, signal)
  assert.equal(refused.isError, true)
  assert.match(refused.text, /nest at most 2 levels/)
})

await step('at most 5 children at work; 20 starts per hour', async () => {
  const a = world()
  for (let i = 0; i < 5; i++) assert.equal((await start(a.mcp, 'root', {}, a.signal)).isError, false)
  assert.match((await start(a.mcp, 'root', {}, a.signal)).text, /already have 5 sessions at work/)
  for (const s of a.w.sessions.values()) if (s.sessionId.startsWith('child')) s.state = 'idle'
  // 5 starts done: 15 more fit, then the hourly limit applies.
  for (let i = 0; i < 15; i++) {
    assert.equal((await start(a.mcp, 'root', {}, a.signal)).isError, false, `start ${i + 6}`)
    for (const s of a.w.sessions.values()) if (s.sessionId.startsWith('child')) s.state = 'idle'
  }
  assert.match((await start(a.mcp, 'root', {}, a.signal)).text, /20 sessions in the last hour/)
  a.w.clock += 3_600_001
  assert.equal((await start(a.mcp, 'root', {}, a.signal)).isError, false, 'after an hour starts are allowed again')
})

await step('origin of children: agent and session of whoever started them', async () => {
  const { w, mcp, signal } = world()
  await start(mcp, 'root', { title: 'Codex review', worktree: true }, signal)
  assert.deepEqual(w.starts[0].origin, { kind: 'agent', sessionId: 'root', agent: 'claude-code' })
  assert.equal(w.starts[0].title, 'Codex review')
  assert.equal(w.starts[0].worktree, true)
})

// ── Install ───────────────────────────────────────────────────────────

console.log('Command install')

await step('link in ~/.local/bin, never over a file that is not ours, safe uninstall', async () => {
  const home = join(tmp, 'home')
  const bin = join(tmp, 'Ladder.app', 'Contents', 'Resources', 'bin', 'ladder')
  mkdirSync(join(bin, '..'), { recursive: true })
  writeFileSync(bin, '#!/bin/sh\n')
  const install = new CliInstall({ bin, socket: () => '/s.sock', shellPath: async () => `/usr/bin:${home}/.local/bin`, t: (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => String(vars[k] ?? m)) : text), home })
  assert.deepEqual(await install.status(), { installed: false, path: join(home, '.local', 'bin', 'ladder'), inPath: true, socket: '/s.sock' })
  const done = await install.install()
  assert.equal(done.installed, true, 'creates the folder and the link')
  assert.equal((await install.install()).installed, true, 'idempotent')
  assert.equal((await install.uninstall()).installed, false)
  // Not ours: any other file in its place is left untouched.
  writeFileSync(done.path, 'mine')
  await assert.rejects(install.install(), /already exists and is not the Ladder command/)
  await assert.rejects(install.uninstall(), /not a link made by Ladder/)
  rmSync(done.path)
  // A link pointing elsewhere is not ours.
  symlinkSync('/bin/ls', done.path)
  await assert.rejects(install.install(), /already exists/)
  rmSync(done.path)
  const noPath = new CliInstall({ bin, socket: () => null, shellPath: async () => '/usr/bin', t: (x) => x, home })
  assert.equal((await noPath.status()).inPath, false)
})

// ── CLI against a fake host (in process) ─────────────────────────────────

console.log('CLI · commands against a fake host')

const project = { id: 'p1', name: 'My App', path: '/dev/app', branch: 'main', isGit: true, addedAt: 0 }
const session = (id: string, extra: object = {}) => ({ id, projectId: 'p1', title: `Session ${id}`, agent: 'codex', model: null, run: 'idle', waitingLabel: null, archived: false, mode: 'chat', activityAt: 1, origin: null, ...extra })
let outcome: SessionWaitResult = { sessionId: 'sess-1111', status: 'completed', text: 'Final answer from Codex', error: null, waitingLabel: null, seq: 4 }
const created: HostCommand[] = []
const fakeHost = async (command: HostCommand): Promise<unknown> => {
  switch (command.type) {
    case 'hello':
      return {
        projects: [project],
        sessions: [session('sess-1111'), session('sess-2222', { origin: { kind: 'agent', sessionId: 'abcdef123456', agent: 'claude-code' } }), session('arch-0000', { archived: true }), session('term-0000', { mode: 'terminal' })],
        agents: [{ agent: 'claude-code', available: true, name: 'Claude' }, { agent: 'codex', available: true, name: 'Codex' }],
        ui: { p1: { defaults: { agent: 'codex', permission: 'plan', models: { codex: 'gpt-x' } } } }
      }
    case 'session.create':
      created.push(command)
      return session('sess-1111')
    case 'session.wait':
      return outcome
    case 'session.transcript':
      return []
    default:
      created.push(command)
      return null
  }
}
const cliPath = sockPath()
const cliServer = new CliSocket(cliPath, { handle: fakeHost })
await cliServer.start()

async function cli(argv: string[], stdin = ''): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: Io = { out: (t) => (out += `${t}\n`), write: (t) => (out += t), err: (t) => (err += `${t}\n`), stdin: async () => stdin, env: { LADDER_SOCKET: cliPath }, cwd: '/dev/app/src', connect: connectSocket, onInterrupt: () => undefined }
  return { code: await run(argv, io), out, err }
}

await step('projects, ls (with filter and json) and help', async () => {
  assert.match((await cli(['projects'])).out, /My App\s+main\s+\/dev\/app/)
  const ls = await cli(['ls', '--project', '.'])
  assert.match(ls.out, /sess-111/)
  assert.match(ls.out, /agent abcdef12/)
  assert.ok(!ls.out.includes('arch-000'), 'archived sessions are not listed')
  assert.equal(JSON.parse((await cli(['ls', '--json'])).out).length, 2)
  assert.match((await cli(['--help'])).out, /Commands:/)
  assert.equal((await cli(['new', '--help'])).code, 0)
  assert.equal((await cli(['bogus'])).code, 64)
})

await step('new: uses the project defaults, prints the id; --wait prints the final answer', async () => {
  created.length = 0
  const r = await cli(['new', '.', 'Review the auth module'])
  assert.equal(r.code, 0)
  assert.equal(r.out.trim(), 'sess-1111')
  assert.deepEqual(created[0], { type: 'session.create', projectId: 'p1', agent: 'codex', text: 'Review the auth module', model: 'gpt-x', effort: null, permission: 'plan' })
  const flagged = await cli(['new', 'my app', 'go', '--agent', 'claude-code', '--permission', 'full', '--effort', 'high', '--worktree', '--model', 'opus'])
  assert.equal(flagged.code, 0)
  assert.deepEqual(created.at(-1), { type: 'session.create', projectId: 'p1', agent: 'claude-code', text: 'go', model: 'opus', effort: 'high', permission: 'full', worktree: true })
  const waited = await cli(['new', 'my app', 'go', '--wait'])
  assert.equal(waited.code, 0)
  assert.equal(waited.out.trim(), 'Final answer from Codex')
  assert.equal((await cli(['new', 'my app', 'go', '--effort', 'huge'])).code, 64)
  assert.equal((await cli(['new', 'my app', 'go', '--agent', 'acp:nope'])).code, 64)
  assert.match((await cli(['new', 'nowhere', 'go'])).err, /No Ladder project matches/)
})

await step('text from standard input with "-"', async () => {
  created.length = 0
  await cli(['new', 'my app', '-'], 'multi\nline prompt\n')
  assert.equal((created[0] as { text: string }).text, 'multi\nline prompt')
  await cli(['send', 'sess-11', '-'], 'follow up')
  assert.deepEqual(created.at(-1), { type: 'session.send', sessionId: 'sess-1111', text: 'follow up' })
  assert.equal((await cli(['send', 'sess-11', '-'], '   ')).code, 64)
})

await step('wait: 0 completed, 1 error, 2 interrupted, 3 needs the user, 4 timed out; --json', async () => {
  const base = { sessionId: 'sess-1111', text: null, error: null, waitingLabel: null, seq: 1 }
  const cases: [SessionWaitResult['status'], number, RegExp][] = [
    ['completed', 0, /./],
    ['error', 1, /stopped because of an error: Boom/],
    ['interrupted', 2, /interrupted/],
    ['needs-user', 3, /waiting for you in Ladder \(Approval\)/],
    ['timeout', 4, /Timed out/]
  ]
  for (const [status, code, message] of cases) {
    outcome = { ...base, status, text: status === 'completed' ? 'done' : null, error: status === 'error' ? 'Boom' : null, waitingLabel: status === 'needs-user' ? 'Approval' : null }
    const r = await cli(['wait', 'sess-11', '--timeout', '5'])
    assert.equal(r.code, code, status)
    assert.match(r.out + r.err, message, status)
  }
  assert.equal(JSON.parse((await cli(['wait', 'sess-11', '--json'])).out).status, 'timeout')
  assert.equal((await cli(['wait', 'sess-11', '--timeout', '0'])).code, 64)
  assert.equal((await cli(['send', 'sess-11', 'x', '--wait'])).code, 4)
})

await step('stop interrupts the turn; Ladder closed: clear message', async () => {
  created.length = 0
  assert.equal((await cli(['stop', 'sess-11'])).code, 0)
  assert.deepEqual(created[0], { type: 'session.interrupt', sessionId: 'sess-1111' })
  const io: Io = { out: () => undefined, write: () => undefined, err: () => undefined, stdin: async () => '', env: { LADDER_SOCKET: join(tmp, 'nope.sock') }, cwd: '/', connect: connectSocket, onInterrupt: () => undefined }
  let err = ''
  io.err = (t) => (err += t)
  assert.equal(await run(['ls'], io), 1)
  assert.equal(err, 'Ladder is not running. Open Ladder first.')
})

await step('attach: history not reprinted, then text, tools, requests and end of turn live', async () => {
  let out = ''
  const f = new Follower((t) => (out += t))
  const a = (id: string, text: string, streaming: boolean, seq: number) => ({ kind: 'assistant', id, turnId: 't', seq, at: 0, text, streaming }) as ChatItem
  // An event that arrives before the history is not used as the baseline and is not lost.
  f.handle({ type: 'session.items', sessionId: 's', replace: false, items: [a('early', 'early text', false, 2)] })
  assert.equal(out, '')
  f.start([{ id: 'old', mark: 'history'.length }])
  assert.equal(out, 'early text\n', 'replayed after the history')
  out = ''
  f.handle({ type: 'session.items', sessionId: 's', replace: false, items: [{ kind: 'user', id: 'u', turnId: 't2', seq: 2, at: 0, text: 'next question' } as ChatItem, a('n', 'Hel', true, 3)] })
  f.handle({ type: 'session.items', sessionId: 's', replace: false, items: [a('n', 'Hello world', false, 3)] })
  f.handle({ type: 'session.items', sessionId: 's', replace: false, items: [{ kind: 'tool', id: 'tl', turnId: 't2', seq: 4, at: 0, tool: 'command', name: 'Bash', title: 'Runs pnpm test', detail: null, status: 'running', output: null, endedAt: null } as ChatItem] })
  f.handle({ type: 'session.items', sessionId: 's', replace: false, items: [{ kind: 'request', id: 'rq', turnId: 't2', seq: 5, at: 0, requestId: 'r', requestType: 'permission', toolName: 'Bash', title: 'Run rm', command: null, path: null, reason: null, options: [], questions: null, state: 'open', resolution: null } as ChatItem] })
  f.handle({ type: 'session.items', sessionId: 's', replace: false, items: [{ kind: 'turn-end', id: 'te', turnId: 't2', seq: 6, at: 0, status: 'completed', durationMs: 2500, counts: { commands: 0, edits: 0, reads: 0, searches: 0 }, files: [], error: null, costUsd: null } as ChatItem] })
  assert.ok(!out.includes('history'))
  assert.match(out, /> next question\nHello world\n/)
  assert.match(out, /• Runs pnpm test/)
  assert.match(out, /! Waiting for you in Ladder: Run rm/)
  assert.match(out, /-- Turn completed \(2\.5s\) --/)
  assert.equal(out.match(/Hello/g)?.length, 1, 'streamed text is not repeated')
})

cliServer.close()
const cliServer2 = new CliSocket(cliPath, { handle: fakeHost })
await cliServer2.start()
const cli2 = cli

// ── Real round trip: real socket, CLI as a process ──────────────────────────────

console.log('Real round trip · the CLI spawned as a process against a fake host')

await step('ladder new --wait: creates a Codex session and prints the final answer (exit 0)', async () => {
  const path = sockPath()
  const calls: HostCommand[] = []
  const server = new CliSocket(path, {
    handle: async (command) => {
      calls.push(command)
      if (command.type === 'hello') return { projects: [project], sessions: [], agents: [{ agent: 'codex', available: true, name: 'Codex' }], ui: {} }
      if (command.type === 'session.create') return session('real-0001')
      if (command.type === 'session.wait') return { sessionId: 'real-0001', status: 'completed', text: 'The answer is 42.', error: null, waitingLabel: null, seq: 2 }
      return null
    }
  })
  await server.start()
  const main = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url))
  const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', main, 'new', 'my app', 'What is the answer?', '--agent', 'codex', '--wait'], { env: { PATH: process.env.PATH, LADDER_SOCKET: path } })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => resolve({ code, out, err }))
  })
  server.close()
  assert.equal(result.code, 0, result.err)
  assert.equal(result.out.trim(), 'The answer is 42.')
  assert.equal(calls.find((c) => c.type === 'session.create')?.type, 'session.create')
  assert.equal((calls.find((c) => c.type === 'session.create') as { agent: string }).agent, 'codex')
  // With no Ladder listening.
  const missing = await new Promise<{ code: number | null; err: string }>((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', main, 'ls'], { env: { PATH: process.env.PATH, LADDER_SOCKET: join(tmp, 'absent.sock') } })
    let err = ''
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => resolve({ code, err }))
  })
  assert.equal(missing.code, 1)
  assert.match(missing.err, /Open Ladder first/)
})

console.log('Edge cases')

await step('terminal sessions are excluded from resolution (there is no "work finished" to wait for)', async () => {
  const r = await cli2(['wait', 'term-0'])
  assert.equal(r.code, 1)
  assert.match(r.err, /No session matches/)
})

await step('project "." in folders with spaces, accents and "#", and through a symlink', () => {
  const dir = join(tmp, 'My café folder #1', 'src')
  mkdirSync(dir, { recursive: true })
  const root = join(tmp, 'My café folder #1')
  const link = join(tmp, 'link-to-project')
  symlinkSync(realpathSync(root), link)
  const projects = [{ id: 'p1', name: 'One', path: realpathSync(root) }] as never[]
  assert.equal(findProject(projects, '.', dir).id, 'p1')
  assert.equal(findProject(projects, '..', dir).id, 'p1')
  assert.equal(findProject(projects, './src', root).id, 'p1')
  assert.equal(findProject(projects, '.', join(link, 'src')).id, 'p1', 'cwd inside a symlink to the project')
  assert.equal(findProject([{ id: 'p2', name: 'Two', path: link }] as never[], '.', dir).id, 'p2', 'project registered with the link path')
})

await step('large output on a pipe: arrives whole (no truncation at 64 KB)', async () => {
  const path = sockPath()
  const big = 'x'.repeat(400_000)
  const server = new CliSocket(path, {
    handle: async (command) => {
      if (command.type === 'hello') return { projects: [project], sessions: [session('big-0001')], agents: [], ui: {} }
      return { sessionId: 'big-0001', status: 'completed', text: big, error: null, waitingLabel: null, seq: 1 }
    }
  })
  await server.start()
  const main = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url))
  const out = await new Promise<{ code: number | null; bytes: number; json: boolean }>((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', main, 'wait', 'big-0001', '--json'], { env: { PATH: process.env.PATH, LADDER_SOCKET: path } })
    const chunks: Buffer[] = []
    // A slow reader, like `| jq`: the pipe fills up before anything is read.
    child.stdout.pause()
    setTimeout(() => child.stdout.resume(), 300)
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.on('close', (code) => {
      const text = Buffer.concat(chunks).toString()
      let json = false
      try {
        json = (JSON.parse(text) as { text: string }).text.length === big.length
      } catch {
        // Truncated JSON.
      }
      resolve({ code, bytes: text.length, json })
    })
  })
  server.close()
  assert.equal(out.code, 0)
  assert.equal(out.json, true, `received ${out.bytes} bytes`)
})

await step('a client that closes the connection stops the long wait', async () => {
  const path = sockPath()
  let aborted: (v: boolean) => void = () => undefined
  const wasAborted = new Promise<boolean>((resolve) => (aborted = resolve))
  const server = new CliSocket(path, {
    handle: async (_command, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      aborted(true)
      return null
    }
  })
  await server.start()
  const socket = connect(path)
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
  socket.write(`${JSON.stringify({ rid: '1', command: { type: 'session.wait', sessionId: 'x' } })}\n`)
  await new Promise((resolve) => setTimeout(resolve, 50))
  socket.destroy()
  assert.equal(await Promise.race([wasAborted, new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]), true)
  server.close()
})

await step('a client that does not read is closed instead of growing memory', async () => {
  const path = sockPath()
  const server = new CliSocket(path, { handle: async () => null })
  await server.start()
  const socket = connect(path)
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
  socket.write(`${JSON.stringify({ rid: '1', subscribe: 's1' })}\n`)
  socket.pause()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const closed = new Promise<boolean>((resolve) => {
    socket.on('close', () => resolve(true))
    socket.on('error', () => undefined)
  })
  const chunk = 'y'.repeat(1024 * 1024)
  for (let i = 0; i < 60; i++) server.publish({ type: 'session.items', sessionId: 's1', items: [{ kind: 'notice', id: `n${i}`, turnId: 't', seq: i, at: 0, tone: 'info', text: chunk } as ChatItem], replace: false })
  socket.resume()
  assert.equal(await Promise.race([closed, new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]), true)
  server.close()
})

await step('MCP: notifications/cancelled and session close stop ladder_wait', async () => {
  const seenSignal: AbortSignal[] = []
  const server = new LadderMcpServer({
    ...unusedBackend,
    tools: () => COORDINATOR_TOOLS,
    sessions: async (_s, _t, _a, signal) => {
      seenSignal.push(signal)
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { text: 'cancelled', isError: true }
    }
  })
  await server.start()
  const h = server.register('chat')!
  const url = h.url
  const post = (body: object) => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${h.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const pending = post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ladder_wait', arguments: { sessionId: 'x' } } }).then((r) => r.json())
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(seenSignal[0].aborted, false)
  await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } })
  await pending
  assert.equal(seenSignal[0].aborted, true)
  // Session closed (token revoked) with a call in flight.
  const again = post({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'ladder_wait', arguments: { sessionId: 'x' } } }).then((r) => r.json())
  await new Promise((resolve) => setTimeout(resolve, 50))
  server.revoke('chat')
  await again
  assert.equal(seenSignal[1].aborted, true)
  await server.close()
})

await step('limits reserved before any await: parallel calls do not exceed 5 children or 20 starts', async () => {
  const a = world()
  a.w.rulesDelay = 20
  const results = await Promise.all(Array.from({ length: 8 }, () => start(a.mcp, 'root', {}, a.signal)))
  assert.equal(results.filter((r) => !r.isError).length, 5)
  assert.equal(a.w.starts.length, 5)
  assert.ok(results.filter((r) => r.isError).every((r) => /already have \d+ sessions at work/.test(r.text)))
  // A start that fails releases its slot.
  const b = world()
  b.w.rules.available = ['claude-code']
  for (let i = 0; i < 25; i++) assert.equal((await start(b.mcp, 'root', { agent: 'codex' }, b.signal)).isError, true)
  b.w.rules.available = ['claude-code', 'codex']
  assert.equal((await start(b.mcp, 'root', {}, b.signal)).isError, false, 'rejections do not consume the hourly limit')
})

await step('Ask level: if the session is archived while the card is open, nothing starts', async () => {
  const a = world('ask')
  a.w.onConfirm = () => void (a.w.sessions.get('root')!.usable = false)
  const r = await start(a.mcp, 'root', { permission: 'ask' }, a.signal)
  assert.equal(r.isError, true)
  assert.match(r.text, /session is closed/)
  assert.equal(a.w.starts.length, 0)
})

await step('writers get their own worktree by default (git), the same folder when read-only or without git', async () => {
  const a = world('full')
  await start(a.mcp, 'root', { permission: 'edit' }, a.signal)
  await start(a.mcp, 'root', { permission: 'full' }, a.signal)
  await start(a.mcp, 'root', { permission: 'plan' }, a.signal)
  await start(a.mcp, 'root', { permission: 'ask' }, a.signal)
  await start(a.mcp, 'root', { permission: 'edit', worktree: false }, a.signal)
  assert.deepEqual(a.w.starts.map((x) => x.worktree), [true, true, false, false, false])
  const explicit = world('full')
  await start(explicit.mcp, 'root', { permission: 'plan', worktree: true }, explicit.signal)
  assert.equal(explicit.w.starts[0].worktree, true)
  const noGit = world('full')
  noGit.w.git = false
  await start(noGit.mcp, 'root', { permission: 'edit' }, noGit.signal)
  await start(noGit.mcp, 'root', { permission: 'edit', worktree: true }, noGit.signal)
  assert.deepEqual(noGit.w.starts.map((x) => x.worktree), [false, false])
})

console.log('More edge cases')

await step('ladder_start_session returns the child folder and branch; the list includes them', async () => {
  const a = world('full')
  const started = JSON.parse((await start(a.mcp, 'root', { permission: 'edit' }, a.signal)).text.split('\n')[0])
  assert.deepEqual([started.worktree, started.cwd, started.branch], [true, '/wt/child-1', 'ladder/child-1'])
  const shared = JSON.parse((await start(a.mcp, 'root', { permission: 'plan' }, a.signal)).text.split('\n')[0])
  assert.deepEqual([shared.worktree, shared.cwd, shared.branch], [false, '/proj', 'main'])
  const list = JSON.parse((await a.mcp.call('root', 'ladder_list_sessions', {}, a.signal)).text.split('\n\n')[0]) as { sessions: { sessionId: string; cwd: string; branch: string }[] }
  assert.ok(list.sessions.every((x) => x.cwd.startsWith('/proj/') && x.branch === 'main'))
})

await step('attach: Ctrl-C detaches without saying Ladder closed; Ladder closing does say so', async () => {
  let out = ''
  let err = ''
  let interrupt: () => void = () => undefined
  const io: Io = { out: (t) => (out += `${t}\n`), write: (t) => (out += t), err: (t) => (err += `${t}\n`), stdin: async () => '', env: { LADDER_SOCKET: cliPath }, cwd: '/', connect: connectSocket, onInterrupt: (fn) => void (interrupt = fn) }
  const running = run(['attach', 'sess-11'], io)
  await new Promise((resolve) => setTimeout(resolve, 150))
  interrupt()
  assert.equal(await running, 0)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.match(err, /Detached/)
  assert.ok(!err.includes('closed the connection'), err)
  // Ladder closing the connection is a different case.
  let err2 = ''
  const io2: Io = { ...io, err: (t) => (err2 += `${t}\n`), onInterrupt: () => undefined }
  const second = run(['attach', 'sess-11'], io2)
  await new Promise((resolve) => setTimeout(resolve, 150))
  cliServer2.close()
  assert.equal(await second, 1)
  assert.match(err2, /Ladder closed the connection/)
  await cliServer2.start()
})

await step('a huge response (history) does not close the connection; the cap only applies to queued events', async () => {
  const path = sockPath()
  const big = 'z'.repeat(6 * 1024 * 1024)
  const server = new CliSocket(path, { handle: async () => ({ big }) })
  await server.start()
  const conn = await connectSocket(path)
  const first = (await conn.request({ type: 'hello' } as HostCommand)) as { big: string }
  assert.equal(first.big.length, big.length)
  const again = (await conn.request({ type: 'hello' } as HostCommand)) as { big: string }
  assert.equal(again.big.length, big.length, 'the connection is still alive')
  conn.close()
  server.close()
})

await step('session.wait: the chat is read only once work is done', () => {
  let reads = 0
  const items = () => (reads++, turn('completed'))
  assert.equal(decideWait({ ...base, busy: true, items }), null)
  assert.equal(decideWait({ ...base, background: true, items }), null)
  assert.equal(decideWait({ ...base, queued: 2, items }), null)
  assert.equal(reads, 0)
  assert.equal(decideWait({ ...base, items })!.status, 'completed')
  assert.equal(reads, 1, 'a single read per response')
})

console.log('Ladder MCP server · tools per role')

await step('coordinators see propose_plan, revise_plan and the four ladder_* tools; tasks only report_result', async () => {
  const calls: { session: string; tool: string; aborted: boolean }[] = []
  const server = new LadderMcpServer({
    ...unusedBackend,
    tools: (id) => (id === 'task' ? ['report_result'] : id === 'chat' ? COORDINATOR_TOOLS : id === 'advice' ? ['list_agents'] : null),
    sessions: async (session, tool, _args, signal) => {
      calls.push({ session, tool, aborted: signal.aborted })
      return { text: 'ok', isError: false }
    }
  })
  await server.start()
  const rpc = async (token: string, port: number, method: string, params: object = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    return (await res.json()) as { result?: { tools?: { name: string }[]; content?: { text: string }[] }; error?: { message: string } }
  }
  const chat = server.register('chat')!
  const task = server.register('task')!
  const advice = server.register('advice')!
  const port = Number(new URL(chat.url).port)
  const names = async (h: typeof chat) => ((await rpc(h.token, port, 'tools/list')).result?.tools ?? []).map((t) => t.name).sort()
  assert.deepEqual(await names(chat), ['ladder_list_sessions', 'ladder_send', 'ladder_start_session', 'ladder_wait', 'propose_plan', 'revise_plan'])
  assert.deepEqual(await names(task), ['report_result'])
  assert.deepEqual(await names(advice), ['list_agents'], 'a read-only advice child only reads')
  assert.equal((await rpc(chat.token, port, 'tools/call', { name: 'ladder_wait', arguments: { sessionId: 'x' } })).result?.content?.[0].text, 'ok')
  assert.equal(calls[0].tool, 'ladder_wait')
  assert.match((await rpc(task.token, port, 'tools/call', { name: 'ladder_start_session', arguments: {} })).error?.message ?? '', /Unknown tool/, 'a task cannot start sessions')
  const bad = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${'0'.repeat(64)}` }, body: '{}' })
  assert.equal(bad.status, 401)
  await server.close()
})

await step('one server: handoff, delegation and plan tools together, one report_result for plan tasks and delegations', async () => {
  const seen: string[] = []
  const server = new LadderMcpServer({
    tools: (id) => (id === 'chat' ? ['list_agents', 'handoff', 'delegate', 'report_result', ...COORDINATOR_TOOLS] : id === 'task' ? ['report_result'] : null),
    listAgents: async () => ({ text: 'agents' }),
    handoff: async (_s, args) => ({ text: `handoff ${args.agent} ${args.note ?? '-'}` }),
    delegate: async (_s, args) => ({ text: `delegate ${args.agent} ${args.readOnly}` }),
    report: async (id, args) => ({ text: `report ${id} ${JSON.stringify(args)}` }),
    plan: async (_s, tool) => ({ text: `plan ${tool}` }),
    sessions: async (_s, tool) => ({ text: `sessions ${tool}` })
  })
  await server.start()
  const chat = server.register('chat')!
  const task = server.register('task')!
  const post = async (h: typeof chat, method: string, params: object = {}) => {
    const res = await fetch(h.url, { method: 'POST', headers: { Authorization: `Bearer ${h.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    return (await res.json()) as { result?: { tools?: { name: string; inputSchema: { properties: Record<string, unknown> } }[]; content?: { text: string }[]; isError?: boolean }; error?: { message: string } }
  }
  const listed = (await post(chat, 'tools/list')).result?.tools ?? []
  seen.push(...listed.map((tool) => tool.name))
  assert.equal(new Set(seen).size, 10)
  const report = listed.find((tool) => tool.name === 'report_result')!
  for (const key of ['status', 'summary', 'files', 'checks', 'verdict']) assert.ok(key in report.inputSchema.properties, `report_result has ${key}`)
  const text = async (h: typeof chat, name: string, args: object) => (await post(h, 'tools/call', { name, arguments: args })).result?.content?.[0].text
  assert.equal(await text(chat, 'handoff', { agent: 'codex', summary: 'x' }), 'handoff codex -')
  assert.equal(await text(chat, 'delegate', { agent: 'codex', prompt: 'x', read_only: true }), 'delegate codex true')
  assert.equal(await text(chat, 'propose_plan', { goal: 'x' }), 'plan propose_plan')
  assert.equal(await text(chat, 'ladder_wait', { sessionId: 'x' }), 'sessions ladder_wait')
  assert.equal(await text(task, 'report_result', { status: 'done', summary: 'ok' }), 'report task {"status":"done","summary":"ok"}')
  assert.match((await post(task, 'tools/call', { name: 'handoff', arguments: {} })).error?.message ?? '', /Unknown tool/, 'a plan task cannot hand off')
  assert.equal((await post(chat, 'tools/call', { name: 'handoff', arguments: { agent: 'codex' } })).result?.isError, true, 'handoff arguments are validated by the server')
  await server.close()
})

await step('report_result from a delegation folds the plan-style fields into the summary and keeps the files', () => {
  const ok = parseReport({ status: 'done', summary: 'Reviewed the diff.', files: ['src/a.ts'], issues: [{ severity: 'blocking', file: 'src/a.ts', line: 3, text: 'Missing check' }], checks: [{ cmd: 'pnpm test', exit: 0 }] })
  assert.ok(ok.ok)
  if (ok.ok) {
    assert.deepEqual(ok.args.files, ['src/a.ts'])
    assert.match(ok.args.summary, /Reviewed the diff\./)
    assert.match(ok.args.summary, /\[blocking\] src\/a\.ts:3: Missing check/)
    assert.match(ok.args.summary, /pnpm test.*exit 0/)
  }
  assert.equal(parseReport({ status: 'nope', summary: 'x' }).ok, false)
  assert.equal(parseReport({ status: 'done', summary: '  ' }).ok, false)
})

await step('tools by role: agent-started sessions have no handoff; report_result only where someone waits', () => {
  const base = { planTask: false, childRole: null, started: false, handedOff: false, canDelegate: true } as const
  const user = toolsForRole(base)
  assert.ok(user.includes('handoff') && user.includes('propose_plan') && user.includes('ladder_wait'))
  assert.ok(!user.includes('report_result'), 'nobody waits on a plain chat')
  const started = toolsForRole({ ...base, started: true })
  assert.ok(!started.includes('handoff') && !started.includes('report_result') && started.includes('ladder_start_session'))
  assert.ok(toolsForRole({ ...base, handedOff: true }).includes('report_result'))
  assert.deepEqual(toolsForRole({ ...base, planTask: true }), ['report_result'])
  assert.deepEqual(toolsForRole({ ...base, childRole: 'advisor' }), ['list_agents'])
  assert.deepEqual(toolsForRole({ ...base, childRole: 'review' }), ['list_agents'])
  assert.deepEqual(toolsForRole({ ...base, childRole: 'delegate', canDelegate: false }), ['list_agents', 'report_result'])
  assert.deepEqual(toolsForRole({ ...base, childRole: 'delegate' }), ['list_agents', 'report_result', 'delegate'])
})

cliServer2.close()
rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} tests passed`)
