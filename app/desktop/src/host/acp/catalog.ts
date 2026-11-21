// Catalogo degli agenti ACP (LAD-56): registro + elenco curato + CLI rilevate nel PATH della shell di login + login noto dal protocollo.
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { normalize } from 'node:path'
import { t } from '@shared/i18n'
import type { AcpAgentSpec, AgentBlockCode, AgentCatalogEntry, AgentInstall, AgentLogin, AgentSignature } from '@shared/protocol'
import { agentEnv, whichInShell, whichManyInShell } from '../agents/common'
import { githubReleaseDigest, remoteSize } from '../downloads'
import { binaryTarget, checksumSource, hasUnsafeArgs, loadRegistry, pathSpec, type RegistryEntry } from './registry'

/**
 * Elenco curato, nell'ordine in cui compare in cima al catalogo: id del registro → eseguibile da cercare nel PATH,
 * pagina d'installazione del vendor (`site`, fissata qui) e dove può stare l'archivio (`hosts`, fissati qui).
 * Un host è `dominio` (uguale) o `dominio/percorso/` (github.com/<organizzazione>/); `*.dominio` ammette anche i sottodomini.
 * Se l'URL dell'archivio nel registro non rientra, il download è bloccato (`host`). Gli host vengono dagli URL reali del registro.
 * `cmd`: percorso del programma nell'archivio (relativo, normalizzato) fissato per i curati scaricabili: un registro che lo cambia (es. verso il `java` del JDK di un'app) è bloccato.
 * `team`: TeamIdentifier Apple fissato per chi distribuisce un binario firmato con Developer ID (letto dai binari reali della release
 * e verificato con codesign); l'installazione richiede quel team esatto. Mancano per chi distribuisce ad hoc (amp-acp, goose) o via npx.
 */
export const CURATED: { id: string; exe: string; site: string; hosts: string[]; cmd?: string; team?: string }[] = [
  { id: 'gemini', exe: 'gemini', site: 'https://geminicli.com', hosts: ['github.com/google-gemini/'] },
  { id: 'cursor', exe: 'cursor-agent', site: 'https://cursor.com/cli', hosts: ['downloads.cursor.com'], cmd: 'dist-package/cursor-agent' },
  { id: 'github-copilot-cli', exe: 'copilot', site: 'https://github.com/features/copilot/cli/', hosts: ['github.com/github/'] },
  { id: 'opencode', exe: 'opencode', site: 'https://opencode.ai', hosts: ['github.com/anomalyco/'], cmd: 'opencode', team: '5NZ4Q7NXJ4' },
  // `amp` è la CLI di Amp e non parla ACP: l'adattatore ACP è `amp-acp`.
  { id: 'amp-acp', exe: 'amp-acp', site: 'https://github.com/tao12345666333/amp-acp', hosts: ['github.com/tao12345666333/'], cmd: 'amp-acp' },
  { id: 'goose', exe: 'goose', site: 'https://block.github.io/goose/', hosts: ['github.com/block/'], cmd: 'goose' },
  { id: 'cline', exe: 'cline', site: 'https://cline.bot/cli', hosts: ['github.com/cline/'] },
  { id: 'qwen-code', exe: 'qwen', site: 'https://qwenlm.github.io/qwen-code-docs/en/users/overview', hosts: ['github.com/QwenLM/'] },
  { id: 'kiro', exe: 'kiro-cli', site: 'https://kiro.dev/cli/', hosts: ['prod.download.cli.kiro.dev'], cmd: 'kirocli/bin/kiro-cli', team: '94KV3E626L' },
  { id: 'junie', exe: 'junie', site: 'https://junie.jetbrains.com', hosts: ['github.com/JetBrains/'], cmd: 'Applications/junie.app/Contents/MacOS/junie', team: '2ZEFAR8TH3' },
  // Nel registro è solo npx: nessun URL di archivio da leggere, quindi il dominio del vendor.
  { id: 'factory-droid', exe: 'droid', site: 'https://factory.ai/product/cli', hosts: ['factory.ai', '*.factory.ai'] }
]

export const UNKNOWN_LOGIN: AgentLogin = { state: 'unknown', methods: [], checkedAt: null }

