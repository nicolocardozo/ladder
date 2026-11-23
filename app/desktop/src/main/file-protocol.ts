// Protocollo ladder-file (LAD-70): serve alla UI immagini, PDF, audio e video dei progetti senza passare i byte dalla MessagePort.
//
//   ladder-file://<id-root>/<percorso relativo>[?rev=<HEAD|sha>]
//
// <id-root> è un id opaco che l'host assegna a un progetto o al worktree di una sessione e comunica con `file-roots`: la UI non sceglie
// percorsi, e ciò che l'host toglie dall'elenco smette di funzionare. Si serve solo GET/HEAD, sempre in streaming (mai readFile),
// dentro la root (realpath: i collegamenti simbolici non escono), con tipo dai primi byte e solo per i tipi in whitelist.
import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { Readable } from 'node:stream'
import { protocol, shell } from 'electron'
import { cleanEnv } from '@shared/env'
import { FILE_SCHEME, isKnownRev, SNIFF_BYTES, sniffType, type SniffedType } from '@shared/file-type'

/** Va chiamato prima di `app.ready`: Electron non accetta gli schemi privilegiati dopo. */
export function registerFileScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
}

/** id → cartella reale della root; sostituita per intero a ogni aggiornamento dell'host. */
let roots = new Map<string, string>()

export function setFileRoots(list: readonly { id: string; root: string }[]): void {
  roots = new Map(list.filter((r) => typeof r.id === 'string' && /^[0-9a-f]{16,64}$/.test(r.id) && typeof r.root === 'string' && r.root).map((r) => [r.id, r.root]))
}

/**
 * Percorso relativo già decodificato → segmenti validi, altrimenti null. Rifiuta assoluti, `..`, `.`, segmenti vuoti,
 * backslash, NUL e caratteri di controllo, e `.git` (in qualunque combinazione di maiuscole: APFS non le distingue).
 */
function cleanRel(rel: string): string | null {
  if (!rel || rel.length > 4096 || /[\\\u0000-\u001f\u007f]/.test(rel)) return null
  const parts = rel.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.toLowerCase() === '.git')) return null
  return parts.join('/')
}

type Resolved = { ok: true; realRoot: string; real: string } | { ok: false; status: number }

/** Root e file reali (symlink risolti); 403 se il file finisce fuori dalla root, 404 se non esiste. */
async function resolveInRoot(root: string, rel: string, mustExist: boolean): Promise<Resolved> {
  const realRoot = await realpath(root).catch(() => null)
  if (!realRoot) return { ok: false, status: 404 }
  if (!mustExist) return { ok: true, realRoot, real: join(realRoot, rel) }
  const real = await realpath(join(realRoot, rel)).catch(() => null)
  if (!real) return { ok: false, status: 404 }
  if (!real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return { ok: false, status: 403 }
  // Un collegamento simbolico non deve aggirare il divieto su .git.
  if (real.slice(realRoot.length).split(sep).some((p) => p.toLowerCase() === '.git')) return { ok: false, status: 403 }
  return { ok: true, realRoot, real }
}

/** Mostra nel Finder un file di una root nota (comando dell'host); ignora tutto ciò che non è dentro la root. */
export async function revealFile(id: string, path: string): Promise<void> {
  const root = roots.get(id)
  const rel = typeof path === 'string' ? cleanRel(path) : null
  if (!root || !rel) return
  const resolved = await resolveInRoot(root, rel, true)
  if (resolved.ok) shell.showItemInFolder(resolved.real)
}

const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }
const CSP_NONE = "default-src 'none'; sandbox"
// Immagini (SVG compreso) e media: niente script né sottorisorse, documento in sandbox anche se aperto direttamente.
const CSP_INLINE = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"
// Il visore PDF di Chromium non parte in un documento con `sandbox`: qui si chiudono script e sottorisorse, ma non si mette la sandbox.
const CSP_PDF = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; object-src 'self'"

function csp(type: SniffedType | null): string {
  if (!type) return CSP_NONE
  return type.kind === 'pdf' ? CSP_PDF : CSP_INLINE
}

const fail = (status: number, extra: Record<string, string> = {}): Response =>
  new Response(null, { status, headers: { ...BASE_HEADERS, 'Content-Security-Policy': CSP_NONE, ...extra } })

const attachmentName = (name: string) => `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`

interface Range {
  start: number
  end: number
}

/** Una sola fascia `bytes=a-b`, `a-` o `-n`. null = nessun Range; 'bad' = sintassi o fascia non soddisfacibile (416). */
function parseRange(header: string | null, size: number): Range | 'bad' | null {
  if (header === null) return null
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '') || size === 0) return 'bad'
  if (m[1] === '') {
    const n = Number(m[2])
    return n === 0 ? 'bad' : { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  if (start >= size || (m[2] !== '' && Number(m[2]) < start)) return 'bad'
  return { start, end: m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) }
}

function respond(method: string, type: SniffedType | null, name: string, size: number, range: Range | null, mtimeMs: number | null, body: () => ReadableStream | null, release: () => void): Response {
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    'Accept-Ranges': 'bytes',
    'Content-Type': type?.mime ?? 'application/octet-stream',
    'Content-Security-Policy': csp(type),
    'Content-Disposition': type ? 'inline' : attachmentName(name),
    'Content-Length': String(range ? range.end - range.start + 1 : size)
  }
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
  if (mtimeMs !== null) headers['Last-Modified'] = new Date(mtimeMs).toUTCString()
  if (method === 'HEAD' || size === 0) {
    release()
    return new Response(null, { status: range ? 206 : 200, headers })
  }
  return new Response(body(), { status: range ? 206 : 200, headers })
}

