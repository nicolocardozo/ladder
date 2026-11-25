// Browser for the agent, main side: runs on the agent's views the operations requested by the host.
// The view is a user Browser tab (main/browser.ts) with an isolated, in-memory partition; here the page is read,
// clicked, typed into and captured. Scripts run in an isolated world: the page cannot see or alter them.
// The result sent to the host is always a plain data object (strings, numbers): page content never becomes a command.
import { BrowserWindow } from 'electron'
import { t } from '@shared/i18n'
import { parseAgentUrl, normalizeHost } from '@shared/agent-browser'
import type { AgentPageElement, BrowserAgentOp, BrowserAgentResult } from '@shared/protocol'
import { agentAllows, createAgentTab, destroyTab, encodeShot, keyOf, tabs, type Tab } from './browser'

const AGENT_WORLD = 998
const SCRIPT_TIMEOUT_MS = 5_000
/** A hidden view may answer "surface not ready" on the first capture: a single second attempt, after this wait. */
const CAPTURE_RETRY_MS = 150
/** Per capture: two attempts + wait stay under the 15 s after which the host closes the operation. */
const CAPTURE_TIMEOUT_MS = 6_000
const PRIME_TIMEOUT_MS = 5_000
const NAVIGATE_TIMEOUT_MS = 24_000
const SHOT_MAX_WIDTH = 1280
const SHOT_MIN_WIDTH = 480
const TEXT_MAX = 100_000
const REF = /^e\d{1,6}$/

/** Operations in progress per session: stop closes them immediately. */
const running = new Map<string, Set<() => void>>()

const fail = (code: Extract<BrowserAgentResult, { ok: false }>['code'], error: string, host?: string): BrowserAgentResult => ({ ok: false, code, error, ...(host ? { host } : {}) })
const stoppedResult = (): BrowserAgentResult => fail('stopped', t('The user stopped the agent browser.'))

function tabOf(sessionId: string): Tab | null {
  for (const tab of tabs.values()) if (tab.agent?.sessionId === sessionId) return tab
  return null
}

/** Window that hosts the view: the active one, otherwise the first one open. */
function pickWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
}

/** Runs `task` until it expires or stop closes it. */
function guarded<T>(sessionId: string, ms: number, task: Promise<T>, onTimeout: T, onStop: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const cancels = running.get(sessionId) ?? new Set<() => void>()
    running.set(sessionId, cancels)
    const cancel = (): void => finish(onStop)
    const timer = setTimeout(() => finish(onTimeout), ms)
    const finish = (value: T): void => {
      clearTimeout(timer)
      cancels.delete(cancel)
      resolve(value)
    }
    cancels.add(cancel)
    task.then(finish, () => finish(onTimeout))
  })
}

/** Script in the isolated world: JSON string or null if the page does not respond. */
async function script(tab: Tab, code: string): Promise<unknown> {
  const run = tab.view.webContents.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code }])
  return guarded<unknown>(tab.agent!.sessionId, SCRIPT_TIMEOUT_MS, run, null, null)
}

