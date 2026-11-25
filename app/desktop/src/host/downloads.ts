// Downloads of external tools (gh, Codex) into Ladder's data folder: HTTPS, SHA-256 checksum and archive extracted here.
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
 * Environment for processes that handle untrusted data (bsdtar, gzip, bzip2, xattr, codesign): PATH fixed to system binaries only, because
 * bsdtar launches as external filters the programs it finds in PATH (zstd, lz4, lzop…) and an archive can ask for them. UTF-8 locale, so
 * non-ASCII names are listed and extracted as they are (in the C locale bsdtar prints them as `\303\251` and does not convert them).
 */
const untrustedEnv = () => ({ ...cleanEnv(), PATH: '/usr/bin:/bin', LC_ALL: 'en_US.UTF-8' })
const tarEnv = untrustedEnv

/** Error with a stable code for the UI (AgentBlockCode): the installation's security blocks. */
export class BlockError extends Error {
  constructor(
    readonly code: AgentBlockCode,
    message: string
  ) {
    super(message)
  }
}

/** Download limits: the archive (counted as it arrives, even if the server sends no Content-Length), the extracted content and the number of entries. */
export const MAX_ARCHIVE_BYTES = 600 * 1024 * 1024
export const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_ENTRIES = 50_000
const tooLarge = () => new BlockError('too-large', t('The download is larger than Ladder allows.'))

/** Ladder's data folder (the same as the database). */
export function dataDir(): string {
  const db = process.env.LADDER_DB_PATH
  return db ? dirname(db) : join(process.env.HOME ?? '/tmp', '.ladder')
}

/** Downloaded tools live in `bin/<name>`. */
export function toolDir(name: string): string {
  return join(dataDir(), 'bin', name)
}

