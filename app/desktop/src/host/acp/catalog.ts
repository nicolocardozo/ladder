// Catalog of ACP agents: registry + curated list + CLIs found in the login shell's PATH + login known from the protocol.
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { normalize } from 'node:path'
import { t } from '@shared/i18n'
import type { AcpAgentSpec, AgentBlockCode, AgentCatalogEntry, AgentInstall, AgentLogin, AgentSignature } from '@shared/protocol'
import { agentEnv, whichInShell, whichManyInShell } from '../agents/common'
import { githubReleaseDigest, remoteSize } from '../downloads'
import { binaryTarget, checksumSource, hasUnsafeArgs, loadRegistry, pathSpec, type RegistryEntry } from './registry'

/**
 * Curated list, in the order it appears at the top of the catalog: registry id → executable to look for in the PATH,
 * the vendor's install page (`site`, pinned here) and where the archive may live (`hosts`, pinned here).
 * A host is `domain` (exact match) or `domain/path/` (github.com/<organization>/); `*.domain` also allows subdomains.
 * If the archive URL in the registry doesn't fit, the download is blocked (`host`). The hosts come from the registry's real URLs.
 * `cmd`: path of the program inside the archive (relative, normalized), pinned for the downloadable curated entries: a registry that changes it (e.g. to the `java` of an app's JDK) is blocked.
 * `team`: Apple TeamIdentifier pinned for vendors that ship a binary signed with a Developer ID (read from the real release binaries
 * and verified with codesign); the install requires exactly that team. Missing for ad hoc distributors (amp-acp, goose) or npx ones.
 */
export const CURATED: { id: string; exe: string; site: string; hosts: string[]; cmd?: string; team?: string }[] = [
  { id: 'gemini', exe: 'gemini', site: 'https://geminicli.com', hosts: ['github.com/google-gemini/'] },
  { id: 'cursor', exe: 'cursor-agent', site: 'https://cursor.com/cli', hosts: ['downloads.cursor.com'], cmd: 'dist-package/cursor-agent' },
  { id: 'github-copilot-cli', exe: 'copilot', site: 'https://github.com/features/copilot/cli/', hosts: ['github.com/github/'] },
  { id: 'opencode', exe: 'opencode', site: 'https://opencode.ai', hosts: ['github.com/anomalyco/'], cmd: 'opencode', team: '5NZ4Q7NXJ4' },
  // `amp` is Amp's CLI and doesn't speak ACP: the ACP adapter is `amp-acp`.
  { id: 'amp-acp', exe: 'amp-acp', site: 'https://github.com/tao12345666333/amp-acp', hosts: ['github.com/tao12345666333/'], cmd: 'amp-acp' },
  { id: 'goose', exe: 'goose', site: 'https://block.github.io/goose/', hosts: ['github.com/block/'], cmd: 'goose' },
  { id: 'cline', exe: 'cline', site: 'https://cline.bot/cli', hosts: ['github.com/cline/'] },
  { id: 'qwen-code', exe: 'qwen', site: 'https://qwenlm.github.io/qwen-code-docs/en/users/overview', hosts: ['github.com/QwenLM/'] },
  { id: 'kiro', exe: 'kiro-cli', site: 'https://kiro.dev/cli/', hosts: ['prod.download.cli.kiro.dev'], cmd: 'kirocli/bin/kiro-cli', team: '94KV3E626L' },
  { id: 'junie', exe: 'junie', site: 'https://junie.jetbrains.com', hosts: ['github.com/JetBrains/'], cmd: 'Applications/junie.app/Contents/MacOS/junie', team: '2ZEFAR8TH3' },
  // The registry only has npx: no archive URL to read, so the vendor's domain is used.
  { id: 'factory-droid', exe: 'droid', site: 'https://factory.ai/product/cli', hosts: ['factory.ai', '*.factory.ai'] },
  // npx only in the registry (@xai-official/grok, `agent stdio`); with `grok` in the PATH it starts as `grok agent stdio`.
  { id: 'grok-build', exe: 'grok', site: 'https://x.ai/cli', hosts: ['x.ai', '*.x.ai'] }
]

