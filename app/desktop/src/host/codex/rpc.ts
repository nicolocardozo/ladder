// Client JSON-RPC per `codex app-server` su stdio: una riga JSON per messaggio, senza il campo "jsonrpc".
// Ricavato dallo spike S1 (spikes/codex-app-server), senza log su file e con tipi ridotti ai metodi usati.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { t } from '@shared/i18n'

export interface RpcError {
  code: number
  message: string
  data?: unknown
}

export class RpcRequestError extends Error {
  constructor(
    readonly method: string,
    readonly rpc: RpcError
  ) {
    super(rpc.message)
  }
}

export type ServerRequest = { id: number | string; method: string; params: Record<string, unknown> }
export type ServerReply = { result: unknown } | { error: RpcError }

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class CodexRpc {
  readonly proc: ChildProcessWithoutNullStreams
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  private nextId = 1
  private pending = new Map<number | string, Pending>()
  private closed = false
  /** Ultime righe di stderr: servono a spiegare un'uscita inattesa. */
  readonly stderr: string[] = []

  constructor(
    cli: string,
    env: Record<string, string>,
    private readonly onNotification: (method: string, params: Record<string, unknown>) => void,
    private readonly onRequest: (request: ServerRequest) => Promise<ServerReply>
  ) {
    this.proc = spawn(cli, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], env })
    createInterface({ input: this.proc.stdout }).on('line', (line) => this.onLine(line))
    createInterface({ input: this.proc.stderr }).on('line', (line) => {
      // Log con colori ANSI: si tengono le ultime righe, senza interpretarle.
      this.stderr.push(line.replace(/\x1b\[[0-9;]*m/g, ''))
      if (this.stderr.length > 40) this.stderr.shift()
    })
    this.exited = new Promise((resolve) => {
      this.proc.on('error', () => undefined)
      this.proc.on('exit', (code, signal) => {
        this.closed = true
        for (const p of this.pending.values()) {
          clearTimeout(p.timer)
          p.reject(new Error(t('Codex exited during {method}', { method: p.method })))
        }
        this.pending.clear()
        resolve({ code, signal })
      })
    })
  }

  get isClosed(): boolean {
    return this.closed
  }

  private onLine(line: string): void {
    if (!line.trim()) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const hasId = msg.id !== undefined && msg.id !== null
    if (hasId && typeof msg.method === 'string') {
      void this.reply(msg as unknown as ServerRequest)
    } else if (hasId) {
      const p = this.pending.get(msg.id as number)
      if (!p) return
      this.pending.delete(msg.id as number)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new RpcRequestError(p.method, msg.error as RpcError))
      else p.resolve(msg.result)
    } else if (typeof msg.method === 'string') {
      this.onNotification(msg.method, (msg.params ?? {}) as Record<string, unknown>)
    }
  }

  private async reply(request: ServerRequest): Promise<void> {
    let reply: ServerReply
    try {
      reply = await this.onRequest(request)
    } catch (error) {
      reply = { error: { code: -32603, message: String(error) } }
    }
    this.write({ id: request.id, ...reply })
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed) return
    this.proc.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(new Error(t('Codex is not running.')))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(t('Codex did not respond to {method}.', { method })))
      }, timeoutMs)
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer })
      this.write(params === undefined ? { id, method } : { id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  async initialize(version: string): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'ladder', title: 'Ladder', version }, capabilities: null })
    this.notify('initialized')
  }

  kill(): void {
    if (!this.closed) this.proc.kill('SIGTERM')
  }
}