export interface ReleaseAsset {
  url: string
  /** SHA-256 in hex, from the GitHub API (`digest` field) or from the checksum file. */
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
 * Latest release of a GitHub repository and its asset. The checksum comes from the asset's `digest`; if missing,
 * from `checksums` (file contents with a "sha256  name" line per file).
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
      // Same source (the GitHub release), but with checks on redirects and on the outcome: an error page is not a checksum file.
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

/** Hosts a download may end up on after redirects, besides the URL's own: GitHub releases go through these CDNs. */
const DOWNLOAD_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']

/** A redirect hop is acceptable only over https, without credentials, on the standard port and on the starting host (or, for GitHub, its CDNs). */
function hopAllowed(origin: URL, next: URL): boolean {
  if (next.protocol !== 'https:' || next.username || next.password || (next.port && next.port !== '443')) return false
  return next.host === origin.host || (origin.host === 'github.com' && DOWNLOAD_HOSTS.includes(next.host))
}

/** fetch that follows redirects one at a time (at most 5) and checks every address, not just the last. Also returns the final URL. */
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

/** Size of the archive without downloading it (HEAD and Content-Length, 6 seconds): null if unknown or if something goes wrong. */
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
 * Downloads to `dest` with progress and verifies the SHA-256; if it does not match, the file is deleted. Past `maxBytes` it
 * stops (even without Content-Length: counted as it arrives). Redirect addresses are checked one at a time.
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
      // Progress reaches the UI at most 5 times per second.
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
 * Extracts the archive (zip or tar.gz) into an empty work folder and moves to `target` the first executable file
 * that `match` recognizes. The final folder is replaced only after a successful extraction.
 */
export async function extractBinary(archive: string, target: string, match: (relativePath: string) => boolean): Promise<void> {
  const work = `${target}.extract`
  await rm(work, { recursive: true, force: true })
  try {
    // Same checks as for ACP agents (paths, links, format): then only the executable is moved.
    await extractArchive(archive, work, basename(target))
    const found = await findFile(work, '', match)
    if (!found) throw new Error(t('The downloaded archive does not contain the expected program.'))
    await mkdir(dirname(target), { recursive: true })
    await rm(target, { force: true })
    await rename(join(work, found), target)
    await chmod(target, 0o755)
  } finally {
    // Work folder and archive are always removed, even if the executable is not there.
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

// ── ACP agent binaries ───────────────────────────────────────────────────────

/**
 * Checksum of an archive hosted on a GitHub release (`github.com/<user>/<repo>/releases/download/<tag>/<file>`):
 * the `digest` field of that release's asset. null if the URL is not a release's or the release does not publish it.
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
  // Tag gone (404): the release no longer exists, so no checksum is published (different from "not readable right now").
  const release = await getJson<GithubRelease>(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tagName)}`, signal).catch((error: { status?: number }) => {
    if (error.status === 404) return null
    throw error
  })
  if (!release) return null
  const asset = (release.assets ?? []).find((a) => a.name === name)
  const sha = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest ?? '')?.[1]
  return sha ? { sha256: sha.toLowerCase(), size: asset?.size ?? null } : null
}

/** Relative path of the program in the archive: no absolute paths, no `..`, no odd characters. */
export function safeRelativePath(cmd: string): string | null {
  if (!cmd || cmd.length > 512 || isAbsolute(cmd) || /[\0\n\r]/.test(cmd)) return null
  const clean = normalize(cmd)
  if (clean === '.' || clean.split(sep).includes('..')) return null
  return clean
}

const MACHO = new Set(['cffaedfe', 'cefaedfe', 'cafebabe', 'cafebabf', 'feedface', 'feedfacf'])

/** Start of the formats bsdtar recognizes on its own and treats as a filter (external program) or as another archive: a tar whose first name starts like this is not accepted. */
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
    [0x71, 0xc7], // binary cpio
  ...['LRZI', 'LZIP', 'GRZipII', '#mtree', 'Rar!', 'MSCF', 'xar!', '!<arch>', '070701', '070702', '070707', 'begin '].map((m) => [...Buffer.from(m, 'latin1')])
]

/** True if the head (512 bytes) is a valid ustar header: magic, checksum (bytes 148-155, sum of the header with the field as spaces) and does not start like a known filter. */
export function isUstarHead(buf: Buffer): boolean {
  if (buf.length < 512 || buf.toString('latin1', 257, 262) !== 'ustar') return false
  if (FILTER_MAGICS.some((m) => m.every((byte, i) => buf[i] === byte))) return false
  // Skippable zstd and lz4 frames: the first byte ranges from 0x50 to 0x5f, then 2a 4d 18.
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

/** True if the file name in the URL (or the `file=` parameter) has an archive or compression extension. */
function hasArchiveExtension(url: string): boolean {
  try {
    const u = new URL(url)
    return [u.pathname, u.searchParams.get('file') ?? ''].some((p) => /\.(zip|tar|tgz|gz|bz2|tbz2?|xz|txz|zst|lz4|7z|rar|dmg|pkg)$/i.test(p))
  } catch {
    return true
  }
}

const entryOk = (entry: string) => !isAbsolute(entry) && !entry.includes('\0') && !normalize(entry).split(sep).includes('..')

/** Comparison key for a path: macOS disks do not distinguish case or Unicode forms (NFC/NFD), so `A/x` and `a/x` are the same place. */
const folded = (entry: string) =>
  normalize(entry)
    .replace(/\/+$/, '')
    .normalize('NFD')
    .toLowerCase()

/**
 * No entry may sit under another entry that is not a folder (tar could write through a link created earlier).
 * `types` are the types read from `tar -tv` (first character of each line: `d` folder); names are compared case-insensitively and in NFD.
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

/** Runs a program (never a shell) and passes each output line to `onLine`; if `onLine` throws, the process stops and the error propagates. 120 seconds at most. */
function spawnLines(file: string, args: string[], onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: tarEnv(), stdio: ['ignore', 'pipe', 'ignore'], signal, timeout: 120_000 })
    let rest = ''
    let failure: unknown = null
    // With stream encoding, a multibyte character split between two chunks does not become U+FFFD (the two reads, -tf and -tvf, must give the same names).
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
 * Archive listing with bsdtar, the same program that later extracts (with another program the names in a zip's central
 * directory and those in the local headers might not match): names from `-tf` and, line by line, types and
 * sizes from `-tvf`. Stops as soon as a limit is exceeded (zip bomb). Rejects hard links and special files.
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
      // bsdtar prints control characters and backslash as an escape sequence: such a name is not a program's file.
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
        // "-rw-r--r--  0 user group  12345 Jan  1 00:00 name": first character = type, 5th field = size.
        if (!/^[-dlhcbps?][-rwxsStT?]{9}/.test(line)) return
        if ('hcbps'.includes(line[0])) throw notSafe
        // The size is read from the right: with the name removed (known from `-tf`, same index) what remains is `... size user date`. uname and gname
        // may contain spaces and numbers (even a fake date), so we do not count by field nor use an expression that starts from the left.
        // A link has no content and its "-> target" is chosen by whoever creates the archive: size counts only for the other entries.
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
  // The two reads must see the same entries, in the same order.
  if (entries.length !== types.length) throw notSafe
  return { entries, types }
}

/** First 512 bytes of the decompressed content of a gzip or bzip2 (stops there): used to check that only a tar is inside. */
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

/** Extracts with a periodic check on the content: if it exceeds the limits (real size, not the declared one) the process stops. */
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
      // Final check: the timer's last tick may not have seen the end.
      measure(dest)
        .then(({ bytes, entries }) => {
          if (bytes > MAX_EXTRACTED_BYTES || entries > MAX_ENTRIES) reject(tooLarge())
          else code === 0 ? resolve() : reject(new Error(t('{program} stopped with code {code}.', { program: basename(file), code: String(code) })))
        })
        .catch(reject)
    })
  })
}