export const UNKNOWN_LOGIN: AgentLogin = { state: 'unknown', methods: [], checkedAt: null }

export interface CatalogDeps {
  /** ACP agents already added, by registry id. */
  specs: Map<string, AcpAgentSpec>
  login: (id: string) => AgentLogin
  installs: (id: string) => AgentInstall | null
  /** Checksum already recorded for a version downloaded by Ladder (null if never downloaded). */
  recorded: (id: string, version: string) => string | null
  /** Signature recorded when that version was installed (null if unknown). */
  signature: (id: string, version: string) => AgentSignature | null
}

/** Keyed by path and modification time; the promise avoids launching the same executable twice. */
const versions = new Map<string, { mtime: number; version: Promise<string | null> }>()

/** Runs `--version` with a timeout and, once expired, kills the whole process group (an ambiguous name like `goose` may do something else). */
async function runVersion(path: string): Promise<string | null> {
  const env = await agentEnv()
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const child = spawn(path, ['--version'], { env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const done = (value: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => {
      kill()
      done(null)
    }, 4000)
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      if (out.length > 64 * 1024) {
        kill()
        done(null)
      }
    })
    child.on('error', () => done(null))
    child.on('close', (code) => {
      const line = out.trim().split('\n')[0]?.trim() ?? ''
      done(code === 0 && line && line.length <= 80 ? line : null)
      // Any children left in the group must not survive.
      kill()
    })
  })
}

/** Version from `--version`: only for `agents.catalog`. The executable's name may belong to another program: the version is a hint, not proof. */
export function cliVersion(path: string): Promise<string | null> {
  let mtime = 0
  try {
    mtime = statSync(path).mtimeMs
  } catch {
    return Promise.resolve(null)
  }
  const known = versions.get(path)
  if (known && known.mtime === mtime) return known.version
  const version = runVersion(path)
  versions.set(path, { mtime, version })
  // A null result (timeout, error) is not cached: Rescan retries.
  void version.then((value) => {
    if (value === null && versions.get(path)?.version === version) versions.delete(path)
  })
  return version
}

/** CLIs of the curated agents present in the login shell's PATH: registry id → path. */
export async function detectCurated(): Promise<Map<string, string>> {
  const found = await whichManyInShell(CURATED.map((c) => c.exe))
  const out = new Map<string, string>()
  for (const c of CURATED) {
    const path = found.get(c.exe)
    if (path) out.set(c.id, path)
  }
  return out
}

/** Executable to use for a curated agent, if there is one. */
export function curatedExe(id: string): string | null {
  return CURATED.find((c) => c.id === id)?.exe ?? null
}

const httpsUrl = (value: string | undefined): string | null => (value && /^https:\/\/[^\s]+$/.test(value) ? value : null)

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** Text for an archive that Ladder does not download from the given address: states the address, or the scheme if it isn't https. */
export function hostReason(archive: string): string {
  try {
    const url = new URL(archive)
    if (url.protocol !== 'https:') return t('The registry points this download to an address that is not secure ({host}). Ladder only downloads over https.', { host: archive.length > 120 ? `${archive.slice(0, 120)}…` : archive })
    return t('The registry points this download to an address Ladder does not trust ({host}).', { host: url.host })
  } catch {
    return t('The registry points this download to an address Ladder does not trust ({host}).', { host: hostOf(archive) })
  }
}

/**
 * Id usable as a folder name; Ladder's own tools (gh, codex) have theirs. No `.`: an agent's temporary folders
 * are `<id>.download`, `<id>.new` and `<id>.old`, and an id like `gemini.new` would collide with them.
 */
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const isSafeAgentId = (id: string): boolean => SAFE_ID.test(id) && id !== 'gh' && id !== 'codex'