const parse = (raw: unknown): Record<string, unknown> | null => {
  if (typeof raw !== 'string') return null
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// ── Page scripts ──────────────────────────────────────────────────────────

const readScript = (maxChars: number, maxElements: number): string => `(() => {
  const S = (window.__ladderAgent ??= { n: 0, ids: new WeakMap(), els: new Map() });
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; };
  const nameOf = (el) => ((el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.value || el.placeholder || el.title || el.alt || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=textbox],[contenteditable=""],[contenteditable="true"]';
  const elements = [];
  for (const el of document.querySelectorAll(sel)) {
    if (elements.length >= ${maxElements}) break;
    if (!visible(el)) continue;
    let id = S.ids.get(el);
    if (!id) { id = 'e' + (++S.n); S.ids.set(el, id); S.els.set(id, new WeakRef(el)); }
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type') || undefined;
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' || tag === 'summary' ? 'button' : tag === 'select' ? 'combobox' : tag === 'input' && (type === 'checkbox' || type === 'radio') ? type : 'textbox');
    const item = { ref: id, role, name: nameOf(el) };
    if (tag === 'input' || tag === 'textarea' || tag === 'select') { if (type) item.type = type; if (type !== 'password' && type !== 'file') item.value = String(el.value || '').slice(0, 120); }
    if (tag === 'a') item.href = String(el.href || '').slice(0, 200);
    if (el.disabled === true) item.disabled = true;
    if (type === 'checkbox' || type === 'radio') item.checked = !!el.checked;
    elements.push(item);
  }
  const full = document.body ? document.body.innerText : '';
  return JSON.stringify({ url: location.href, title: document.title, text: full.slice(0, ${maxChars}), truncated: full.length > ${maxChars}, elements });
})()`

const findElement = `const S = window.__ladderAgent; const el = S && S.els.get(REF) && S.els.get(REF).deref(); if (!el || !el.isConnected) return JSON.stringify({ ok: false, why: 'stale' });`

const clickScript = (ref: string): string => `(() => { const REF = ${JSON.stringify(ref)}; ${findElement}
  if (el.disabled === true) return JSON.stringify({ ok: false, why: 'disabled' });
  el.scrollIntoView({ block: 'center', inline: 'center' }); el.click(); return JSON.stringify({ ok: true }); })()`

const typeScript = (ref: string, text: string): string => `(() => { const REF = ${JSON.stringify(ref)}; const TEXT = ${JSON.stringify(text)}; ${findElement}
  if (el instanceof HTMLInputElement && (el.type === 'password' || el.type === 'file')) return JSON.stringify({ ok: false, why: 'password' });
  el.scrollIntoView({ block: 'center', inline: 'center' }); el.focus();
  if (el instanceof HTMLSelectElement) { const opt = [...el.options].find((o) => o.value === TEXT || o.label === TEXT || o.text.trim() === TEXT); if (!opt) return JSON.stringify({ ok: false, why: 'option' }); el.value = opt.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return JSON.stringify({ ok: true }); }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; set.call(el, TEXT); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return JSON.stringify({ ok: true }); }
  if (el.isContentEditable) { if (document.activeElement !== el) return JSON.stringify({ ok: false, why: 'not-editable' }); const range = document.createRange(); range.selectNodeContents(el); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); return JSON.stringify({ ok: document.execCommand('insertText', false, TEXT) }); }
  return JSON.stringify({ ok: false, why: 'not-editable' }); })()`

// ── Operations ────────────────────────────────────────────────────────────

async function navigate(tab: Tab, url: string): Promise<BrowserAgentResult> {
  const agent = tab.agent!
  const parsed = parseAgentUrl(url)
  if (!parsed.ok) return fail('failed', t('Only http and https addresses can be opened here.'))
  // Main re-checks on its own: even if the host got it wrong, an unauthorized domain is not opened.
  if (!agentAllows(agent, parsed.url.toString())) return fail('blocked', t('{host} is not allowed in the agent browser.', { host: parsed.host }), parsed.host)
  agent.blocked = null
  const contents = tab.view.webContents
  // First navigate to about:blank: a hidden view that loads the real page right away never gets the surface for capturePage (tested on Electron 45).
  if (!agent.primed) {
    agent.primed = true
    const priming = contents.loadURL('about:blank').then(
      () => 'ok' as const,
      () => 'ok' as const
    )
    // Preparation is also stopped by stop; on return everything is re-checked, because stop or a level change may have arrived in the meantime.
    const primed = await guarded<string>(agent.sessionId, PRIME_TIMEOUT_MS, priming, 'timeout', 'stopped')
    if (primed === 'stopped' || agent.stopped) return stoppedResult()
    if (contents.isDestroyed()) return fail('closed', t('The agent browser is closed.'))
    if (!agentAllows(agent, parsed.url.toString())) return fail('blocked', t('{host} is not allowed in the agent browser.', { host: parsed.host }), parsed.host)
  }
  const loaded = contents.loadURL(parsed.url.toString()).then(
    () => 'ok' as const,
    (error: Error) => error.message
  )
  const outcome = await guarded<string>(agent.sessionId, NAVIGATE_TIMEOUT_MS, loaded, 'timeout', 'stopped')
  if (outcome === 'stopped') return stoppedResult()
  if (outcome === 'timeout') {
    contents.stop()
    return fail('timeout', t('The page took too long to load.'))
  }
  // A redirect (or a main subresource) outside the allowed domains was stopped: the agent must ask the user.
  if (outcome !== 'ok' && agent.blocked) return fail('blocked', t('The page tried to go to {host}, which is not allowed in the agent browser. Ask the user before opening it.', { host: agent.blocked }), agent.blocked)
  if (outcome !== 'ok') return fail('failed', t('The page did not load: {reason}', { reason: outcome.replace(/^ERR_/, '').slice(0, 120) }))
  return { ok: true, url: contents.getURL(), title: contents.getTitle() }
}

async function read(tab: Tab, maxChars: number, maxElements: number): Promise<BrowserAgentResult> {
  const chars = Math.min(Math.max(1, Math.floor(maxChars)), TEXT_MAX)
  const els = Math.min(Math.max(1, Math.floor(maxElements)), 300)
  const current = tab.view.webContents.getURL()
  if (!current || current === 'about:blank') return fail('failed', t('The agent browser has no page yet. Open one with browser_navigate.'))
  const data = parse(await script(tab, readScript(chars, els)))
  if (!data) return fail('timeout', t('The page did not answer.'))
  const elements: AgentPageElement[] = Array.isArray(data.elements)
    ? (data.elements as Record<string, unknown>[]).slice(0, els).map((e) => ({
        ref: String(e.ref ?? ''),
        role: String(e.role ?? ''),
        name: String(e.name ?? '').slice(0, 120),
        ...(typeof e.type === 'string' ? { type: e.type.slice(0, 30) } : {}),
        ...(typeof e.value === 'string' ? { value: e.value.slice(0, 120) } : {}),
        ...(typeof e.href === 'string' ? { href: e.href.slice(0, 200) } : {}),
        ...(e.disabled === true ? { disabled: true } : {}),
        ...(typeof e.checked === 'boolean' ? { checked: e.checked } : {})
      }))
    : []
  return { ok: true, url: String(data.url ?? '').slice(0, 500), title: String(data.title ?? '').slice(0, 300), text: String(data.text ?? '').slice(0, chars), truncated: data.truncated === true, elements }
}

/** Pixels sampled on a thumbnail: all equal and transparent or white = an image that looks valid but is empty. */
function looksBlank(image: Electron.NativeImage): boolean {
  const small = image.resize({ width: 32, height: 32, quality: 'good' })
  const px = small.toBitmap()
  if (px.length < 4) return true
  const [b, g, r, a] = [px[0], px[1], px[2], px[3]]
  if (a !== 0 && !(r > 250 && g > 250 && b > 250)) return false
  for (let i = 4; i + 3 < px.length; i += 4) if (Math.abs(px[i] - b) > 2 || Math.abs(px[i + 1] - g) > 2 || Math.abs(px[i + 2] - r) > 2 || Math.abs(px[i + 3] - a) > 2) return false
  return true
}

/** Captures the view, even if hidden; if the first capture fails, is empty or uniform, invalidates and retries once after CAPTURE_RETRY_MS (unless stop occurred). */
async function capture(tab: Tab): Promise<Electron.NativeImage | null> {
  const contents = tab.view.webContents
  const once = (): Promise<Electron.NativeImage | null> =>
    guarded<Electron.NativeImage | null>(tab.agent!.sessionId, CAPTURE_TIMEOUT_MS, contents.capturePage(undefined, { stayHidden: !tab.visible }), null, null)
  const first = await once()
  if (first && !first.isEmpty() && !looksBlank(first)) return first
  if (contents.isDestroyed() || tab.agent!.stopped) return first
  contents.invalidate()
  await new Promise((resolve) => setTimeout(resolve, CAPTURE_RETRY_MS))
  if (contents.isDestroyed() || tab.agent!.stopped) return first
  // If the second capture also fails, keep the first (uniform but valid) rather than nothing.
  const second = await once()
  return second && !second.isEmpty() ? second : first
}

async function screenshot(tab: Tab): Promise<BrowserAgentResult> {
  const image = await capture(tab)
  if (tab.agent!.stopped) return stoppedResult()
  if (!image) return fail('timeout', t('The screenshot did not complete. Open the agent browser tab so it is visible, then try again.'))
  if (image.isEmpty()) return fail('failed', t('The screenshot is empty. Open the agent browser tab so it is visible, then try again.'))
  const shot = encodeShot(image, SHOT_MAX_WIDTH, SHOT_MIN_WIDTH)
  if (!shot) return fail('failed', t('Could not shrink the screenshot under 5 MB.'))
  // Uniform after the retry: the page may really be white or not yet painted; the image is returned with a note.
  const blank = looksBlank(image)
  return { ok: true, image: { mediaType: shot.mediaType, data: shot.data.toString('base64') }, ...(blank ? { note: t('The screenshot is a single flat colour. The page may be blank or still loading.') } : {}) }
}

async function interact(tab: Tab, code: string): Promise<BrowserAgentResult> {
  const data = parse(await script(tab, code))
  if (!data) return fail('timeout', t('The page did not answer.'))
  if (data.ok === true) return { ok: true }
  switch (data.why) {
    case 'stale':
      return fail('stale-ref', t('That reference is out of date. Read the page again with browser_read_page.'))
    case 'disabled':
      return fail('failed', t('That element is disabled.'))
    case 'password':
      return fail('failed', t('Password fields are not filled by the agent. Ask the user to type it.'))
    case 'option':
      return fail('failed', t('That option does not exist in the list.'))
    default:
      return fail('failed', t('That element cannot take text.'))
  }
}

/** An operation from the host. `result` is always plain data. */
export async function runAgentOp(op: BrowserAgentOp): Promise<BrowserAgentResult> {
  if (!op || typeof op !== 'object' || typeof op.sessionId !== 'string' || !op.sessionId) return fail('failed', t('The browser did not understand the request.'))
  const existing = tabOf(op.sessionId)
  switch (op.op) {
    case 'open': {
      if (typeof op.projectId !== 'string' || !op.projectId) return fail('failed', t('The browser did not understand the request.'))
      if (existing?.agent?.stopped) return stoppedResult()
      if (existing) return { ok: true, tabId: existing.state.tabId }
      const window = pickWindow()
      if (!window) return fail('failed', t('No Ladder window is open.'))
      return { ok: true, tabId: createAgentTab(window, op.sessionId, op.projectId).state.tabId }
    }
    case 'close':
      if (existing) destroyTab(keyOf(existing.window, existing.state.tabId))
      running.delete(op.sessionId)
      return { ok: true }
    case 'stop': {
      if (!existing?.agent) return { ok: true }
      if (op.freeze !== false) {
        existing.agent.stopped = true
        // User stop: authorizations given so far do not survive (the host also resets them).
        existing.agent.hosts.clear()
        existing.agent.any = false
      }
      // Stops loading and running scripts; the rest is rejected by the `stopped` check below.
      for (const cancel of [...(running.get(op.sessionId) ?? [])]) cancel()
      if (!existing.view.webContents.isDestroyed()) existing.view.webContents.stop()
      return { ok: true }
    }
    case 'resume':
      if (existing?.agent) existing.agent.stopped = false
      return { ok: true }
  }
  if (!existing?.agent) return fail('closed', t('The agent browser is closed.'))
  if (existing.agent.stopped) return stoppedResult()
  if (existing.view.webContents.isDestroyed()) return fail('closed', t('The agent browser is closed.'))
  switch (op.op) {
    case 'allow':
      // `host: null` starts over: clears the domains and sets `any` (true only for Full access, false otherwise); with a domain, adds it.
      if (op.host === null) {
        existing.agent.hosts.clear()
        existing.agent.any = op.any === true
      } else if (typeof op.host === 'string' && op.host) existing.agent.hosts.add(normalizeHost(op.host))
      return { ok: true }
    case 'navigate':
      return typeof op.url === 'string' ? navigate(existing, op.url) : fail('failed', t('Enter a valid address.'))
    case 'read':
      return read(existing, Number(op.maxChars), Number(op.maxElements))
    case 'screenshot':
      return screenshot(existing)
    case 'click':
      return typeof op.ref === 'string' && REF.test(op.ref) ? interact(existing, clickScript(op.ref)) : fail('stale-ref', t('That reference is out of date. Read the page again with browser_read_page.'))
    case 'type':
      return typeof op.ref === 'string' && REF.test(op.ref) && typeof op.text === 'string' && op.text.length <= 2000 ? interact(existing, typeScript(op.ref, op.text)) : fail('failed', t('The browser did not understand the request.'))
    case 'console': {
      const limit = Math.min(Math.max(1, Math.floor(Number(op.limit) || 50)), 200)
      return { ok: true, messages: existing.agent.console.slice(-limit).map((m) => ({ level: m.level, text: m.text.slice(0, 500) })) }
    }
    default:
      return fail('failed', t('The browser did not understand the request.'))
  }
}