async function serveFile(request: Request, root: string, rel: string): Promise<Response> {
  const resolved = await resolveInRoot(root, rel, true)
  if (!resolved.ok) return fail(resolved.status)
  // O_NOFOLLOW: se il file è stato sostituito da un collegamento dopo il realpath, l'apertura fallisce; O_NONBLOCK: una FIFO non blocca.
  const handle = await open(resolved.real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null)
  if (!handle) return fail(404)
  try {
    const info = await handle.stat()
    if (!info.isFile()) {
      await handle.close()
      return fail(404)
    }
    const head = Buffer.alloc(Math.min(SNIFF_BYTES, info.size))
    if (head.length) await handle.read(head, 0, head.length, 0)
    const type = sniffType(head, basename(rel))
    const range = parseRange(request.headers.get('range'), info.size)
    if (range === 'bad') {
      await handle.close()
      return fail(416, { 'Content-Range': `bytes */${info.size}` })
    }
    return respond(
      request.method,
      type,
      basename(rel),
      info.size,
      range,
      info.mtimeMs,
      () => {
        const stream = handle.createReadStream({ start: range?.start ?? 0, end: range?.end ?? Math.max(0, info.size - 1), autoClose: true })
        request.signal.addEventListener('abort', () => stream.destroy(), { once: true })
        return Readable.toWeb(stream) as ReadableStream
      },
      () => void handle.close().catch(() => undefined)
    )
  } catch {
    await handle.close().catch(() => undefined)
    return fail(500)
  }
}

// ── Revisioni di git ──

const GIT_ENV = (): Record<string, string | undefined> => ({
  ...cleanEnv(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PAGER']),
  GIT_TERMINAL_PROMPT: '0'
})
/** Opzioni globali: pathspec letterali e nessun blocco sull'indice. Mai una shell: gli argomenti vanno a git così come sono. */
const gitArgs = (repo: string, args: string[]) => ['-C', repo, '--no-optional-locks', '--literal-pathspecs', ...args]

function gitText(repo: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', gitArgs(repo, args), { env: GIT_ENV(), timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout).trim()))
  })
}

/** `<rev>:./<percorso>` (rev validata: hex o HEAD, non può iniziare con `-`; il percorso è un solo argomento letterale, relativo alla cartella). */
async function serveRev(request: Request, root: string, rel: string, rev: string): Promise<Response> {
  const resolved = await resolveInRoot(root, rel, false)
  if (!resolved.ok) return fail(resolved.status)
  const spec = `${rev}:./${rel}`
  const [kind, sizeText] = await Promise.all([gitText(resolved.realRoot, ['cat-file', '-t', spec]), gitText(resolved.realRoot, ['cat-file', '-s', spec])])
  const size = Number(sizeText)
  if (kind !== 'blob' || !Number.isSafeInteger(size)) return fail(404)
  const range = parseRange(request.headers.get('range'), size)
  if (range === 'bad') return fail(416, { 'Content-Range': `bytes */${size}` })

  const child = spawn('git', gitArgs(resolved.realRoot, ['cat-file', 'blob', spec]), { env: GIT_ENV(), stdio: ['ignore', 'pipe', 'ignore'] })
  const stop = () => child.kill()
  const timer = setTimeout(stop, 15_000)
  child.on('error', () => child.stdout.destroy())
  const chunks = child.stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>
  // Il tipo si legge dal primo pezzo del blob: il resto continua a scorrere in streaming.
  let first: Buffer = Buffer.alloc(0)
  try {
    while (first.length < Math.min(size, SNIFF_BYTES)) {
      const next = await chunks.next()
      if (next.done) break
      first = Buffer.concat([first, next.value])
    }
  } catch {
    stop()
    return fail(404)
  } finally {
    clearTimeout(timer)
  }
  const type = sniffType(first.subarray(0, SNIFF_BYTES), basename(rel))
  const from = range?.start ?? 0
  const to = range?.end ?? size - 1
  async function* body(): AsyncGenerator<Buffer> {
    let position = 0
    let chunk: Buffer | undefined = first
    try {
      while (chunk) {
        const slice = chunk.subarray(Math.max(0, from - position), Math.max(0, to + 1 - position))
        if (slice.length) yield slice
        position += chunk.length
        if (position > to) return
        const next = await chunks.next()
        chunk = next.done ? undefined : next.value
      }
    } finally {
      stop()
    }
  }
  return respond(
    request.method,
    type,
    basename(rel),
    size,
    range,
    null,
    () => {
      const stream = Readable.from(body())
      request.signal.addEventListener('abort', () => stream.destroy(), { once: true })
      return Readable.toWeb(stream) as ReadableStream
    },
    stop
  )
}

async function handle(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, { Allow: 'GET, HEAD' })
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return fail(400)
  }
  const root = roots.get(url.hostname)
  if (!root) return fail(404)
  let rel: string | null
  try {
    // Una sola decodifica: `%252e%252e` resta il nome letterale "%2e%2e", mai un `..`.
    rel = url.pathname.startsWith('/') ? cleanRel(decodeURIComponent(url.pathname.slice(1))) : null
  } catch {
    rel = null
  }
  if (!rel) return fail(400)
  const keys = [...url.searchParams.keys()]
  if (keys.some((k) => k !== 'rev') || url.searchParams.getAll('rev').length > 1 || url.hash) return fail(400)
  const rev = url.searchParams.get('rev')
  try {
    if (rev === null) return await serveFile(request, root, rel)
    return isKnownRev(rev) ? await serveRev(request, root, rel, rev) : fail(400)
  } catch {
    return fail(500)
  }
}

/** Da chiamare dopo `app.ready`. */
export function registerFileProtocol(): void {
  protocol.handle(FILE_SCHEME, handle)
}