/** Bytes and entries of a folder, without following links. */
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
 * Extracts the archive (zip, tar, tar.gz, tar.bz2) into `dest`, a new folder, always with bsdtar (listing and extraction with the same
 * program); the format is recognized from the first bytes and not from the extension, and inside gzip/bzip2 there must be a tar. It first reads the listing and rejects absolute paths or paths with `..`, symlinks in zips, hard links,
 * special files and entries under a file, and stops everything if the declared sizes or the entries exceed the limits; during
 * extraction it also checks the real size (zip bombs with false headers). Afterwards it rejects every symlink
 * that, followed all the way, leads outside `dest` or has an absolute target, every file with multiple links and every special file; it removes
 * from ALL regular files the execute, setuid and setgid bits (execute permission is then granted by the installer, only to the expected file).
 * A file that is not an archive is accepted only if it is a Mach-O executable or if `sourceUrl` has no archive
 * extension: `rawName` is the relative path to put it in. Other formats (tar.xz, tar.zst, non-tar gz…) are rejected.
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
  // Inside gzip and bzip2 there must be a tar: bsdtar recognizes other filters on its own (lrzip, lzop, grzip) and would launch them as external programs.
  if (kind === 'gzip' || kind === 'bzip2') {
    const head = await decompressedHead(kind === 'gzip' ? '/usr/bin/gzip' : '/usr/bin/bzip2', archive)
    if (!isUstarHead(head)) throw new Error(t('The downloaded file is in a format Ladder can’t unpack.'))
  }
  // Listing and extraction with the same program (bsdtar, also for zips). Symlinks in zips are of no use to a program: they are rejected (`l` in `-tv`).
  const { entries, types } = await listArchive(archive, signal)
  if (!entries.every(entryOk) || !noFileParents(entries, types)) throw unsafe()
  if (kind === 'zip' && types.includes('l')) throw unsafe()
  // Without extended attributes, ACLs and macOS metadata (AppleDouble): only data and permissions; bsdtar's defaults already reject `..` and strip the leading `/`.
  await extractLimited('/usr/bin/tar', ['--no-xattrs', '--no-acls', '--no-mac-metadata', '-xf', archive, '-C', dest], dest, signal)
  // Paths from the realpath of `dest`: if the data folder goes through a link (/tmp → /private/tmp) internal links remain valid.
  const root = await realpath(dest)
  await assertSafeTree(root, root)
}

/** Deletes a temporary folder even if the archive left folders without permissions in it (mode 0000): reopens u+rwx, without following links, only inside `path`. */
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