export interface CatalogDeps {
  /** Agenti ACP già aggiunti, per id del registro. */
  specs: Map<string, AcpAgentSpec>
  login: (id: string) => AgentLogin
  installs: (id: string) => AgentInstall | null
  /** Checksum già registrato per una versione scaricata da Ladder (null se mai scaricata). */
  recorded: (id: string, version: string) => string | null
  /** Firma registrata all'installazione di quella versione (null se ignota). */
  signature: (id: string, version: string) => AgentSignature | null
}

/** Per percorso e data di modifica; la promessa evita di lanciare due volte lo stesso eseguibile. */
const versions = new Map<string, { mtime: number; version: Promise<string | null> }>()

/** Esegue `--version` con tempo massimo e, scaduto, ferma tutto il gruppo di processi (un nome ambiguo come `goose` può fare altro). */
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
      // Eventuali figli rimasti nel gruppo non devono sopravvivere.
      kill()
    })
  })
}

/** Versione da `--version`: solo per `agents.catalog`. Il nome dell'eseguibile può essere un altro programma: la versione è un'indicazione, non una prova. */
function cliVersion(path: string): Promise<string | null> {
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
  // Un esito nullo (timeout, errore) non resta in cache: il Rescan riprova.
  void version.then((value) => {
    if (value === null && versions.get(path)?.version === version) versions.delete(path)
  })
  return version
}

/** CLI degli agenti curati presenti nel PATH della shell di login: id del registro → percorso. */
export async function detectCurated(): Promise<Map<string, string>> {
  const found = await whichManyInShell(CURATED.map((c) => c.exe))
  const out = new Map<string, string>()
  for (const c of CURATED) {
    const path = found.get(c.exe)
    if (path) out.set(c.id, path)
  }
  return out
}

/** Eseguibile da usare per un agente curato, se c'è. */
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

/** Testo per un archivio che Ladder non scarica dall'indirizzo dato: dice l'indirizzo, oppure lo schema se non è https. */
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
 * Id usabile come nome di cartella; gli strumenti di Ladder (gh, codex) hanno la loro. Niente `.`: le cartelle temporanee
 * di un agente sono `<id>.download`, `<id>.new` e `<id>.old`, e un id come `gemini.new` ci si scontrerebbe.
 */
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const isSafeAgentId = (id: string): boolean => SAFE_ID.test(id) && id !== 'gh' && id !== 'codex'

/** Suffissi pubblici a più etichette più comuni (la Public Suffix List completa non c'è: nessuna dipendenza che la porti): `a.co.uk` e `b.co.uk` sono vendor diversi. */
const MULTI_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'net.nz', 'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'co.kr', 'or.kr', 'co.in', 'net.in', 'org.in', 'com.br', 'net.br', 'org.br', 'com.cn', 'net.cn', 'org.cn', 'com.hk', 'com.tw', 'com.sg', 'com.mx', 'com.ar', 'com.tr', 'co.za', 'co.il', 'co.id', 'co.th', 'com.my', 'com.ph', 'com.vn', 'com.ua', 'com.pl', 'com.es', 'com.pt', 'com.ru',
  'com.de', 'co.at', 'or.at', 'gv.at', 'ac.at', 'gov.br', 'edu.br', 'mil.br', 'gov.cn', 'edu.cn', 'ac.cn', 'edu.hk', 'gov.hk', 'org.hk', 'edu.tw', 'org.tw', 'gov.tw', 'edu.sg', 'gov.sg', 'org.sg', 'edu.mx', 'gob.mx', 'org.mx', 'net.mx', 'edu.ar', 'gob.ar', 'org.ar', 'net.ar', 'edu.tr', 'gov.tr', 'org.tr', 'net.tr', 'org.za', 'ac.za', 'gov.za', 'net.za', 'net.pl', 'org.pl', 'edu.pl', 'gov.pl', 'net.ua', 'org.ua', 'edu.ua', 'org.ru', 'net.ru', 'go.jp', 'go.kr', 'ne.kr', 'ac.kr', 'go.id', 'or.id', 'ac.id', 'web.id', 'ac.nz', 'govt.nz', 'gen.nz', 'ac.il', 'org.il', 'net.il', 'com.co', 'com.pe', 'com.ve', 'com.uy', 'com.ec', 'com.gt', 'com.bo', 'co.ke', 'co.tz', 'co.ug', 'co.zw', 'com.ng', 'com.eg', 'com.pk', 'com.bd', 'com.sa', 'com.qa', 'com.kw', 'com.lb', 'com.gr', 'com.cy', 'com.mt', 'com.hr', 'com.ro', 'co.hu', 'co.rs', 'com.fr', 'asso.fr', 'gouv.fr', 'co.cr'])

