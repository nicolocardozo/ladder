import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_NOTIFY_PREFS, crossesMidnight, dateToTime, isTime, isTimeZone, minutesToTime, normalizeNotifyPrefs, timeToDate, timeToMinutes, toWirePrefs } from './notify-prefs.ts'

test('orari: validazione HH:MM a 24 ore', () => {
  for (const ok of ['00:00', '07:05', '23:59']) assert.equal(isTime(ok), true, ok)
  for (const bad of ['24:00', '7:05', '07:60', '07:5', '', 7, null, '07:05:00']) assert.equal(isTime(bad), false, String(bad))
})

test('orari: minuti da e verso HH:MM, anche fuori giro', () => {
  assert.equal(timeToMinutes('22:30'), 1350)
  assert.equal(minutesToTime(1350), '22:30')
  assert.equal(minutesToTime(1440), '00:00')
  assert.equal(minutesToTime(-30), '23:30')
  assert.equal(timeToMinutes('boh'), 0)
})

test('selettore: la data porta l\'ora locale e torna uguale', () => {
  const d = timeToDate('07:45', new Date(2026, 10, 24, 15, 0, 0))
  assert.equal(d.getHours(), 7)
  assert.equal(d.getMinutes(), 45)
  assert.equal(d.getDate(), 24)
  assert.equal(dateToTime(d), '07:45')
  assert.equal(dateToTime(new Date(2026, 0, 1, 0, 5)), '00:05')
})

test('fascia a cavallo della mezzanotte', () => {
  assert.equal(crossesMidnight('22:00', '07:00'), true)
  assert.equal(crossesMidnight('13:00', '15:00'), false)
  assert.equal(crossesMidnight('08:00', '08:00'), false)
})

test('fusi orari', () => {
  assert.equal(isTimeZone('Europe/Rome'), true)
  assert.equal(isTimeZone('Not/AZone'), false)
  assert.equal(isTimeZone(''), false)
  assert.equal(isTimeZone('A'.repeat(65)), false)
  assert.equal(isTimeZone(5), false)
})

test('normalizzazione: dati rovinati tornano ai predefiniti, il resto si conserva', () => {
  assert.deepEqual(normalizeNotifyPrefs(undefined), DEFAULT_NOTIFY_PREFS)
  assert.deepEqual(normalizeNotifyPrefs('x'), DEFAULT_NOTIFY_PREFS)
  const p = normalizeNotifyPrefs({ events: { request: false, turn: 'sì', error: true }, quiet: { enabled: true, from: '25:00', to: '06:30' }, quietAllowsRequests: 1 })
  assert.deepEqual(p.events, { request: false, turn: true, error: true, agents: true })
  assert.deepEqual(p.quiet, { enabled: true, from: '22:00', to: '06:30' })
  assert.equal(p.quietAllowsRequests, false)
})

test('verso il Mac: fascia solo se accesa, nel fuso dato', () => {
  const prefs = { ...DEFAULT_NOTIFY_PREFS, events: { ...DEFAULT_NOTIFY_PREFS.events, turn: false } }
  assert.deepEqual(toWirePrefs(prefs, 'Europe/Rome'), { events: { request: true, turn: false, error: true, agents: true }, quiet: null, quietAllowsRequests: false })
  const quiet = { ...prefs, quiet: { enabled: true, from: '23:00', to: '06:45' }, quietAllowsRequests: true }
  assert.deepEqual(toWirePrefs(quiet, 'Europe/Rome').quiet, { from: '23:00', to: '06:45', tz: 'Europe/Rome' })
  assert.equal(toWirePrefs(quiet, 'Europe/Rome').quietAllowsRequests, true)
  // Un fuso non valido non deve mai arrivare al Mac (rifiuterebbe tutte le preferenze): niente fascia.
  assert.equal(toWirePrefs(quiet, 'Not/AZone').quiet, null)
})
