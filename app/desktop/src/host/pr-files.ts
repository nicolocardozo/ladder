// File temporanei con titolo e descrizione della PR (LAD-59): l'agente riceve solo i percorsi e legge i dati da lì,
// così nessun carattere del titolo o del corpo passa per una riga di comando né per un delimitatore di heredoc.
// Cartella privata (0700) con nome casuale, file 0600; si cancella alla chiusura della sessione, a una nuova
// preparazione e all'uscita dell'app. Quelle rimaste da un'uscita brusca si tolgono alla prima preparazione.
import { randomBytes } from 'node:crypto'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { t } from '@shared/i18n'
import { MAX_PR_BODY, MAX_PR_TITLE } from '@shared/protocol'

const PREFIX = 'ladder-pr-'
/** Cartelle di un'esecuzione precedente: dopo un giorno non servono a nessuno. */
const STALE_MS = 24 * 60 * 60_000

/** Titolo (una riga, senza NUL, entro il limite) e descrizione (senza NUL, entro il limite); errore tradotto altrimenti. */
export function checkPrText(title: string, body: string): void {
  if (typeof title !== 'string' || typeof body !== 'string') throw new Error(t('The pull request text is not valid.'))
  if (!title.trim()) throw new Error(t('The pull request needs a title.'))
  if (/[\r\n]/.test(title)) throw new Error(t('The pull request title must be a single line.'))
  if (title.includes('\0') || body.includes('\0')) throw new Error(t('The pull request text contains invalid characters.'))
  if (title.length > MAX_PR_TITLE) throw new Error(t('The pull request title is too long ({max} characters at most).', { max: String(MAX_PR_TITLE) }))
  if (body.length > MAX_PR_BODY) throw new Error(t('The pull request description is too long ({max} characters at most).', { max: String(MAX_PR_BODY) }))
}

export class PrFiles {
  private dirs = new Map<string, string>()
  private swept = false

  /** Scrive titolo e descrizione per la sessione (e toglie i file della preparazione precedente). */
  async prepare(sessionId: string, title: string, body: string): Promise<{ titlePath: string; bodyPath: string }> {
    checkPrText(title, body)
    this.sweep()
    await this.forget(sessionId)
    // mkdtemp crea la cartella con permessi 0700 e un suffisso casuale; anche i file hanno un nome casuale.
    const dir = await mkdtemp(join(tmpdir(), PREFIX))
    try {
      const titlePath = join(dir, `title-${randomBytes(6).toString('hex')}.txt`)
      const bodyPath = join(dir, `body-${randomBytes(6).toString('hex')}.md`)
      // Contenuto identico a ciò che l'utente ha scritto: niente a capo aggiunto. 'wx': mai su un file già esistente.
      await writeFile(titlePath, title.trim(), { mode: 0o600, flag: 'wx' })
      await writeFile(bodyPath, body, { mode: 0o600, flag: 'wx' })
      this.dirs.set(sessionId, dir)
      return { titlePath, bodyPath }
    } catch (error) {
      await rm(dir, { recursive: true, force: true })
      throw error
    }
  }

  /** Cancella i file della sessione (chiusa, archiviata o con una nuova preparazione). */
  async forget(sessionId: string): Promise<void> {
    const dir = this.dirs.get(sessionId)
    if (!dir) return
    this.dirs.delete(sessionId)
    await rm(dir, { recursive: true, force: true })
  }

  /** All'uscita dell'app: tutto via, in modo sincrono. */
  shutdown(): void {
    for (const dir of this.dirs.values()) rmSync(dir, { recursive: true, force: true })
    this.dirs.clear()
  }

  /** Una volta per esecuzione: toglie le cartelle `ladder-pr-*` vecchie lasciate da un'uscita senza pulizia. */
  private sweep(): void {
    if (this.swept) return
    this.swept = true
    try {
      for (const name of readdirSync(tmpdir())) {
        if (!name.startsWith(PREFIX)) continue
        const path = join(tmpdir(), name)
        if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true })
      }
    } catch {
      // Un elenco che non si legge non deve impedire la PR.
    }
  }
}
