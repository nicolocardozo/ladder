// "Aggiungi alla chat" dal browser integrato: screenshot e testo selezionato vanno al composer della chat di destinazione
// (vedi `chatTargetFor`: colonna attiva, ultima chat guardata o nuova chat). Il composer non è montato mentre si guarda il
// browser, quindi si scrive nello stato che legge al montaggio: la bozza per il testo, la coda delle immagini per gli screenshot.
import { t } from '@shared/i18n'
import { send } from '@/lib/host-client'
import { chatTargetFor, useApp } from '@/store/app-store'

/** Esito: `title` è la chat che ha ricevuto il contenuto (null = la nuova chat), `sessionId` per aprirla. */
export type ToChat = { ok: true; title: string | null; sessionId: string | null } | { ok: false; error: string }

function target(projectId: string) {
  const state = useApp.getState()
  const chat = chatTargetFor(state, projectId)
  return { ...chat, title: chat.sessionId ? (state.sessions[chat.sessionId]?.title ?? null) : null }
}

export async function screenshotToChat(projectId: string, tabId: string): Promise<ToChat> {
  const browser = window.ladder?.browser
  if (!browser) return { ok: false, error: t('The browser is only available in the Ladder app.') }
  // La cattura funziona solo a vista visibile: si fa prima di qualunque altra cosa.
  const shot = await browser.screenshot(tabId).catch(() => null)
  if (!shot) return { ok: false, error: t('Couldn’t capture the page. Load a page first.') }
  const to = target(projectId)
  useApp.getState().queueComposerAttachment(to.key, shot)
  return { ok: true, title: to.title, sessionId: to.sessionId }
}

/** Testo selezionato come citazione ("> ...") in fondo alla bozza, separata da una riga vuota. */
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