/** The most common multi-label public suffixes (the full Public Suffix List isn't bundled, to avoid a dependency): `a.co.uk` and `b.co.uk` are different vendors. */
const MULTI_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'net.nz', 'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'co.kr', 'or.kr', 'co.in', 'net.in', 'org.in', 'com.br', 'net.br', 'org.br', 'com.cn', 'net.cn', 'org.cn', 'com.hk', 'com.tw', 'com.sg', 'com.mx', 'com.ar', 'com.tr', 'co.za', 'co.il', 'co.id', 'co.th', 'com.my', 'com.ph', 'com.vn', 'com.ua', 'com.pl', 'com.es', 'com.pt', 'com.ru',
  'com.de', 'co.at', 'or.at', 'gv.at', 'ac.at', 'gov.br', 'edu.br', 'mil.br', 'gov.cn', 'edu.cn', 'ac.cn', 'edu.hk', 'gov.hk', 'org.hk', 'edu.tw', 'org.tw', 'gov.tw', 'edu.sg', 'gov.sg', 'org.sg', 'edu.mx', 'gob.mx', 'org.mx', 'net.mx', 'edu.ar', 'gob.ar', 'org.ar', 'net.ar', 'edu.tr', 'gov.tr', 'org.tr', 'net.tr', 'org.za', 'ac.za', 'gov.za', 'net.za', 'net.pl', 'org.pl', 'edu.pl', 'gov.pl', 'net.ua', 'org.ua', 'edu.ua', 'org.ru', 'net.ru', 'go.jp', 'go.kr', 'ne.kr', 'ac.kr', 'go.id', 'or.id', 'ac.id', 'web.id', 'ac.nz', 'govt.nz', 'gen.nz', 'ac.il', 'org.il', 'net.il', 'com.co', 'com.pe', 'com.ve', 'com.uy', 'com.ec', 'com.gt', 'com.bo', 'co.ke', 'co.tz', 'co.ug', 'co.zw', 'com.ng', 'com.eg', 'com.pk', 'com.bd', 'com.sa', 'com.qa', 'com.kw', 'com.lb', 'com.gr', 'com.cy', 'com.mt', 'com.hr', 'com.ro', 'co.hu', 'co.rs', 'com.fr', 'asso.fr', 'gouv.fr', 'co.cr'])

/** True if the host is an IP address (v4 or v6) or has a trailing dot: there is no "domain" to compare for these. */
const isIpOrDotted = (host: string): boolean => host.endsWith('.') || host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)

/** Domains shared by many owners: for these, "same domain" holds only with an identical host. */
const SHARED_SUFFIXES = new Set(['github.com', 'github.io', 'githubusercontent.com', 'githubassets.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'herokuapp.com', 'amazonaws.com', 'cloudfront.net', 'azurewebsites.net', 'web.app', 'firebaseapp.com', 'r2.dev',
  'gitlab.io', 'bitbucket.io', 'appspot.com', 'blogspot.com', 'googleapis.com', 'googleusercontent.com', 'azureedge.net', 'azurestaticapps.net', 'windows.net', 'trafficmanager.net', 'fly.dev', 'onrender.com', 'deno.dev', 'surge.sh', 'glitch.me', 'repl.co', 'replit.dev', 'railway.app', 'ondigitalocean.app', 'digitaloceanspaces.com', 'fastly.net', 'b-cdn.net', 'pythonanywhere.com', 'wordpress.com', 'wixsite.com', 'weebly.com', 'github.dev', 'codeberg.page', 'neocities.org', 'netlify.com', 'sourceforge.io',
  'gitlab.com', 'bitbucket.org', 'codeberg.org', 'sourceforge.net', 'gitee.com', 'huggingface.co'])