/** Inside `dir`: relative symlinks that stay within the root (followed all the way), no special files or files with multiple links; every regular file loses execute, setuid and setgid. */
async function assertSafeTree(dir: string, root: string): Promise<void> {
  const unsafe = () => new Error(t('The downloaded archive is not safe to extract.'))
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      // Only relative links: an absolute one points outside the tree whatever exists today at that path.
      const to = await readlink(path)
      if (isAbsolute(to)) throw unsafe()
      // The link text must not climb above the root even by one step: after the folder swap (`<id>.new` becomes `<id>`) a link that
      // goes through the temporary folder name (`../../<id>.new/x`) would point to a place that no longer exists.
      const up = normalize(join(relative(root, dirname(path)), to))
      if (up === '..' || up.startsWith(`..${sep}`)) throw unsafe()
      // With realpath, chained links are followed too (a → b/.. → outside), which a check on the link text alone does not see.
      const real = await realpath(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw unsafe()
        // A link that leads nowhere: the link text counts, and it must stay inside.
        return resolve(dirname(path), to)
      })
      if (real !== root && !real.startsWith(root + sep)) throw unsafe()
    } else if (info.isDirectory()) {
      // A folder without permissions (mode 0000 in the tar) can be neither read nor deleted: reopen it for the owner before entering.
      if ((info.mode & 0o700) !== 0o700) await chmod(path, info.mode | 0o700)
      await assertSafeTree(path, root)
    }
    else if (!info.isFile() || info.nlink > 1) throw unsafe()
    else if (info.mode & 0o7111) await chmod(path, info.mode & 0o666)
  }
}

/** Absolute path of the program inside `root`, provided it is a file and (even following links) stays inside `root`. */
export async function resolveInside(root: string, cmd: string): Promise<string> {
  const rel = safeRelativePath(cmd)
  if (!rel) throw new Error(t('The registry gives an unsafe path for the program.'))
  const full = join(root, rel)
  const real = await realpath(full).catch(() => null)
  const realRoot = await realpath(root)
  if (!real || !real.startsWith(realRoot + sep) || !(await lstat(real)).isFile()) throw new Error(t('The downloaded archive does not contain the expected program.'))
  return full
}