/** Vero se l'host è un indirizzo IP (v4 o v6) o ha il punto finale: per questi non esiste un "dominio" da confrontare. */
const isIpOrDotted = (host: string): boolean => host.endsWith('.') || host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)

/** Domini condivisi da molti proprietari: per questi "stesso dominio" vale solo con l'host identico. */
const SHARED_SUFFIXES = new Set(['github.com', 'github.io', 'githubusercontent.com', 'githubassets.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'herokuapp.com', 'amazonaws.com', 'cloudfront.net', 'azurewebsites.net', 'web.app', 'firebaseapp.com', 'r2.dev',
  'gitlab.io', 'bitbucket.io', 'appspot.com', 'blogspot.com', 'googleapis.com', 'googleusercontent.com', 'azureedge.net', 'azurestaticapps.net', 'windows.net', 'trafficmanager.net', 'fly.dev', 'onrender.com', 'deno.dev', 'surge.sh', 'glitch.me', 'repl.co', 'replit.dev', 'railway.app', 'ondigitalocean.app', 'digitaloceanspaces.com', 'fastly.net', 'b-cdn.net', 'pythonanywhere.com', 'wordpress.com', 'wixsite.com', 'weebly.com', 'github.dev', 'codeberg.page', 'neocities.org', 'netlify.com', 'sourceforge.io',
  'gitlab.com', 'bitbucket.org', 'codeberg.org', 'sourceforge.net', 'gitee.com', 'huggingface.co'])

/** Dominio "registrabile" approssimato: le ultime due etichette, tre sotto un suffisso pubblico noto a più etichette (co.uk…); i domini condivisi restano interi. */
function baseDomain(host: string): string {
  const parts = host.toLowerCase().split('.')
  const base = parts.slice(-2).join('.')
  if (parts.length < 2 || SHARED_SUFFIXES.has(base)) return host.toLowerCase()
  // Un host che è il suffisso stesso (`co.uk`) non è di nessuno.
  if (MULTI_SUFFIXES.has(base)) return parts.length >= 3 ? parts.slice(-3).join('.') : host.toLowerCase()
  return base
}

/**
 * Indirizzo da mostrare e da confermare per un download: l'host, e per github.com anche `<proprietario>/<repository>` (l'host da solo
 * direbbe poco: github.com è di tutti). Minuscolo. È quello che `download.host` espone e che `agents.install` deve rimandare.
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

/** Proprietario GitHub (minuscolo) di un URL github.com/<proprietario>/…, se lo è. */
const githubOwner = (url: string | undefined): string | null => {
  try {
    const u = new URL(url ?? '')
    return u.host === 'github.com' ? (u.pathname.split('/')[1]?.toLowerCase() ?? null) || null : null
  } catch {
    return null
  }
}

/** Host dove il percorso dice di chi è il file: per questi un non curato deve dichiarare lo stesso proprietario nel sito o nel repository, come per github.com. */
const OWNER_HOSTS = new Set(['gitlab.com', 'bitbucket.org', 'codeberg.org', 'sourceforge.net', 'gitee.com', 'huggingface.co'])

/** Proprietario (minuscolo) nel percorso di un URL su un host OWNER_HOSTS: il primo segmento, per SourceForge il nome del progetto in /projects/<nome>/. */
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
 * L'archivio si può scaricare da qui per questa voce? Sempre https (porta standard, senza credenziali).
 * - Curati: solo gli host fissati in `CURATED`.
 * - Altri: github.com (percorso di release; se la voce dichiara un repository GitHub, lo stesso proprietario), gitlab.com, bitbucket.org,
 *   codeberg.org, sourceforge.net, gitee.com e huggingface.co (stesso proprietario dichiarato nel sito o nel repository) oppure un host
 *   dello stesso dominio del sito o del repository dichiarati dalla voce.
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
    // Senza un proprietario dichiarato dalla voce, qualunque proprietario andrebbe bene: non si scarica.
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

