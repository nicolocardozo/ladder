// Download di strumenti esterni (gh, Codex) nella cartella dati di Ladder: HTTPS, checksum SHA-256 e archivio estratto qui.
import { createHash, X509Certificate } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { t } from '@shared/i18n'
import type { AgentBlockCode, AgentSignature } from '@shared/protocol'
import { cleanEnv } from './agents/common'

const run = promisify(execFile)

/**
 * Ambiente dei processi che trattano dati non fidati (bsdtar, gzip, bzip2, xattr, codesign): PATH fisso ai soli binari di sistema, perché
 * bsdtar avvia come filtri esterni i programmi che trova nel PATH (zstd, lz4, lzop…) e un archivio può chiederli. Locale UTF-8, così
 * i nomi non ASCII si elencano e si estraggono come sono (nel locale C bsdtar li stampa come `\303\251` e non li converte).
 */
const untrustedEnv = () => ({ ...cleanEnv(), PATH: '/usr/bin:/bin', LC_ALL: 'en_US.UTF-8' })
const tarEnv = untrustedEnv

/** Errore con un codice stabile per la UI (AgentBlockCode): i blocchi di sicurezza dell'installazione. */
export class BlockError extends Error {
  constructor(
    readonly code: AgentBlockCode,
    message: string
  ) {
    super(message)
  }
}

/** Limiti dei download: l'archivio (anche se il server non dà Content-Length, si conta mentre arriva), il contenuto estratto e il numero di voci. */
export const MAX_ARCHIVE_BYTES = 600 * 1024 * 1024
export const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_ENTRIES = 50_000
const tooLarge = () => new BlockError('too-large', t('The download is larger than Ladder allows.'))

/** Cartella dati di Ladder (la stessa del database). */
export function dataDir(): string {
  const db = process.env.LADDER_DB_PATH
  return db ? dirname(db) : join(process.env.HOME ?? '/tmp', '.ladder')
}

/** Gli strumenti scaricati stanno in `bin/<nome>`. */
export function toolDir(name: string): string {
  return join(dataDir(), 'bin', name)
}

export interface ReleaseAsset {
  url: string
  /** SHA-256 in esadecimale, dall'API di GitHub (campo `digest`) o dal file dei checksum. */
  sha256: string
  size: number
}

interface GithubRelease {
  tag_name: string
  assets: { name: string; size: number; browser_download_url: string; digest?: string | null }[]
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Ladder' }, signal })
  if (!response.ok) throw Object.assign(new Error(t('Download failed: the server responded {status}.', { status: response.status })), { status: response.status })
  return (await response.json()) as T
}

/**
 * Ultima release di un repository GitHub e il suo asset. Il checksum viene dal `digest` dell'asset; se manca,
 * da `checksums` (nome del file con "sha256  nome" per riga).
 */
export async function latestAsset(repo: string, pick: (tag: string) => string, signal: AbortSignal, checksums?: (tag: string) => string): Promise<ReleaseAsset & { tag: string }> {
  const release = await getJson<GithubRelease>(`https://api.github.com/repos/${repo}/releases/latest`, signal)
  const name = pick(release.tag_name)
  const asset = release.assets.find((a) => a.name === name)
  if (!asset) throw new Error(t('No download available for this Mac ({name}).', { name }))
  let sha = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '')?.[1]
  if (!sha && checksums) {
    const file = release.assets.find((a) => a.name === checksums(release.tag_name))
    if (file) {
      // Stessa fonte (la release GitHub), ma con i controlli sui redirect e sull'esito: una pagina d'errore non è un file di checksum.
      const { response } = await fetchChecked(file.browser_download_url, { headers: { 'User-Agent': 'Ladder' } }, signal)
      if (!response.ok) throw new Error(t('Download failed: the server responded {status}.', { status: response.status }))
      const text = await response.text()
      if (text.length > 1024 * 1024) throw new Error(t('Can’t verify the download: no checksum published.'))
      const line = text.split('\n').find((l) => l.trim().endsWith(` ${name}`) || l.trim().endsWith(`*${name}`))
      sha = line?.trim().split(/\s+/)[0]
    }
  }
  if (!sha || !/^[0-9a-f]{64}$/i.test(sha)) throw new Error(t('Can’t verify the download: no checksum published.'))
  return { tag: release.tag_name, url: asset.browser_download_url, sha256: sha.toLowerCase(), size: asset.size }
}

/** Host su cui può finire un download dopo i redirect, oltre a quello dell'URL: le release GitHub passano da queste CDN. */
const DOWNLOAD_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']

/** Un salto di redirect è accettabile solo su https, senza credenziali, sulla porta standard e sull'host di partenza (o, per GitHub, le sue CDN). */
function hopAllowed(origin: URL, next: URL): boolean {
  if (next.protocol !== 'https:' || next.username || next.password || (next.port && next.port !== '443')) return false
  return next.host === origin.host || (origin.host === 'github.com' && DOWNLOAD_HOSTS.includes(next.host))
}