/** True if the file carries the macOS quarantine attribute (Gatekeeper would evaluate it at launch). */
export async function hasQuarantine(path: string): Promise<boolean> {
  try {
    await run('/usr/bin/xattr', ['-p', 'com.apple.quarantine', path], { env: untrustedEnv(), timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/** The `.app` bundle that contains the program (inside `root`), if any: an app's signature is verified on the whole bundle. */
function enclosingApp(root: string, program: string): string | null {
  const parts = program.slice(root.length + 1).split(sep)
  const index = parts.findIndex((part) => part.endsWith('.app'))
  return index >= 0 ? join(root, ...parts.slice(0, index + 1)) : null
}

/**
 * Folders of an `.app` where the program to launch lives (the rest, like Contents/Resources, may have files outside the seal). `Contents/runtime`
 * and `Contents/jbr` are excluded: they contain the JDK (a vendor-signed `java` accepts `-XX:OnOutOfMemoryError=…`), and the program is
 * anyway fixed for every downloadable curated agent (`CURATED.cmd`).
 */
const APP_EXECUTABLE_DIRS = ['Contents/MacOS', 'Contents/Helpers', 'Contents/Frameworks']

/** True if the file starts with a Mach-O signature (or a universal binary's). */
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
 * Requirement on the certificate: the chain must reach Apple (`anchor apple generic`) and the leaf be a Developer ID
 * Application (OID 1.2.840.113635.100.6.1.13); Apple system binaries pass with `anchor apple`. Without it, the name
 * inside the certificate can be written by anyone: a self-signed "Developer ID Application: Google LLC" certificate passes
 * `--verify` (which only checks integrity).
 */
const SIGNER_REQUIREMENT = 'anchor apple or (anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists)'

/**
 * Signature of the program (or of the app that contains it) with `codesign`, without running it. It works on the program's realpath: if `cmd`
 * is a link to an executable inside an `.app`, the signature is verified on the bundle and on the program.
 * - Unsigned: `unsigned`; ad hoc: `adhoc`. They are installed anyway.
 * - Broken signature (`--verify --deep --strict` fails) or `codesign` does not respond: BlockError `signature`.
 * - Intact signature and Apple/Developer ID requirement satisfied: `signed`, with signer and team. If the program is inside an `.app` it must also be
 *   in one of the app's executable folders, be a Mach-O and satisfy the same requirement on its own (otherwise `signature`, or `team` if the team is fixed);
 *   signer and team are those of the program's certificate.
 * - Intact signature but requirement not satisfied (self-signed, non-Apple chain, non-Developer ID certificate): `unverified`,
 *   with no signer or team (the name in the certificate is not trustworthy).
 * Signer and team are NOT read from the text of `codesign -d`: the Identifier is chosen by whoever signs and may contain newlines, with fake
 * `TeamIdentifier=`/`Authority=` lines before the real ones. They are read from the extracted leaf certificate (`--extract-certificates`),
 * already verified by the requirement. `expectedTeam` (curated agents with a team fixed in Ladder): the team is inside the requirement
 * (`certificate leaf[subject.OU]`), so codesign checks it on the certificate; if it is not satisfied (unsigned, ad hoc or another
 * team) it is BlockError `team`.
 */
export async function codeSignature(root: string, program: string, expectedTeam?: string): Promise<AgentSignature> {
  const realRoot = await realpath(root)
  const realProgram = await realpath(program)
  const target = enclosingApp(realRoot, realProgram) ?? realProgram
  const opts = { env: untrustedEnv(), timeout: 60_000, maxBuffer: 1024 * 1024 }
  const bad = () => new BlockError('signature', t('The program is signed but its signature does not verify.'))
  const wrongTeam = () => new BlockError('team', t('The program is not signed by the developer Ladder expects for this agent.'))
  // The team ends up inside a codesign requirement: only the TeamIdentifier format.
  if (expectedTeam !== undefined && !/^[A-Z0-9]{10}$/.test(expectedTeam)) throw wrongTeam()
  let info: string
  try {
    // `-d` writes to stderr; here it only serves to tell "unsigned" from "ad hoc".
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
  // Intact signature: does the certificate chain to Apple and is it a Developer ID (and, if fixed, of the expected team)? (`-R=` with the requirement attached: it is the form codesign accepts.)
  const requirement = expectedTeam ? `anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${expectedTeam}"` : SIGNER_REQUIREMENT
  const trusted = await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=${requirement}`, target], opts).then(
    () => true,
    () => false
  )
  if (!trusted) {
    if (expectedTeam) throw wrongTeam()
    // Ad hoc or without certificates: the Signature field tells (at worst a fake line swaps adhoc and unverified, which show no names).
    return { state: /^Signature=adhoc$/m.test(info) ? 'adhoc' : 'unverified', signer: null, team: null }
  }
  // The program inside an app: the bundle's signature is not enough. The standard seal rules (rules2) exclude paths like `.DS_Store` or
  // `PkgInfo`, where whoever publishes a release without the signing key can put any executable and have `cmd` point to it. So the program
  // must be where an app keeps its executables, be a Mach-O and pass the same requirement on its own; signer and team are read from its certificate.
  if (target !== realProgram) {
    const inside = realProgram.slice(target.length + 1)
    if (!APP_EXECUTABLE_DIRS.some((dir) => inside.startsWith(`${dir}/`)) || !(await isMachO(realProgram))) throw bad()
    await run('/usr/bin/codesign', ['--verify', '--strict', `-R=${requirement}`, realProgram], opts).catch(() => {
      throw expectedTeam ? wrongTeam() : bad()
    })
  }
  const leaf = await leafSubject(realProgram, opts)
  // These are lines of text shown to the user: short and without control characters.
  const clean = (value: string | null) => (value && value.length <= 200 && !/[\u0000-\u001f]/.test(value) ? value : null)
  return { state: 'signed', signer: clean(leaf.cn), team: expectedTeam ?? clean(leaf.ou) }
}

/**
 * Value of a distinguished name (RFC 2253) as Node writes it in `cert.subject`: `\,` `\+` `\;` `\"` `\\` `\<` `\>` `\=` `\#` and `\XX` (hex bytes of UTF-8)
 * turn back into the character; the quotes around the whole value are removed.
 */
export function unescapeDn(value: string): string {
  const quoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"') && !value.endsWith('\\"') ? value.slice(1, -1) : value
  return quoted.replace(/((?:\\[0-9a-fA-F]{2})+)|\\([\s\S])/g, (_, hex: string | undefined, char: string) => (hex ? Buffer.from(hex.replaceAll('\\', ''), 'hex').toString('utf8') : char))
}

/** Common name and organizational unit (team) of the signature's leaf certificate, read from the certificate and not from codesign's output. */
async function leafSubject(target: string, opts: { env: Record<string, string | undefined>; timeout: number; maxBuffer: number }): Promise<{ cn: string | null; ou: string | null }> {
  const dir = await mkdtemp(join(tmpdir(), 'ladder-cert-'))
  try {
    await run('/usr/bin/codesign', ['-d', `--extract-certificates=${join(dir, 'c')}`, target], opts)
    // Certificates are `c0` (leaf), `c1`… in DER.
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
