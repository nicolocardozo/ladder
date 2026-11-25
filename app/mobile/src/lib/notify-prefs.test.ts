import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_NOTIFY_PREFS, crossesMidnight, dateToTime, isTime, isTimeZone, minutesToTime, normalizeNotifyPrefs, timeToDate, timeToMinutes, toWirePrefs } from './notify-prefs.ts'

test('times: 24-hour HH:MM validation', () => {
  for (const ok of ['00:00', '07:05', '23:59']) assert.equal(isTime(ok), true, ok)
  for (const bad of ['24:00', '7:05', '07:60', '07:5', '', 7, null, '07:05:00']) assert.equal(isTime(bad), false, String(bad))
})

test('times: minutes to and from HH:MM, even out of range', () => {
  assert.equal(timeToMinutes('22:30'), 1350)
  assert.equal(minutesToTime(1350), '22:30')
  assert.equal(minutesToTime(1440), '00:00')
  assert.equal(minutesToTime(-30), '23:30')
  assert.equal(timeToMinutes('boh'), 0)
})

test('picker: the date carries the local time and round-trips', () => {
  const d = timeToDate('07:45', new Date(2026, 10, 24, 15, 0, 0))
  assert.equal(d.getHours(), 7)
  assert.equal(d.getMinutes(), 45)
  assert.equal(d.getDate(), 24)
  assert.equal(dateToTime(d), '07:45')
  assert.equal(dateToTime(new Date(2026, 0, 1, 0, 5)), '00:05')
})

test('window spanning midnight', () => {
  assert.equal(crossesMidnight('22:00', '07:00'), true)
  assert.equal(crossesMidnight('13:00', '15:00'), false)
  assert.equal(crossesMidnight('08:00', '08:00'), false)
})

test('time zones', () => {
  assert.equal(isTimeZone('Europe/Rome'), true)
  assert.equal(isTimeZone('Not/AZone'), false)
  assert.equal(isTimeZone(''), false)
  assert.equal(isTimeZone('A'.repeat(65)), false)
  assert.equal(isTimeZone(5), false)
})

test('normalization: corrupted data falls back to defaults, the rest is kept', () => {
  assert.deepEqual(normalizeNotifyPrefs(undefined), DEFAULT_NOTIFY_PREFS)
  assert.deepEqual(normalizeNotifyPrefs('x'), DEFAULT_NOTIFY_PREFS)
  const p = normalizeNotifyPrefs({ events: { request: false, turn: 'sì', error: true }, quiet: { enabled: true, from: '25:00', to: '06:30' }, quietAllowsRequests: 1 })
  assert.deepEqual(p.events, { request: false, turn: true, error: true, agents: true })
  assert.deepEqual(p.quiet, { enabled: true, from: '22:00', to: '06:30' })
  assert.equal(p.quietAllowsRequests, false)
})

test('towards the Mac: window only if on, in the given time zone', () => {
  const prefs = { ...DEFAULT_NOTIFY_PREFS, events: { ...DEFAULT_NOTIFY_PREFS.events, turn: false } }
  assert.deepEqual(toWirePrefs(prefs, 'Europe/Rome'), { events: { request: true, turn: false, error: true, agents: true }, quiet: null, quietAllowsRequests: false })
  const quiet = { ...prefs, quiet: { enabled: true, from: '23:00', to: '06:45' }, quietAllowsRequests: true }
  assert.deepEqual(toWirePrefs(quiet, 'Europe/Rome').quiet, { from: '23:00', to: '06:45', tz: 'Europe/Rome' })
  assert.equal(toWirePrefs(quiet, 'Europe/Rome').quietAllowsRequests, true)
  // An invalid time zone must never reach the Mac (it would reject all the preferences): no quiet hours.
  assert.equal(toWirePrefs(quiet, 'Not/AZone').quiet, null)
})