/** Approximate "registrable" domain: the last two labels, three under a known multi-label public suffix (co.uk…); shared domains stay whole. */
function baseDomain(host: string): string {
  const parts = host.toLowerCase().split('.')
  const base = parts.slice(-2).join('.')
  if (parts.length < 2 || SHARED_SUFFIXES.has(base)) return host.toLowerCase()
  // A host that is the suffix itself (`co.uk`) belongs to no one.
  if (MULTI_SUFFIXES.has(base)) return parts.length >= 3 ? parts.slice(-3).join('.') : host.toLowerCase()
  return base
}

/**
 * Address to show and confirm for a download: the host, and for github.com also `<owner>/<repository>` (the host alone
 * would say little: github.com belongs to everyone). Lowercase. It is what `download.host` exposes and what `agents.install` must send back.
 */
export function downloadAddress(archive: string): string {
  try {
    const url = new URL(archive)
    const host = url.host.toLowerCase()
    if (host !== 'github.com') return host
    const [owner, repo] = url.pathname.split('/').filter(Boolean)
    return owner && repo ? `${host}/${owner.toLowerCase()}/${repo.toLowerCase()}` : host
  } catch {
    return ''
  }
}

/** GitHub owner (lowercase) of a github.com/<owner>/… URL, if it is one. */
const githubOwner = (url: string | undefined): string | null => {
  try {
    const u = new URL(url ?? '')
    return u.host === 'github.com' ? (u.pathname.split('/')[1]?.toLowerCase() ?? null) || null : null
  } catch {
    return null
  }
}

/** Hosts where the path says who owns the file: for these, a non-curated entry must declare the same owner in its site or repository, as with github.com. */
const OWNER_HOSTS = new Set(['gitlab.com', 'bitbucket.org', 'codeberg.org', 'sourceforge.net', 'gitee.com', 'huggingface.co'])

/** Owner (lowercase) in the path of a URL on an OWNER_HOSTS host: the first segment, for SourceForge the project name in /projects/<name>/. */
function pathOwner(url: string | undefined): { host: string; owner: string } | null {
  try {
    const u = new URL(url ?? '')
    const host = u.host.toLowerCase()
    const parts = u.pathname.split('/').filter(Boolean)
    const owner = host === 'sourceforge.net' ? (parts[0] === 'projects' || parts[0] === 'p' ? parts[1] : undefined) : parts[0]
    return OWNER_HOSTS.has(host) && owner ? { host, owner: owner.toLowerCase() } : null
  } catch {
    return null
  }
}

/**
 * Can the archive be downloaded from here for this entry? Always https (standard port, no credentials).
 * - Curated: only the hosts pinned in `CURATED`.
 * - Others: github.com (release path; if the entry declares a GitHub repository, the same owner), gitlab.com, bitbucket.org,
 *   codeberg.org, sourceforge.net, gitee.com and huggingface.co (same owner declared in the site or repository), or a host
 *   on the same domain as the site or repository declared by the entry.
 */
