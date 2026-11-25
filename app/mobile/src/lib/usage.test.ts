import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RemoteAgentStatus, RemoteProfile, UsageWindow } from '../../../desktop/src/shared/protocol.ts'
import { buildUsageAccounts, dismissKey, isDismissed, durationText, isStale, liveWindows, resetsLabel, resetsWhen, sessionAlert, updatedLabel, worstText, usageAlert, usageAlertText, USAGE_BANNER_AT, windowName, worstWindow } from './usage.ts'

const NOW = Math.floor(new Date(2026, 10, 25, 16, 30).getTime() / 1000)
const win = (patch: Partial<UsageWindow>): UsageWindow => ({ key: 'w5h', minutes: 300, model: null, percent: 10, resetsAt: NOW + 3600, state: 'ok', ...patch })
const status = (agent: RemoteAgentStatus['agent'], patch: Partial<RemoteAgentStatus> = {}): RemoteAgentStatus => ({ agent, name: agent, kind: 'native', available: true, version: '1', account: 'Claude Max', models: [], error: null, ...patch })

test('no warning under 80%; from 80% yes; limited always', () => {
  assert.equal(usageAlert([win({ percent: 79 })]), null)
  assert.equal(usageAlert([win({ percent: 80 })])?.limited, false)
  assert.equal(usageAlert([win({ percent: 40, state: 'limited' })])?.limited, true)
})

test('without a percentage `warning` counts, not `ok`', () => {
  assert.equal(usageAlert([win({ percent: null, state: 'ok' })]), null)
  assert.ok(usageAlert([win({ percent: null, state: 'warning' })]))
})

test('extra usage without reset is not a plan limit', () => {
  assert.equal(usageAlert([win({ key: 'extra_usage', percent: 99, resetsAt: null, label: 'Extra usage' })]), null)
})

test('among several windows the exhausted one wins, then the highest', () => {
  const week = win({ key: 'wk', minutes: 10080, percent: 91 })
  const five = win({ percent: 85 })
  assert.equal(usageAlert([five, week])?.usage.key, 'wk')
  const limited = win({ key: 'lim', percent: 50, state: 'limited' })
  assert.equal(usageAlert([week, limited])?.usage.key, 'lim')
})

test('the small banner starts at 95% or when the limit is exhausted', () => {
  assert.equal(usageAlert([win({ percent: 94 })], USAGE_BANNER_AT), null)
  assert.ok(usageAlert([win({ percent: 95 })], USAGE_BANNER_AT))
  assert.ok(usageAlert([win({ percent: null, state: 'limited' })], USAGE_BANNER_AT))
  // `warning` without a percentage is enough for the icon but not for the small banner
  assert.equal(usageAlert([win({ percent: null, state: 'warning' })], USAGE_BANNER_AT), null)
})

test('windows already reset disappear, those without reset stay', () => {
  const list = [win({ key: 'a', resetsAt: NOW - 5 }), win({ key: 'b', resetsAt: NOW + 5 }), win({ key: 'c', resetsAt: null })]
  assert.deepEqual(liveWindows(list, NOW).map((w) => w.key), ['b', 'c'])
  assert.deepEqual(liveWindows(undefined, NOW), [])
})

test('window names', () => {
  assert.equal(windowName(win({})), '5-hour window')
  assert.equal(windowName(win({ minutes: 10080 })), 'Weekly')
  assert.equal(windowName(win({ minutes: 10080, model: 'Opus' })), 'Weekly · Opus')
  assert.equal(windowName(win({ label: 'Extra usage' })), 'Extra usage')
})

test('durations and reset times', () => {
  assert.equal(durationText(20), '1 min')
  assert.equal(durationText(12 * 60), '12 min')
  assert.equal(durationText(2 * 3600), '2 h')
  assert.equal(durationText(2 * 3600 + 5 * 60), '2 h 5 min')
  assert.equal(durationText(3 * 86400 + 4 * 3600), '3 d 4 h')
  // today: only the time; another day: also the weekday
  const today = resetsWhen(NOW + 3600, NOW)
  assert.equal(today.today, true)
  assert.match(today.when, /^\d{1,2}:\d{2}/)
  const later = resetsWhen(NOW + 2 * 86400, NOW)
  assert.equal(later.today, false)
  assert.ok(later.when.length > today.when.length)
  assert.match(resetsLabel(NOW + 2 * 3600, NOW), /^Resets at .+ · in 2 h$/)
  assert.match(resetsLabel(NOW + 2 * 86400 + 3600, NOW), /^Resets (?!at).+ · in 2 d 1 h$/)
})

test('"Updated N min ago"', () => {
  assert.equal(updatedLabel(null, NOW), 'Not read yet')
  assert.equal(updatedLabel((NOW - 20) * 1000, NOW), 'Updated just now')
  assert.equal(updatedLabel((NOW - 3 * 60) * 1000, NOW), 'Updated 3 min ago')
})

test('warning text: near the limit and limit reached', () => {
  const near = usageAlertText({ usage: win({ percent: 87.6 }), limited: false }, NOW)
  assert.equal(near.what, '5-hour window: close to the limit (88% used).')
  assert.match(near.reset ?? '', /^Resets at /)
  assert.equal(usageAlertText({ usage: win({ percent: 100, state: 'limited' }), limited: true }, NOW).what, '5-hour window: limit reached.')
})