/** Vero se il programma dell'archivio è quello fissato per l'agente curato (gli altri non hanno un `cmd` fissato). `cmd` è già normalizzato da `binaryTarget`. */
export function cmdPinnedOk(id: string, cmd: string): boolean {
  const pinned = CURATED.find((c) => c.id === id)?.cmd
  return pinned === undefined || normalize(pinned) === cmd
}

/** Il programma sbagliato per un curato: BlockError `signature` (nessun codice nuovo: il binario scelto dal registro non è quello che Ladder si aspetta). */
export function wrongCmdReason(): string {
  return t('The registry points this agent to a different program than the one Ladder expects, so Ladder will not install it.')
}

/** Pagina d'installazione del vendor: quella fissata per i curati, altrimenti sito o repository del registro. */
export function installUrlOf(entry: RegistryEntry): string | null {
  return CURATED.find((c) => c.id === entry.id)?.site ?? httpsUrl(entry.website) ?? httpsUrl(entry.repository)
}

/** Esito della lettura del checksum di una release GitHub: letto, non pubblicato (l'asset non ha `digest`) o non leggibile ora (rete, limite di richieste). */
type ReleaseDigest = { state: 'ok'; sha256: string; size: number | null } | { state: 'none' } | { state: 'unreadable' }

/** Checksum di una release GitHub, 5 minuti se letto e 3 se non leggibile (il limite per IP è di 60 richieste all'ora). */
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

/** Dimensioni dall'HEAD, tenute 30 minuti (anche quelle ignote: un server lento non va richiamato a ogni apertura). */
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

/** Dimenticare checksum e dimensione letti per un archivio: l'installazione li rilegge da sé e il catalogo non deve mostrare dati vecchi (checksum cambiato, nuovo tentativo). */
export function forgetDownloadCache(url: string): void {
  digests.delete(url)
  sizes.delete(url)
}

/** Esegue `fn` su tutti gli elementi con al massimo `limit` richieste insieme. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item)
  }))
}

/** Il catalogo: i curati in cima nell'ordine fisso, poi il resto del registro per nome. */
export async function agentCatalog(deps: CatalogDeps, onlyDetected = false): Promise<AgentCatalogEntry[]> {
  const entries = await loadRegistry()
  const detected = await detectCurated()
  const [npx, uvx] = onlyDetected ? [null, null] : await Promise.all([whichInShell('npx'), whichInShell('uvx')])
  // Le versioni solo per il catalogo completo (il primo avvio guarda i percorsi e basta), tutte insieme.
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
    /** Per i binari con checksum: i dati per il dialog si leggono dopo, in parallelo. */
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
    // Registro: il checksum è già qui. Release GitHub: si legge dopo (il conflitto si valuta allora).
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
      // Nessun checksum verificabile: non si scarica; resta usabile se la CLI c'è già (stato detected sopra). Vale anche se l'indirizzo non è fidato: il link al sito del vendor è la via d'uscita.
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
    // L'id diventa il nome di una cartella: uno che non lo può essere fallirebbe solo all'installazione, meglio dirlo subito.
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
  // Dimensione dell'archivio (HEAD) e, per le release GitHub, il checksum: solo per chi si può scaricare, mai bloccanti.
  // Il dialog di conferma si offre solo con `sha256` noto: se la release non lo pubblica (`no-checksum`) o non si riesce a leggerlo
  // ora (`checksum-unavailable`) la voce non è scaricabile e `download.blocked` lo dice.
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
 * Voce da aggiungere per un agente del registro: il binario già scaricato, poi la CLI trovata nel PATH (solo curati).
 * null negli altri casi: il ripiego npx/uvx lo sceglie il chiamante (`registrySpec`); senza, resta il binario da
 * scaricare (si installa prima con `agents.install`).
 */
export async function resolveAgentSpec(entry: RegistryEntry, installed: AcpAgentSpec | undefined): Promise<AcpAgentSpec | null> {
  if (installed?.distribution === 'binary' && existsSync(installed.command)) return installed
  const exe = curatedExe(entry.id)
  const path = exe ? (await whichManyInShell([exe])).get(exe) : null
  if (path) return pathSpec(entry, path)
  return null
}
