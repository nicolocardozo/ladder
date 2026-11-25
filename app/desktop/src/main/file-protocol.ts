// ladder-file protocol: serves the UI with images, PDFs, audio and video from projects without passing the bytes through the MessagePort.
//
//   ladder-file://<id-root>/<percorso relativo>[?rev=<HEAD|sha>]
//
// <root-id> is an opaque id the host assigns to a project or to a session's worktree and communicates with `file-roots`: the UI does not choose
// paths, and whatever the host removes from the list stops working. Only GET/HEAD are served, always streamed (never readFile),
// inside the root (realpath: symlinks do not escape), with type from the first bytes and only for whitelisted types.
import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { Readable } from 'node:stream'
import { protocol, shell } from 'electron'
import { cleanEnv } from '@shared/env'
import { FILE_SCHEME, isKnownRev, SNIFF_BYTES, sniffType, type SniffedType } from '@shared/file-type'

/** Must be called before `app.ready`: Electron does not accept privileged schemes afterwards. */
export function registerFileScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
}

/** id → real folder of the root; replaced entirely on every host update. */
let roots = new Map<string, string>()

export function setFileRoots(list: readonly { id: string; root: string }[]): void {
  roots = new Map(list.filter((r) => typeof r.id === 'string' && /^[0-9a-f]{16,64}$/.test(r.id) && typeof r.root === 'string' && r.root).map((r) => [r.id, r.root]))
}

/**
  * Already-decoded relative path → valid segments, otherwise null. Rejects absolute paths, `..`, `.`, empty segments,
  * backslash, NUL and control characters, and `.git` (in any capitalization: APFS does not distinguish them).
 */
function cleanRel(rel: string): string | null {
  if (!rel || rel.length > 4096 || /[\\\u0000-\u001f\u007f]/.test(rel)) return null
  const parts = rel.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.toLowerCase() === '.git')) return null
  return parts.join('/')
}

type Resolved = { ok: true; realRoot: string; real: string } | { ok: false; status: number }

/** Real root and file (symlinks resolved); 403 if the file ends up outside the root, 404 if it does not exist. */
async function resolveInRoot(root: string, rel: string, mustExist: boolean): Promise<Resolved> {
  const realRoot = await realpath(root).catch(() => null)
  if (!realRoot) return { ok: false, status: 404 }
  if (!mustExist) return { ok: true, realRoot, real: join(realRoot, rel) }
  const real = await realpath(join(realRoot, rel)).catch(() => null)
  if (!real) return { ok: false, status: 404 }
  if (!real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return { ok: false, status: 403 }
  // A symlink must not get around the ban on .git.
  if (real.slice(realRoot.length).split(sep).some((p) => p.toLowerCase() === '.git')) return { ok: false, status: 403 }
  return { ok: true, realRoot, real }
}

/** Shows a file of a known root in Finder (host command); ignores everything that is not inside the root. */
export async function revealFile(id: string, path: string): Promise<void> {
  const root = roots.get(id)
  const rel = typeof path === 'string' ? cleanRel(path) : null
  if (!root || !rel) return
  const resolved = await resolveInRoot(root, rel, true)
  if (resolved.ok) shell.showItemInFolder(resolved.real)
}

const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }
const CSP_NONE = "default-src 'none'; sandbox"
// Images (SVG included) and media: no scripts or subresources, sandboxed document even if opened directly.
const CSP_INLINE = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"
// Chromium's PDF viewer does not start in a document with `sandbox`: here scripts and subresources are closed off, but the sandbox is not set.
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

/** A single range `bytes=a-b`, `a-` or `-n`. null = no Range; 'bad' = bad syntax or unsatisfiable range (416). */
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
  // O_NOFOLLOW: if the file was replaced by a link after realpath, the open fails; O_NONBLOCK: a FIFO does not block.
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

// ── Git revisions ─────

const GIT_ENV = (): Record<string, string | undefined> => ({
  ...cleanEnv(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PAGER']),
  GIT_TERMINAL_PROMPT: '0'
})
/** Global options: literal pathspecs and no index lock. Never a shell: arguments go to git as they are. */
const gitArgs = (repo: string, args: string[]) => ['-C', repo, '--no-optional-locks', '--literal-pathspecs', ...args]

function gitText(repo: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', gitArgs(repo, args), { env: GIT_ENV(), timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout).trim()))
  })
}

/** `<rev>:./<path>` (rev validated: hex or HEAD, cannot start with `-`; the path is a single literal argument, relative to the folder). */
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
  // The type is read from the first chunk of the blob: the rest keeps streaming.
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
    // A single decoding: `%252e%252e` stays the literal name "%2e%2e", never a `..`.
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

/** To be called after `app.ready`. */
export function registerFileProtocol(): void {
  protocol.handle(FILE_SCHEME, handle)
}