test('data to refresh: never read or older than a minute', () => {
  const ms = 1_000_000
  assert.equal(isStale(null, undefined, ms), true)
  assert.equal(isStale(ms - 30_000, undefined, ms), false)
  assert.equal(isStale(ms - 90_000, undefined, ms), true)
  assert.equal(isStale(ms - 90_000, ms - 10_000, ms), false)
})

const profiles: RemoteProfile[] = [
  { id: 'default:claude-code', agent: 'claude-code', name: 'Personal', isDefault: true },
  { id: 'p-work', agent: 'claude-code', name: 'Work', isDefault: false },
  { id: 'default:codex', agent: 'codex', name: 'Default', isDefault: true }
]
const agents: RemoteAgentStatus[] = [
  status('claude-code', { usage: [win({ percent: 40 })] }),
  status('claude-code', { profileId: 'p-work', account: 'Claude Team', usage: [win({ percent: 82 })] }),
  status('codex', { account: 'ChatGPT Pro', usage: [win({ percent: 12 })] }),
  status('acp:gemini-cli', { kind: 'acp', account: null })
]

test('subscriptions: one per connected profile, the profile is named only if there is more than one', () => {
  const list = buildUsageAccounts(agents, profiles)
  assert.deepEqual(list.map((a) => [a.key, a.profileName]), [['claude-code:default:claude-code', 'Personal'], ['claude-code:p-work', 'Work'], ['codex:default:codex', null]])
  assert.equal(list[2].native, true)
})

test('subscriptions: the session account comes first, and is always there (even ACP)', () => {
  const list = buildUsageAccounts(agents, profiles, { agent: 'claude-code', profileId: 'p-work' })
  assert.equal(list[0].key, 'claude-code:p-work')
  assert.equal(list[0].current, true)
  const acp = buildUsageAccounts(agents, profiles, { agent: 'acp:gemini-cli' })
  assert.equal(acp[0].agent, 'acp:gemini-cli')
  assert.equal(acp[0].native, false)
  assert.equal(acp.length, 4)
})

test('a disconnected agent (no account) does not appear', () => {
  const list = buildUsageAccounts([status('claude-code', { account: null })], profiles.slice(0, 1))
  assert.deepEqual(list, [])
})

test('worst window for the Settings row', () => {
  const worst = worstWindow(buildUsageAccounts(agents, profiles), NOW)
  assert.equal(worst?.account.key, 'claude-code:p-work')
  assert.equal(worst?.usage.percent, 82)
  assert.equal(worstWindow([], NOW), null)
})

test('session warning: uses the session account, not another one', () => {
  assert.equal(sessionAlert(agents, 'claude-code', null, NOW), null)
  assert.ok(sessionAlert(agents, 'claude-code', 'p-work', NOW))
  assert.equal(sessionAlert(agents, 'codex', 'default:codex', NOW), null)
})

test('Settings row: worst window in a few words', () => {
  const accounts = buildUsageAccounts(agents, profiles)
  assert.equal(worstText(worstWindow(accounts, NOW)!), 'Claude · 82% of 5h')
  const week = { account: accounts[0], usage: win({ minutes: 10080, percent: 88.4 }) }
  assert.equal(worstText(week), 'Claude · 88% of weekly')
  assert.equal(worstText({ account: accounts[2], usage: win({ percent: 100, state: 'limited' }) }), 'Codex · limit reached')
})

test('worst window: an exhausted one without percentage counts, an ok one without percentage does not', () => {
  const limited = [{ ...buildUsageAccounts(agents, profiles)[0], status: status('claude-code', { usage: [win({ percent: null, state: 'limited' })] }) }]
  assert.equal(worstWindow(limited, NOW)?.usage.state, 'limited')
  assert.equal(worstText(worstWindow(limited, NOW)!), 'Claude · limit reached')
  const ok = [{ ...limited[0], status: status('claude-code', { usage: [win({ percent: null, state: 'ok' })] }) }]
  assert.equal(worstWindow(ok, NOW), null)
  // the exhausted one beats one at 99%
  const both = [limited[0], { ...limited[0], key: 'b', status: status('codex', { usage: [win({ percent: 99 })] }) }]
  assert.equal(worstWindow(both, NOW)?.usage.state, 'limited')
})

test('dismissed banner: the same reset (even if it drifts by a few minutes) stays dismissed, a new one does not', () => {
  const key = dismissKey('claude-code', null, 'five_hour')
  assert.equal(key, 'claude-code:default:claude-code:five_hour')
  const closed = new Map<string, number | null>([[key, NOW + 3600]])
  assert.equal(isDismissed(closed, key, NOW + 3600), true)
  assert.equal(isDismissed(closed, key, NOW + 3600 + 90), true)
  assert.equal(isDismissed(closed, key, NOW + 3600 + 5 * 3600), false)
  assert.equal(isDismissed(closed, dismissKey('claude-code', null, 'seven_day'), NOW + 3600), false)
  // without a reset: closed until one shows up
  const open = new Map<string, number | null>([[key, null]])
  assert.equal(isDismissed(open, key, null), true)
  assert.equal(isDismissed(open, key, NOW + 3600), false)
})