/** fetch che segue i redirect uno a uno (al massimo 5) e controlla ogni indirizzo, non solo l'ultimo. Restituisce anche l'URL finale. */
export async function fetchChecked(url: string, init: RequestInit, signal: AbortSignal): Promise<{ response: Response; url: URL }> {
  const origin = new URL(url)
  if (!hopAllowed(origin, origin)) throw new BlockError('host', t('The download was redirected to an unexpected address.'))
  let current = origin
  for (let hop = 0; hop <= 5; hop++) {
    const response = await fetch(current, { ...init, redirect: 'manual', signal })
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => undefined)
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        throw new BlockError('host', t('The download was redirected to an unexpected address.'))
      }
      if (!hopAllowed(origin, next)) throw new BlockError('host', t('The download was redirected to an unexpected address.'))
      current = next
      continue
    }
    return { response, url: current }
  }
  throw new BlockError('host', t('The download was redirected to an unexpected address.'))
}

/** Dimensione dell'archivio senza scaricarlo (HEAD e Content-Length, 6 secondi): null se ignota o se qualcosa non va. */
export async function remoteSize(url: string): Promise<number | null> {
  try {
    const { response } = await fetchChecked(url, { method: 'HEAD', headers: { 'User-Agent': 'Ladder' } }, AbortSignal.timeout(6000))
    if (!response.ok) return null
    const size = Number(response.headers.get('content-length'))
    return Number.isFinite(size) && size > 0 ? size : null
  } catch {
    return null
  }
}

/**
 * Scarica in `dest` con avanzamento e verifica lo SHA-256; se non corrisponde cancella il file. Oltre `maxBytes` si
 * ferma (anche senza Content-Length: si conta mentre arriva). Gli indirizzi dei redirect si controllano uno a uno.
 */
export async function downloadVerified(asset: ReleaseAsset, dest: string, signal: AbortSignal, onProgress: (bytes: number, total: number | null) => void, maxBytes = MAX_ARCHIVE_BYTES): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  const { response } = await fetchChecked(asset.url, { headers: { 'User-Agent': 'Ladder' } }, signal)
  if (!response.ok || !response.body) throw new Error(t('Download failed: the server responded {status}.', { status: response.status }))
  const declared = Number(response.headers.get('content-length')) || 0
  if (declared > maxBytes || asset.size > maxBytes) {
    await response.body.cancel().catch(() => undefined)
    throw tooLarge()
  }
  const total = declared || asset.size || null
  const hash = createHash('sha256')
  let bytes = 0
  let last = 0
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length
      if (bytes > maxBytes) return done(tooLarge())
      hash.update(chunk)
      // L'avanzamento arriva alla UI al massimo 5 volte al secondo.
      if (Date.now() - last > 200) {
        last = Date.now()
        onProgress(bytes, total)
      }
      done(null, chunk)
    }
  })
  try {
    await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(dest), { signal })
  } catch (error) {
    await rm(dest, { force: true })
    throw error
  }
  onProgress(bytes, total)
  if (hash.digest('hex') !== asset.sha256) {
    await rm(dest, { force: true })
    throw new Error(t('The download is corrupted (checksum mismatch). Try again.'))
  }
}

/**
 * Estrae l'archivio (zip o tar.gz) in una cartella vuota di lavoro e sposta in `target` il primo file eseguibile
 * che `match` riconosce. La cartella finale si sostituisce solo a estrazione riuscita.
 */
export async function extractBinary(archive: string, target: string, match: (relativePath: string) => boolean): Promise<void> {
  const work = `${target}.extract`
  await rm(work, { recursive: true, force: true })
  try {
    // Stessi controlli degli agenti ACP (percorsi, link, formato): poi si sposta solo l'eseguibile.
    await extractArchive(archive, work, basename(target))
    const found = await findFile(work, '', match)
    if (!found) throw new Error(t('The downloaded archive does not contain the expected program.'))
    await mkdir(dirname(target), { recursive: true })
    await rm(target, { force: true })
    await rename(join(work, found), target)
    await chmod(target, 0o755)
  } finally {
    // Cartella di lavoro e archivio si tolgono sempre, anche se l'eseguibile non c'è.
    await rm(work, { recursive: true, force: true })
    await rm(archive, { force: true })
  }
}

async function findFile(root: string, rel: string, match: (relativePath: string) => boolean): Promise<string | null> {
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    const path = join(rel, entry.name)
    if (entry.isDirectory()) {
      const inner = await findFile(root, path, match)
      if (inner) return inner
    } else if (entry.isFile() && match(path)) return path
  }
  return null
}