export function downloadHostOk(entry: RegistryEntry, archive: string): boolean {
  let url: URL
  try {
    url = new URL(archive)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false
  const host = url.host.toLowerCase()
  if (isIpOrDotted(host)) return false
  const pins = CURATED.find((c) => c.id === entry.id)?.hosts
  if (pins) {
    return pins.some((pin) => {
      const [pinHost, ...rest] = pin.split('/')
      const path = rest.join('/')
      if (pinHost.startsWith('*.')) return !path && (host === pinHost.slice(2).toLowerCase() || host.endsWith(pinHost.slice(1).toLowerCase()))
      if (host !== pinHost.toLowerCase()) return false
      return !path || url.pathname.toLowerCase().startsWith(`/${path.toLowerCase()}`)
    })
  }
  if (host === 'github.com') {
    if (!/^\/[^/]+\/[^/]+\/releases\/download\//.test(url.pathname)) return false
    // Without an owner declared by the entry, any owner would do: don't download.
    const declared = githubOwner(entry.repository) ?? githubOwner(entry.website)
    return declared !== null && declared === url.pathname.split('/')[1].toLowerCase()
  }
  if (OWNER_HOSTS.has(host)) {
    const mine = pathOwner(archive)
    return mine !== null && [entry.website, entry.repository].some((declared) => {
      const d = pathOwner(declared)
      return d !== null && d.host === mine.host && d.owner === mine.owner
    })
  }
  return [entry.website, entry.repository].some((declared) => {
    const h = hostOf(declared ?? '').toLowerCase()
    return h !== '' && !isIpOrDotted(h) && (h === host || baseDomain(h) === baseDomain(host))
  })
}

/** True if the archive's program is the one pinned for the curated agent (the others have no pinned `cmd`). `cmd` is already normalized by `binaryTarget`. */
export function cmdPinnedOk(id: string, cmd: string): boolean {
  const pinned = CURATED.find((c) => c.id === id)?.cmd
  return pinned === undefined || normalize(pinned) === cmd
}

/** The wrong program for a curated agent: BlockError `signature` (no new code: the binary picked by the registry is not what Ladder expects). */
export function wrongCmdReason(): string {
  return t('The registry points this agent to a different program than the one Ladder expects, so Ladder will not install it.')
}

/** Vendor's install page: the pinned one for curated agents, otherwise the registry's site or repository. */
export function installUrlOf(entry: RegistryEntry): string | null {
  return CURATED.find((c) => c.id === entry.id)?.site ?? httpsUrl(entry.website) ?? httpsUrl(entry.repository)
}

/** Outcome of reading a GitHub release's checksum: read, not published (the asset has no `digest`) or not readable now (network, rate limit). */
type ReleaseDigest = { state: 'ok'; sha256: string; size: number | null } | { state: 'none' } | { state: 'unreadable' }

/** Checksum of a GitHub release, cached 5 minutes if read and 3 if not readable (the per-IP limit is 60 requests per hour). */
const digests = new Map<string, Promise<ReleaseDigest>>()
function releaseDigest(url: string): Promise<ReleaseDigest> {
  const known = digests.get(url)
  if (known) return known
  const value: Promise<ReleaseDigest> = githubReleaseDigest(url, AbortSignal.timeout(6000)).then(
    (d): ReleaseDigest => (d ? { state: 'ok', ...d } : { state: 'none' }),
    (): ReleaseDigest => ({ state: 'unreadable' })
  )
  digests.set(url, value)
  void value.then((v) =>
    setTimeout(() => {
      if (digests.get(url) === value) digests.delete(url)
    }, v.state === 'unreadable' ? 3 * 60_000 : 5 * 60_000).unref()
  )
  return value
}

/** Sizes from HEAD, kept 30 minutes (unknown ones too: a slow server must not be called again on every open). */
const sizes = new Map<string, Promise<number | null>>()
function archiveSize(url: string): Promise<number | null> {
  let size = sizes.get(url)
  if (!size) {
    size = remoteSize(url)
    sizes.set(url, size)
    const mine = size
    setTimeout(() => {
      if (sizes.get(url) === mine) sizes.delete(url)
    }, 30 * 60_000).unref()
  }
  return size
}

/** Forget the checksum and size read for an archive: the install rereads them on its own and the catalog must not show stale data (changed checksum, new attempt). */
export function forgetDownloadCache(url: string): void {
  digests.delete(url)
  sizes.delete(url)
}

/** Runs `fn` on all items with at most `limit` requests at once. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item)
  }))
}

/** The catalog: curated entries on top in the fixed order, then the rest of the registry by name. */
export async function agentCatalog(deps: CatalogDeps, onlyDetected = false): Promise<AgentCatalogEntry[]> {
  const entries = await loadRegistry()
  const detected = await detectCurated()
  const [npx, uvx] = onlyDetected ? [null, null] : await Promise.all([whichInShell('npx'), whichInShell('uvx')])
  // Versions only for the full catalog (the first launch just looks at paths), all together.
  const found = [...detected.entries()]
  const versionOf = new Map(onlyDetected ? [] : await Promise.all(found.map(async ([id, path]) => [id, await cliVersion(path)] as const)))
  const rank = (id: string) => CURATED.findIndex((c) => c.id === id)
  const sorted: RegistryEntry[] = [...entries].sort((a, b) => {
    const ra = rank(a.id)
    const rb = rank(b.id)
    if (ra >= 0 || rb >= 0) return (ra < 0 ? 1e6 : ra) - (rb < 0 ? 1e6 : rb)
    return a.name.localeCompare(b.name)
  })
  interface Draft {
    entry: RegistryEntry
    out: AgentCatalogEntry
    /** For binaries with a checksum: the data for the dialog is read later, in parallel. */
    archive: string | null
  }
  const drafts: Draft[] = []
  for (const entry of sorted) {
    const curated = rank(entry.id) >= 0
    const path = detected.get(entry.id) ?? null
    if (onlyDetected && !path) continue
    const spec = deps.specs.get(entry.id)
    const binary = binaryTarget(entry)
    const d = entry.distribution
    const installedBinary = spec?.distribution === 'binary' && existsSync(spec.command) ? spec : null
    const distribution: AgentCatalogEntry['distribution'] = d.npx ? 'npx' : d.uvx ? 'uvx' : binary ? 'binary' : null
    const checksum = binary ? checksumSource(binary) : null
    const hostOkay = binary ? downloadHostOk(entry, binary.archive) : false
    const recorded = binary && !hasUnsafeArgs(entry) ? deps.recorded(entry.id, entry.version) : null
    // Registry: the checksum is already here. GitHub release: read later (the conflict is evaluated then).
    const conflict = Boolean(recorded && binary?.sha256 && recorded !== binary.sha256)
    const offer = Boolean(binary && checksum !== 'missing' && isSafeAgentId(entry.id))
    const cmdOk = binary ? cmdPinnedOk(entry.id, binary.cmd) : true
    const blocked: AgentBlockCode | null = !binary ? null : !hostOkay ? 'host' : !cmdOk ? 'signature' : conflict ? 'checksum-conflict' : null
    let state: AgentCatalogEntry['state']
    let reason: string | null = null
    let reasonCode: AgentBlockCode | null = null
    if (installedBinary) state = 'detected'
    else if (hasUnsafeArgs(entry)) {
      state = 'unavailable'
      reason = t('The registry gives arguments or settings for this agent that Ladder does not accept.')
    } else if (path) state = 'detected'
    else if (d.npx || d.uvx) {
      const tool = d.npx ? npx : uvx
      state = onlyDetected || tool ? 'downloadable' : 'unavailable'
      if (state === 'unavailable') reason = d.npx ? t('Needs Node.js (npx), which was not found.') : t('Needs uv (uvx), which was not found.')
    } else if (!binary) {
      state = 'unavailable'
      reason = t('No build for Apple silicon Macs.')
    } else if (checksum === 'missing') {
      // No verifiable checksum: don't download; still usable if the CLI is already there (detected state above). Holds even if the address is untrusted: the link to the vendor's site is the way out.
      state = 'unavailable'
      reason = t('Install from the official site')
      reasonCode = 'no-checksum'
    } else if (blocked === 'host') {
      state = 'unavailable'
      reason = hostReason(binary.archive)
      reasonCode = 'host'
    } else if (blocked === 'signature') {
      state = 'unavailable'
      reason = wrongCmdReason()
      reasonCode = 'signature'
    } else if (blocked === 'checksum-conflict') {
      state = 'unavailable'
      reason = t('The registry now lists a different checksum for version {version}, which Ladder already downloaded. Ladder will not install it.', { version: entry.version })
      reasonCode = 'checksum-conflict'
    } else state = 'downloadable'
    // The id becomes a folder name: one that can't be would only fail at install time, better to say so right away.
    const idOk = isSafeAgentId(entry.id)
    if (state === 'downloadable' && distribution === 'binary' && !idOk) {
      state = 'unavailable'
      reason = t('Ladder can’t install this agent: its id can’t be used as a folder name.')
    }
    const installedInfo = installedBinary ? { version: installedBinary.version ?? entry.version, updateAvailable: (installedBinary.version ?? '') !== entry.version, signature: deps.signature(entry.id, installedBinary.version ?? entry.version) } : null
    drafts.push({
      entry,
      archive: offer && binary && distribution === 'binary' && !onlyDetected && (state === 'downloadable' || installedInfo?.updateAvailable) ? binary.archive : null,
      out: {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        registryVersion: entry.version,
        curated,
        state,
        reason,
        reasonCode,
        added: deps.specs.has(entry.id),
        docsUrl: httpsUrl(entry.website) ?? httpsUrl(entry.repository),
        installUrl: installUrlOf(entry),
        distribution,
        download: offer && binary ? { checksum: checksum!, sha256: binary.sha256 ?? null, host: downloadAddress(binary.archive), size: null, blocked } : null,
        detected: path ? { path, version: versionOf.get(entry.id) ?? null } : null,
        installed: installedInfo,
        login: deps.login(entry.id),
        install: deps.installs(entry.id)
      }
    })
  }
  // Archive size (HEAD) and, for GitHub releases, the checksum: only for what can be downloaded, never blocking.
  // The confirmation dialog is offered only with a known `sha256`: if the release doesn't publish it (`no-checksum`) or it can't be read
  // now (`checksum-unavailable`) the entry is not downloadable and `download.blocked` says so.
  await pool(
    drafts.filter((x) => x.archive && x.out.download && x.out.download.blocked !== 'host' && x.out.download.blocked !== 'signature'),
    6,
    async ({ entry, out, archive }) => {
      const download = out.download!
      const [digest, size] = await Promise.all([download.checksum === 'github-release' ? releaseDigest(archive!) : Promise.resolve(null), archiveSize(archive!)])
      download.size = size ?? (digest?.state === 'ok' ? digest.size : null)
      if (!digest) return
      if (digest.state === 'ok') {
        download.sha256 = digest.sha256
        const recorded = deps.recorded(entry.id, entry.version)
        if (recorded && recorded !== digest.sha256) {
          download.blocked = 'checksum-conflict'
          if (out.state === 'downloadable') {
            out.state = 'unavailable'
            out.reasonCode = 'checksum-conflict'
            out.reason = t('The registry now lists a different checksum for version {version}, which Ladder already downloaded. Ladder will not install it.', { version: entry.version })
          }
        }
        return
      }
      const code: AgentBlockCode = digest.state === 'none' ? 'no-checksum' : 'checksum-unavailable'
      download.blocked = code
      if (out.state === 'downloadable') {
        out.state = 'unavailable'
        out.reasonCode = code
        out.reason = code === 'no-checksum' ? t('Install from the official site') : t('Can’t read the checksum right now. Try again later.')
      }
    }
  )
  return drafts.map((x) => x.out)
}

/**
 * Entry to add for a registry agent: the already downloaded binary, then the CLI found in the PATH (curated only).
 * null in other cases: the npx/uvx fallback is chosen by the caller (`registrySpec`); without it, what's left is the binary to
 * download (installed first with `agents.install`).
 */
export async function resolveAgentSpec(entry: RegistryEntry, installed: AcpAgentSpec | undefined): Promise<AcpAgentSpec | null> {
  if (installed?.distribution === 'binary' && existsSync(installed.command)) return installed
  const exe = curatedExe(entry.id)
  const path = exe ? (await whichManyInShell([exe])).get(exe) : null
  if (path) return pathSpec(entry, path)
  return null
}
