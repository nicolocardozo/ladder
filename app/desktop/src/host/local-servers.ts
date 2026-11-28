// Local servers: processes listening on a TCP port whose working folder is inside a project (its folder or one of its
// worktrees). It covers what an agent started in the background or the user ran in their own terminal, not only Ladder's services.
// No path aliases: scripts/cli.test.mts imports it directly.
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'

export interface LocalServer {
  pid: number
  projectId: string
  /** Process name as lsof reports it (node, python3, …). */
  command: string
  /** Ports it listens on, ascending. */
  ports: number[]
  /** Its working folder. */
  cwd: string
}

/** Folders that belong to a project: its own and the cwd of its sessions. */
export interface ProjectRoots {
  projectId: string
  roots: string[]
}

const SCAN_MS = 5_000
const LSOF_TIMEOUT_MS = 4_000
// Ladder's own processes listen too (local MCP and browser servers); in development their folder is this repository.
const OWN_COMMAND = /^(Electron|Ladder)( Helper.*)?$/
// Agents open internal ports (IDE bridge, MCP): they are not servers the user would open or stop.
const AGENT_COMMAND = /^(claude|codex|gemini|opencode|cursor-agent)$/i
// macOS hands out ports from 49152 up to processes that ask for any free port: internal channels, not dev servers.
const EPHEMERAL_FROM = 49152

/** `child` is `root` or inside it (compared as paths, so /a/bc is not inside /a/b). */
function isInside(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep)
}

function lsof(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    // lsof exits with 1 when some process can't be read but still prints the rest.
    execFile('lsof', args, { timeout: LSOF_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (_error, stdout) => resolve(String(stdout ?? '')))
  })
}

/** Parses `lsof -Fpcn` output: one record per process, with its command and the names (addresses or the cwd). */
export function parseLsof(text: string): Map<number, { command: string; names: string[] }> {
  const out = new Map<number, { command: string; names: string[] }>()
  let current: { command: string; names: string[] } | null = null
  for (const line of text.split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      const pid = Number(value)
      current = out.get(pid) ?? { command: '', names: [] }
      out.set(pid, current)
    } else if (tag === 'c' && current) current.command = value
    else if (tag === 'n' && current) current.names.push(value)
  }
  return out
}

/** Port of an lsof address like `*:5173`, `127.0.0.1:3000` or `[::1]:8080`. */
export function portOf(address: string): number | null {
  const match = /:(\d+)$/.exec(address)
  const port = match ? Number(match[1]) : NaN
  return Number.isInteger(port) && port > 0 ? port : null
}

/** Assigns each listening process to the project whose folder contains its cwd (the deepest root wins). */
export function matchServers(
  listening: Map<number, { command: string; names: string[] }>,
  cwds: Map<number, string>,
  projects: ProjectRoots[],
  ownPid: number
): LocalServer[] {
  const servers: LocalServer[] = []
  for (const [pid, entry] of listening) {
    if (pid === ownPid || OWN_COMMAND.test(entry.command) || AGENT_COMMAND.test(entry.command)) continue
    const cwd = cwds.get(pid)
    if (!cwd || cwd === '/') continue
    let best: { projectId: string; length: number } | null = null
    for (const project of projects) {
      for (const root of project.roots) {
        if (root && isInside(cwd, root) && (!best || root.length > best.length)) best = { projectId: project.projectId, length: root.length }
      }
    }
    if (!best) continue
    const ports = [...new Set(entry.names.map(portOf).filter((p): p is number => p !== null && p < EPHEMERAL_FROM))].sort((a, b) => a - b)
    if (ports.length === 0) continue
    servers.push({ pid, projectId: best.projectId, command: entry.command, ports, cwd })
  }
  return servers.sort((a, b) => a.ports[0] - b.ports[0])
}

export class LocalServers {
  private servers: LocalServer[] = []
  private sent = '[]'
  private timer: NodeJS.Timeout | null = null
  private scanning: Promise<void> | null = null
  private stopped = false
  // lsof reports real paths: roots through a symlink (~/code → /Volumes/…, /tmp → /private/tmp) are resolved once.
  private readonly real = new Map<string, string>()

  private readonly deps: { projects: () => ProjectRoots[]; emit: (servers: LocalServer[]) => void }

  constructor(deps: { projects: () => ProjectRoots[]; emit: (servers: LocalServer[]) => void }) {
    this.deps = deps
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    void this.scan()
    this.timer = setInterval(() => void this.scan(), SCAN_MS)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  list(): LocalServer[] {
    return this.servers
  }

  /** Reads the listening processes again; emits only when the list changed. */
  scan(): Promise<void> {
    this.scanning ??= this.read().finally(() => {
      this.scanning = null
    })
    return this.scanning
  }

  private async read(): Promise<void> {
    const listening = parseLsof(await lsof(['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']))
    const pids = [...listening.keys()].filter((pid) => pid !== process.pid)
    const cwds = new Map<number, string>()
    if (pids.length > 0) {
      for (const [pid, entry] of parseLsof(await lsof(['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')]))) {
        if (entry.names[0]) cwds.set(pid, entry.names[0])
      }
    }
    const projects = this.deps.projects().map((p) => ({ projectId: p.projectId, roots: [...new Set(p.roots.flatMap((root) => [root, this.realPath(root)]))] }))
    this.servers = matchServers(listening, cwds, projects, process.pid)
    if (this.stopped) return
    const text = JSON.stringify(this.servers)
    if (text === this.sent) return
    this.sent = text
    this.deps.emit(this.servers)
  }

  /**
   * Stops a server from the list: SIGTERM, then SIGKILL if it is still alive after a few seconds. Only pids of the last
   * scan, so the command can't be used to kill an arbitrary process.
   */
  async kill(pid: number): Promise<void> {
    const server = this.servers.find((s) => s.pid === pid)
    if (!server) throw new Error('unknown')
    // The list can be a few seconds old: the pid must still be the same program listening on a port.
    const now = parseLsof(await lsof(['-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fpc'])).get(pid)
    if (!now || now.command !== server.command) {
      await this.rescan()
      throw new Error('gone')
    }
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100))
      if (!alive(pid)) break
    }
    if (alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    await this.rescan()
  }

  /** A fresh scan: one already running started before the change and would report the old list. */
  private async rescan(): Promise<void> {
    await this.scanning
    await this.scan()
  }

  private realPath(path: string): string {
    let real = this.real.get(path)
    if (real === undefined) {
      try {
        real = realpathSync(path)
      } catch {
        real = path
      }
      this.real.set(path, real)
    }
    return real
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
