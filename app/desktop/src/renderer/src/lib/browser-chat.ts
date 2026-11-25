// "Add to chat" from the built-in browser: screenshots and selected text go to the composer of the target chat
// (see `chatTargetFor`: active column, last chat viewed or new chat). The composer is not mounted while the
// browser is in view, so we write into the state it reads on mount: the draft for text, the image queue for screenshots.
import { t } from '@shared/i18n'
import { send } from '@/lib/host-client'
import { chatTargetFor, useApp } from '@/store/app-store'

/** Outcome: `title` is the chat that received the content (null = the new chat), `sessionId` to open it. */
export type ToChat = { ok: true; title: string | null; sessionId: string | null } | { ok: false; error: string }

function target(projectId: string) {
  const state = useApp.getState()
  const chat = chatTargetFor(state, projectId)
  return { ...chat, title: chat.sessionId ? (state.sessions[chat.sessionId]?.title ?? null) : null }
}

export async function screenshotToChat(projectId: string, tabId: string): Promise<ToChat> {
  const browser = window.ladder?.browser
  if (!browser) return { ok: false, error: t('The browser is only available in the Ladder app.') }
  // Capture works only while the view is visible: it is done before anything else.
  const shot = await browser.screenshot(tabId).catch(() => null)
  if (!shot) return { ok: false, error: t('Couldn’t capture the page. Load a page first.') }
  const to = target(projectId)
  useApp.getState().queueComposerAttachment(to.key, shot)
  return { ok: true, title: to.title, sessionId: to.sessionId }
}

/** Selected text as a quote ("> ...") at the end of the draft, separated by a blank line. */
export async function selectionToChat(projectId: string, tabId: string): Promise<ToChat> {
  const browser = window.ladder?.browser
  if (!browser) return { ok: false, error: t('The browser is only available in the Ladder app.') }
  const text = (await browser.selection(tabId).catch(() => '')).trim()
  if (!text) return { ok: false, error: t('Select some text on the page first.') }
  const to = target(projectId)
  const quote = text
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line.trimEnd()}` : '>'))
    .join('\n')
  const draft = (useApp.getState().drafts[to.key] ?? '').replace(/\s+$/, '')
  const next = `${draft ? `${draft}\n\n` : ''}${quote}\n\n`
  useApp.getState().setDraft(to.key, next)
  send({ type: 'draft.set', key: to.key, text: next })
  return { ok: true, title: to.title, sessionId: to.sessionId }
}