// ── Binari degli agenti ACP (LAD-56) ─────────────────────────────────────────

/**
 * Checksum di un archivio ospitato su una release GitHub (`github.com/<utente>/<repo>/releases/download/<tag>/<file>`):
 * il campo `digest` dell'asset di quella release. null se l'URL non è di una release o la release non lo pubblica.
 */
export async function githubReleaseDigest(url: string, signal: AbortSignal): Promise<{ sha256: string; size: number | null } | null> {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\/download\/([^/?#]+)\/([^/?#]+)$/.exec(url)
  if (!match) return null
  const [, owner, repo, tag, file] = match
  if (/^\.+$/.test(owner) || /^\.+$/.test(repo)) return null
  let name: string
  let tagName: string
  try {
    name = decodeURIComponent(file)
    tagName = decodeURIComponent(tag)
  } catch {
    return null
  }
  // Tag sparito (404): la release non esiste più, quindi nessun checksum pubblicato (diverso da "non leggibile ora").
  const release = await getJson<GithubRelease>(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tagName)}`, signal).catch((error: { status?: number }) => {
    if (error.status === 404) return null
    throw error
  })
  if (!release) return null
  const asset = (release.assets ?? []).find((a) => a.name === name)
  const sha = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest ?? '')?.[1]
  return sha ? { sha256: sha.toLowerCase(), size: asset?.size ?? null } : null
}

/** Percorso relativo del programma nell'archivio: niente percorsi assoluti, niente `..`, niente caratteri strani. */
export function safeRelativePath(cmd: string): string | null {
  if (!cmd || cmd.length > 512 || isAbsolute(cmd) || /[\0\n\r]/.test(cmd)) return null
  const clean = normalize(cmd)
  if (clean === '.' || clean.split(sep).includes('..')) return null
  return clean
}

const MACHO = new Set(['cffaedfe', 'cefaedfe', 'cafebabe', 'cafebabf', 'feedface', 'feedfacf'])

/** Inizio dei formati che bsdtar riconosce da sé e tratta come filtro (programma esterno) o come altro archivio: un tar il cui primo nome inizia così non si accetta. */
const FILTER_MAGICS: number[][] = [
  [0x28, 0xb5, 0x2f, 0xfd], // zstd
  [0x04, 0x22, 0x4d, 0x18], // lz4
  [0x02, 0x21, 0x4c, 0x18], // lz4 legacy
  [0x89, 0x4c, 0x5a, 0x4f], // lzop
  [0xfd, 0x37, 0x7a, 0x58, 0x5a], // xz
  [0x5d, 0x00, 0x00], // lzma
  [0x37, 0x7a, 0xbc, 0xaf], // 7z
  [0x1f, 0x9d], // compress
  [0xed, 0xab, 0xee, 0xdb], // rpm
  [0xc7, 0x71],
  [0x71, 0xc7], // cpio binario
  ...['LRZI', 'LZIP', 'GRZipII', '#mtree', 'Rar!', 'MSCF', 'xar!', '!<arch>', '070701', '070702', '070707', 'begin '].map((m) => [...Buffer.from(m, 'latin1')])
]

/** Vero se la testa (512 byte) è un header ustar valido: magic, checksum (byte 148-155, somma degli header con il campo a spazi) e non inizia come un filtro noto. */
export function isUstarHead(buf: Buffer): boolean {
  if (buf.length < 512 || buf.toString('latin1', 257, 262) !== 'ustar') return false
  if (FILTER_MAGICS.some((m) => m.every((byte, i) => buf[i] === byte))) return false
  // Frame saltabili di zstd e lz4: il primo byte va da 0x50 a 0x5f, poi 2a 4d 18.
  if ((buf[0] & 0xf0) === 0x50 && buf[1] === 0x2a && buf[2] === 0x4d && buf[3] === 0x18) return false
  const field = /^[ 0]*([0-7]+)[\0 ]/.exec(buf.toString('latin1', 148, 156))?.[1]
  if (!field) return false
  let unsigned = 0
  let signed = 0
  for (let i = 0; i < 512; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : buf[i]
    unsigned += byte
    signed += byte > 127 ? byte - 256 : byte
  }
  const stored = parseInt(field, 8)
  return stored === unsigned || stored === signed
}

async function sniff(file: string): Promise<'zip' | 'gzip' | 'bzip2' | 'tar' | 'macho' | 'raw'> {
  const handle = await open(file, 'r')
  try {
    const buf = Buffer.alloc(512)
    const { bytesRead } = await handle.read(buf, 0, 512, 0)
    if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip'
    if (buf[0] === 0x1f && buf[1] === 0x8b) return 'gzip'
    if (buf.toString('latin1', 0, 3) === 'BZh') return 'bzip2'
    if (bytesRead >= 512 && isUstarHead(buf)) return 'tar'
    if (MACHO.has(buf.toString('hex', 0, 4))) return 'macho'
    return 'raw'
  } finally {
    await handle.close()
  }
}

/** Vero se il nome del file nell'URL (o il parametro `file=`) ha un'estensione da archivio o da compressione. */
function hasArchiveExtension(url: string): boolean {
  try {
    const u = new URL(url)
    return [u.pathname, u.searchParams.get('file') ?? ''].some((p) => /\.(zip|tar|tgz|gz|bz2|tbz2?|xz|txz|zst|lz4|7z|rar|dmg|pkg)$/i.test(p))
  } catch {
    return true
  }
}

const entryOk = (entry: string) => !isAbsolute(entry) && !entry.includes('\0') && !normalize(entry).split(sep).includes('..')

/** Chiave di confronto di un percorso: il disco di macOS non distingue maiuscole né forme Unicode (NFC/NFD), quindi `A/x` e `a/x` sono lo stesso posto. */
const folded = (entry: string) =>
  normalize(entry)
    .replace(/\/+$/, '')
    .normalize('NFD')
    .toLowerCase()

/**
 * Nessuna voce può stare sotto un'altra voce che non è una cartella (tar potrebbe scrivere attraverso un link creato prima).
 * `types` sono i tipi letti da `tar -tv` (primo carattere di ogni riga: `d` cartella); i nomi si confrontano senza maiuscole e in NFD.
 */
function noFileParents(entries: string[], types: string[]): boolean {
  const names = entries.map(folded)
  const files = new Set(names.filter((_, i) => types[i] !== 'd'))
  return names.every((name) => {
    const parts = name.split(sep)
    for (let i = 1; i < parts.length; i++) if (files.has(parts.slice(0, i).join(sep))) return false
    return true
  })
}

/** Esegue un programma (mai una shell) e passa a `onLine` ogni riga dell'output; se `onLine` lancia, il processo si ferma e l'errore risale. 120 secondi al massimo. */
function spawnLines(file: string, args: string[], onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: tarEnv(), stdio: ['ignore', 'pipe', 'ignore'], signal, timeout: 120_000 })
    let rest = ''
    let failure: unknown = null
    // Con la codifica sul flusso un carattere multibyte spezzato tra due chunk non diventa U+FFFD (le due letture, -tf e -tvf, devono dare gli stessi nomi).
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (failure) return
      rest += chunk
      const lines = rest.split('\n')
      rest = lines.pop() ?? ''
      try {
        for (const line of lines) onLine(line)
      } catch (error) {
        failure = error
        child.kill('SIGKILL')
      }
    })
    child.on('error', (error) => reject(failure ?? error))
    child.on('close', (code) => {
      if (failure) return reject(failure)
      try {
        if (rest) onLine(rest)
      } catch (error) {
        return reject(error)
      }
      code === 0 ? resolve() : reject(new Error(t('{program} stopped with code {code}.', { program: basename(file), code: String(code) })))
    })
  })
}

/**
 * Elenco dell'archivio con bsdtar, lo stesso programma che poi estrae (con un altro programma i nomi della directory
 * centrale di uno zip e quelli degli header locali potrebbero non coincidere): i nomi da `-tf` e, riga per riga, i tipi e
 * le dimensioni da `-tvf`. Si ferma appena un limite è superato (zip-bomb). Rifiuta hard link e file speciali.
 */
async function listArchive(archive: string, signal?: AbortSignal): Promise<{ entries: string[]; types: string[] }> {
  const notSafe = Object.assign(new Error(t('The downloaded archive is not safe to extract.')), { final: true })
  const entries: string[] = []
  const types: string[] = []
  let total = 0
  await spawnLines(
    '/usr/bin/tar',
    ['-tf', archive],
    (line) => {
      if (!line) return
      // bsdtar stampa i caratteri di controllo e la barra rovesciata con una sequenza di escape: un nome così non è un file di un programma.
      if (/[\\\u0000-\u001f]/.test(line)) throw notSafe
      entries.push(line)
      if (entries.length > MAX_ENTRIES) throw tooLarge()
    },
    signal
  ).then(() =>
    spawnLines(
      '/usr/bin/tar',
      ['-tvf', archive],
      (line) => {
        // "-rw-r--r--  0 utente gruppo  12345 Jan  1 00:00 nome": primo carattere = tipo, 5° campo = dimensione.
        if (!/^[-dlhcbps?][-rwxsStT?]{9}/.test(line)) return
        if ('hcbps'.includes(line[0])) throw notSafe
        // La dimensione si legge da destra: tolto il nome (noto dalla `-tf`, stesso indice) restano `... dimensione utente data`. uname e gname
        // possono contenere spazi e numeri (anche una data finta), quindi non si conta per campo né con un'espressione che parte da sinistra.
        // Un link non ha contenuto e il suo "-> bersaglio" è scelto da chi crea l'archivio: la dimensione conta solo per le altre voci.
        let size = 0
        if (line[0] !== 'l') {
          const name = entries[types.length]
          if (name === undefined || !line.endsWith(` ${name}`)) throw notSafe
          const head = line.slice(0, line.length - name.length - 1)
          size = Number(/\s(\d+)\s+\S+\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4})$/.exec(head)?.[1])
          if (!Number.isFinite(size)) throw notSafe
        }
        types.push(line[0])
        total += size
        if (types.length > MAX_ENTRIES || total > MAX_EXTRACTED_BYTES) throw tooLarge()
      },
      signal
    )
  ).catch((error) => {
    if (error === notSafe || error instanceof BlockError || signal?.aborted) throw error
    throw new Error(t('The downloaded file is in a format Ladder can’t unpack.'))
  })
  // Le due letture devono vedere le stesse voci, nello stesso ordine.
  if (entries.length !== types.length) throw notSafe
  return { entries, types }
}

/** Primi 512 byte del contenuto decompresso di un gzip o bzip2 (si ferma lì): serve a verificare che dentro ci sia solo un tar. */
function decompressedHead(program: string, archive: string): Promise<Buffer> {
  return new Promise((resolveHead) => {
    const child = spawn(program, ['-dc', archive], { env: untrustedEnv(), stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 })
    const chunks: Buffer[] = []
    let size = 0
    const finish = () => resolveHead(Buffer.concat(chunks).subarray(0, 512))
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      size += chunk.length
      if (size >= 512) child.kill('SIGKILL')
    })
    child.on('error', finish)
    child.on('close', finish)
  })
}

/** Estrae con un controllo periodico sul contenuto: se supera i limiti (dimensione reale, non quella dichiarata) il processo si ferma. */
function extractLimited(file: string, args: string[], dest: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: tarEnv(), stdio: 'ignore', signal, timeout: 120_000 })
    let exceeded = false
    let busy = false
    const timer = setInterval(() => {
      if (busy || exceeded) return
      busy = true
      measure(dest)
        .then(({ bytes, entries }) => {
          if (bytes > MAX_EXTRACTED_BYTES || entries > MAX_ENTRIES) {
            exceeded = true
            child.kill('SIGKILL')
          }
        })
        .catch(() => undefined)
        .finally(() => (busy = false))
    }, 400)
    child.on('error', (error) => {
      clearInterval(timer)
      reject(exceeded ? tooLarge() : error)
    })
    child.on('close', (code) => {
      clearInterval(timer)
      if (exceeded) return reject(tooLarge())
      // Controllo finale: l'ultimo giro del timer può non aver visto la fine.
      measure(dest)
        .then(({ bytes, entries }) => {
          if (bytes > MAX_EXTRACTED_BYTES || entries > MAX_ENTRIES) reject(tooLarge())
          else code === 0 ? resolve() : reject(new Error(t('{program} stopped with code {code}.', { program: basename(file), code: String(code) })))
        })
        .catch(reject)
    })
  })
}

/** Byte e voci di una cartella, senza seguire i link. */
async function measure(dir: string): Promise<{ bytes: number; entries: number }> {
  let bytes = 0
  let entries = 0
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      entries += 1
      const full = join(path, entry.name)
      if (entry.isDirectory()) await walk(full)
      else bytes += (await lstat(full)).size
      if (bytes > MAX_EXTRACTED_BYTES || entries > MAX_ENTRIES) return
    }
  }
  await walk(dir).catch(() => undefined)
  return { bytes, entries }
}

/**
 * Estrae l'archivio (zip, tar, tar.gz, tar.bz2) in `dest`, cartella nuova, sempre con bsdtar (elenco ed estrazione con lo stesso
 * programma); il formato si riconosce dai primi byte e non dall'estensione e dentro gzip/bzip2 deve esserci un tar. Prima legge l'elenco e rifiuta percorsi assoluti o con `..`, link simbolici negli zip, hard link,
 * file speciali e voci sotto un file, e ferma tutto se le dimensioni dichiarate o le voci superano i limiti; durante
 * l'estrazione controlla anche la dimensione reale (zip-bomb con intestazioni false). Dopo rifiuta ogni link simbolico
 * che, seguito fino in fondo, porti fuori da `dest` o abbia un bersaglio assoluto, ogni file con più link e ogni file speciale; toglie
 * a TUTTI i file normali i bit di esecuzione, setuid e setgid (il permesso di esecuzione lo dà poi chi installa, solo al file atteso).
 * Un file che non è un archivio si accetta solo se è un eseguibile Mach-O o se `sourceUrl` non ha un'estensione da
 * archivio: `rawName` è il percorso relativo in cui metterlo. Altri formati (tar.xz, tar.zst, gz non tar…) si rifiutano.
 */
export async function extractArchive(archive: string, dest: string, rawName: string, sourceUrl?: string, signal?: AbortSignal): Promise<void> {
  await removeTree(dest)
  await mkdir(dest, { recursive: true })
  const kind = await sniff(archive)
  if (kind === 'macho' || (kind === 'raw' && sourceUrl !== undefined && !hasArchiveExtension(sourceUrl))) {
    const target = join(dest, rawName)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(archive, target)
    return
  }
  if (kind === 'raw') throw new Error(t('The downloaded file is in a format Ladder can’t unpack.'))
  const unsafe = () => new Error(t('The downloaded archive is not safe to extract.'))
  // Dentro gzip e bzip2 ci deve essere un tar: bsdtar riconosce da sé altri filtri (lrzip, lzop, grzip) e li avvierebbe come programmi esterni.
  if (kind === 'gzip' || kind === 'bzip2') {
    const head = await decompressedHead(kind === 'gzip' ? '/usr/bin/gzip' : '/usr/bin/bzip2', archive)
    if (!isUstarHead(head)) throw new Error(t('The downloaded file is in a format Ladder can’t unpack.'))
  }
  // Elenco ed estrazione con lo stesso programma (bsdtar, anche per gli zip). I link simbolici negli zip non servono a un programma: si rifiutano (`l` in `-tv`).
  const { entries, types } = await listArchive(archive, signal)
  if (!entries.every(entryOk) || !noFileParents(entries, types)) throw unsafe()
  if (kind === 'zip' && types.includes('l')) throw unsafe()
  // Senza attributi estesi, ACL e metadati di macOS (AppleDouble): solo i dati e i permessi; i default di bsdtar già rifiutano `..` e tolgono la `/` iniziale.
  await extractLimited('/usr/bin/tar', ['--no-xattrs', '--no-acls', '--no-mac-metadata', '-xf', archive, '-C', dest], dest, signal)
  // Percorsi dal realpath di `dest`: se la cartella dati passa da un link (/tmp → /private/tmp) i link interni restano validi.
  const root = await realpath(dest)
  await assertSafeTree(root, root)
}

/** Cancella una cartella temporanea anche se l'archivio vi ha lasciato cartelle senza permessi (modo 0000): riapre u+rwx, senza seguire i link, solo dentro `path`. */
export async function removeTree(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true })
  } catch {
    const open = async (dir: string): Promise<void> => {
      const info = await lstat(dir).catch(() => null)
      if (!info?.isDirectory()) return
      if ((info.mode & 0o700) !== 0o700) await chmod(dir, info.mode | 0o700).catch(() => undefined)
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) await open(join(dir, entry.name))
    }
    await open(path)
    await rm(path, { recursive: true, force: true })
  }
}

/** Dentro `dir`: link simbolici relativi che restano nella radice (seguiti fino in fondo), nessun file speciale o con più link; a ogni file normale si tolgono esecuzione, setuid e setgid. */
async function assertSafeTree(dir: string, root: string): Promise<void> {
  const unsafe = () => new Error(t('The downloaded archive is not safe to extract.'))
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      // Solo link relativi: uno assoluto punta fuori dall'albero qualunque cosa ci sia oggi in quel percorso.
      const to = await readlink(path)
      if (isAbsolute(to)) throw unsafe()
      // Il testo del link non può risalire sopra la radice nemmeno di un passo: dopo lo scambio della cartella (`<id>.new` diventa `<id>`) un link che
      // passa dal nome della cartella temporanea (`../../<id>.new/x`) punterebbe a un posto che non esiste più.
      const up = normalize(join(relative(root, dirname(path)), to))
      if (up === '..' || up.startsWith(`..${sep}`)) throw unsafe()
      // Con realpath si seguono anche i link a catena (a → b/.. → fuori), che un controllo sul solo testo del link non vede.
      const real = await realpath(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw unsafe()
        // Link che non porta da nessuna parte: conta il testo del link, che deve restare dentro.
        return resolve(dirname(path), to)
      })
      if (real !== root && !real.startsWith(root + sep)) throw unsafe()
    } else if (info.isDirectory()) {
      // Una cartella senza permessi (modo 0000 nel tar) non si legge né si cancella: si riapre al proprietario prima di entrarci.
      if ((info.mode & 0o700) !== 0o700) await chmod(path, info.mode | 0o700)
      await assertSafeTree(path, root)
    }
    else if (!info.isFile() || info.nlink > 1) throw unsafe()
    else if (info.mode & 0o7111) await chmod(path, info.mode & 0o666)
  }
}

/** Percorso assoluto del programma dentro `root`, a patto che sia un file e (anche seguendo i link) resti dentro `root`. */
export async function resolveInside(root: string, cmd: string): Promise<string> {
  const rel = safeRelativePath(cmd)
  if (!rel) throw new Error(t('The registry gives an unsafe path for the program.'))
  const full = join(root, rel)
  const real = await realpath(full).catch(() => null)
  const realRoot = await realpath(root)
  if (!real || !real.startsWith(realRoot + sep) || !(await lstat(real)).isFile()) throw new Error(t('The downloaded archive does not contain the expected program.'))
  return full
}

/** Vero se il file porta l'attributo di quarantena di macOS (Gatekeeper lo valuterebbe all'avvio). */
export async function hasQuarantine(path: string): Promise<boolean> {
  try {
    await run('/usr/bin/xattr', ['-p', 'com.apple.quarantine', path], { env: untrustedEnv(), timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/** Il pacchetto `.app` che contiene il programma (dentro `root`), se c'è: la firma di un'app si verifica sul pacchetto intero. */
function enclosingApp(root: string, program: string): string | null {
  const parts = program.slice(root.length + 1).split(sep)
  const index = parts.findIndex((part) => part.endsWith('.app'))
  return index >= 0 ? join(root, ...parts.slice(0, index + 1)) : null
}

/**
 * Cartelle di un `.app` dove sta il programma da avviare (il resto, come Contents/Resources, può avere file fuori dal sigillo). Non ci sono
 * `Contents/runtime` e `Contents/jbr`: contengono il JDK (`java` firmato dal vendor accetta `-XX:OnOutOfMemoryError=…`), e il programma è
 * comunque fissato per ogni agente curato scaricabile (`CURATED.cmd`).
 */
const APP_EXECUTABLE_DIRS = ['Contents/MacOS', 'Contents/Helpers', 'Contents/Frameworks']

/** Vero se il file inizia con la firma di un Mach-O (o di un binario universale). */
async function isMachO(file: string): Promise<boolean> {
  const handle = await open(file, 'r')
  try {
    const buf = Buffer.alloc(4)
    const { bytesRead } = await handle.read(buf, 0, 4, 0)
    return bytesRead === 4 && MACHO.has(buf.toString('hex'))
  } finally {
    await handle.close()
  }
}

/**
 * Requisito sul certificato: la catena deve arrivare ad Apple (`anchor apple generic`) e la foglia essere un Developer ID
 * Application (OID 1.2.840.113635.100.6.1.13); i binari di sistema di Apple valgono con `anchor apple`. Senza, il nome
 * dentro il certificato lo può scrivere chiunque: un certificato autofirmato "Developer ID Application: Google LLC" passa
 * `--verify` (che controlla solo l'integrità).
 */
const SIGNER_REQUIREMENT = 'anchor apple or (anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists)'

/**
 * Firma del programma (o dell'app che lo contiene) con `codesign`, senza eseguirlo. Si lavora sul realpath del programma: se `cmd`
 * è un link a un eseguibile dentro un `.app`, la firma si verifica sul pacchetto e sul programma.
 * - Non firmato: `unsigned`; ad hoc: `adhoc`. Si installano comunque.
 * - Firma rotta (`--verify --deep --strict` fallisce) o `codesign` non risponde: BlockError `signature`.
 * - Firma integra e requisito su Apple/Developer ID soddisfatto: `signed`, con firmatario e team. Se il programma sta dentro un `.app` deve anche stare
 *   in una cartella degli eseguibili dell'app, essere un Mach-O e soddisfare da solo lo stesso requisito (altrimenti `signature`, o `team` se il team è fissato);
 *   firmatario e team sono quelli del certificato del programma.
 * - Firma integra ma requisito non soddisfatto (autofirmata, catena non Apple, certificato non Developer ID): `unverified`,
 *   senza firmatario né team (il nome nel certificato non è attendibile).
 * Firmatario e team NON si leggono dal testo di `codesign -d`: l'Identifier lo sceglie chi firma e può contenere a capo, con righe
 * `TeamIdentifier=`/`Authority=` finte prima di quelle vere. Si leggono dal certificato foglia estratto (`--extract-certificates`),
 * già verificato dal requisito. `expectedTeam` (agenti curati con team fissato in Ladder): il team sta dentro il requisito
 * (`certificate leaf[subject.OU]`), quindi lo controlla codesign sul certificato; se non è soddisfatto (non firmato, ad hoc o altro
 * team) è BlockError `team`.
 */
export async function codeSignature(root: string, program: string, expectedTeam?: string): Promise<AgentSignature> {
  const realRoot = await realpath(root)
  const realProgram = await realpath(program)
  const target = enclosingApp(realRoot, realProgram) ?? realProgram
  const opts = { env: untrustedEnv(), timeout: 60_000, maxBuffer: 1024 * 1024 }
  const bad = () => new BlockError('signature', t('The program is signed but its signature does not verify.'))
  const wrongTeam = () => new BlockError('team', t('The program is not signed by the developer Ladder expects for this agent.'))
  // Il team finisce dentro un requisito di codesign: solo il formato del TeamIdentifier.
  if (expectedTeam !== undefined && !/^[A-Z0-9]{10}$/.test(expectedTeam)) throw wrongTeam()
  let info: string
  try {
    // `-d` scrive su stderr; qui serve solo a distinguere "non firmato" e "ad hoc".
    info = (await run('/usr/bin/codesign', ['-d', '--verbose=2', target], opts)).stderr
  } catch (error) {
    if (/not signed at all/i.test(String((error as { stderr?: string }).stderr ?? ''))) {
      if (expectedTeam) throw wrongTeam()
      return { state: 'unsigned', signer: null, team: null }
    }
    throw bad()
  }
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target], opts).catch(() => {
    throw bad()
  })
  // Firma integra: il certificato risale ad Apple ed è un Developer ID (e, se fissato, del team atteso)? (`-R=` col requisito attaccato: è la forma che codesign accetta.)
  const requirement = expectedTeam ? `anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${expectedTeam}"` : SIGNER_REQUIREMENT
  const trusted = await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=${requirement}`, target], opts).then(
    () => true,
    () => false
  )
  if (!trusted) {
    if (expectedTeam) throw wrongTeam()
    // Ad hoc o senza certificati: lo dice il campo Signature (al peggio una riga finta scambia adhoc e unverified, che non mostrano nomi).
    return { state: /^Signature=adhoc$/m.test(info) ? 'adhoc' : 'unverified', signer: null, team: null }
  }
  // Il programma dentro un'app: la firma del pacchetto non basta. Le regole standard del sigillo (rules2) escludono percorsi come `.DS_Store` o
  // `PkgInfo`, dove chi pubblica una release senza la chiave di firma può mettere un eseguibile qualunque e farlo puntare da `cmd`. Quindi il programma
  // deve stare dove un'app tiene i suoi eseguibili, essere un Mach-O e passare da solo lo stesso requisito; firmatario e team si leggono dal suo certificato.
  if (target !== realProgram) {
    const inside = realProgram.slice(target.length + 1)
    if (!APP_EXECUTABLE_DIRS.some((dir) => inside.startsWith(`${dir}/`)) || !(await isMachO(realProgram))) throw bad()
    await run('/usr/bin/codesign', ['--verify', '--strict', `-R=${requirement}`, realProgram], opts).catch(() => {
      throw expectedTeam ? wrongTeam() : bad()
    })
  }
  const leaf = await leafSubject(realProgram, opts)
  // Sono righe di testo mostrate all'utente: corte e senza caratteri di controllo.
  const clean = (value: string | null) => (value && value.length <= 200 && !/[\u0000-\u001f]/.test(value) ? value : null)
  return { state: 'signed', signer: clean(leaf.cn), team: expectedTeam ?? clean(leaf.ou) }
}

/**
 * Valore di un nome distinto (RFC 2253) come lo scrive Node in `cert.subject`: `\,` `\+` `\;` `\"` `\\` `\<` `\>` `\=` `\#` e `\XX` (byte esadecimali di UTF-8)
 * tornano il carattere; le virgolette attorno a tutto il valore si tolgono.
 */
export function unescapeDn(value: string): string {
  const quoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"') && !value.endsWith('\\"') ? value.slice(1, -1) : value
  return quoted.replace(/((?:\\[0-9a-fA-F]{2})+)|\\([\s\S])/g, (_, hex: string | undefined, char: string) => (hex ? Buffer.from(hex.replaceAll('\\', ''), 'hex').toString('utf8') : char))
}

/** Nome comune e unità organizzativa (team) del certificato foglia della firma, letti dal certificato e non dall'output di codesign. */
async function leafSubject(target: string, opts: { env: Record<string, string | undefined>; timeout: number; maxBuffer: number }): Promise<{ cn: string | null; ou: string | null }> {
  const dir = await mkdtemp(join(tmpdir(), 'ladder-cert-'))
  try {
    await run('/usr/bin/codesign', ['-d', `--extract-certificates=${join(dir, 'c')}`, target], opts)
    // I certificati sono `c0` (foglia), `c1`… in DER.
    const cert = new X509Certificate(await readFile(join(dir, 'c0')))
    const field = (name: string) => {
      const raw = new RegExp(`^${name}=(.+)$`, 'm').exec(cert.subject)?.[1].trim()
      return raw === undefined ? null : unescapeDn(raw)
    }
    return { cn: field('CN'), ou: field('OU') }
  } catch {
    return { cn: null, ou: null }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
