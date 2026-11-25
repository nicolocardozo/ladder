// Local relay tests: starts `wrangler dev` (Miniflare, no account) on a free port and provides test sockets.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
import { decodeFrame, relayEndpoint, relayIdFromPublicKey, relayOrigin, signAuth, type RelayToPhone } from '../../desktop/src/shared/remote/relay-protocol.ts'

export interface Dev {
  url: string
  stop(): Promise<void>
}

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })

/** Starts wrangler dev; `persistDir` keeps the Durable Objects' storage across restarts. */
export async function startDev(port?: number, persistDir?: string): Promise<Dev> {
  const p = port ?? (await freePort())
  const persist = persistDir ?? mkdtempSync(join(tmpdir(), 'ladder-relay-'))
  // ANTHROPIC_* and CLAUDE* are removed from the child's environment.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ANTHROPIC_') && !k.startsWith('CLAUDE')))
  const child: ChildProcess = spawn('pnpm', ['exec', 'wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(p), '--persist-to', persist], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  })
  let log = ''
  child.stdout?.on('data', (d: Buffer) => { log += d; if (process.env.DBG) process.stdout.write(d) })
  child.stderr?.on('data', (d: Buffer) => (log += d))
  const url = `http://127.0.0.1:${p}`
  const deadline = Date.now() + 60_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited:\n${log}`)
    try {
      if ((await fetch(`${url}/health`)).ok) break
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error(`wrangler dev failed to start:\n${log}`)
    await new Promise((r) => setTimeout(r, 300))
  }
  return {
    url,
    async stop() {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      // The process group: pnpm → wrangler → workerd.
      try {
        process.kill(-child.pid!, 'SIGTERM')
      } catch {
        // already exited
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // already exited
      }
      if (!persistDir) rmSync(persist, { recursive: true, force: true })
    }
  }
}

export interface MacKey {
  secretKey: Uint8Array
  id: string
}

export function newMacKey(): MacKey {
  const secretKey = ed25519.utils.randomSecretKey()
  return { secretKey, id: relayIdFromPublicKey(ed25519.getPublicKey(secretKey)) }
}

/** A WebSocket that accumulates messages and lets you wait for one. */
export class TestSocket {
  readonly ws: WebSocket
  readonly texts: string[] = []
  readonly binaries: Uint8Array[] = []
  closed: { code: number; reason: string } | null = null
  private waiters: (() => void)[] = []

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.binaryType = 'arraybuffer'
    this.ws.addEventListener('message', (e) => {
      if (typeof e.data === 'string') this.texts.push(e.data)
      else this.binaries.push(new Uint8Array(e.data as ArrayBuffer))
      this.wake()
    })
    this.ws.addEventListener('close', (e) => {
      this.closed = { code: e.code, reason: e.reason }
      this.wake()
    })
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w()
  }

  /** Waits until `check` is true (checked on every message or close). */
  async until<T>(check: () => T | undefined | false | null, ms = 8000): Promise<T> {
    const deadline = Date.now() + ms
    for (;;) {
      const value = check()
      if (value) return value
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`timeout; testi: ${JSON.stringify(this.texts)}, binari: ${this.binaries.length}, chiuso: ${JSON.stringify(this.closed)}`)
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left)
        this.waiters.push(() => {
          clearTimeout(t)
          resolve()
        })
      })
    }
  }

  json<T>(): T[] {
    return this.texts.filter((t) => t.startsWith('{')).map((t) => JSON.parse(t) as T)
  }

  nextJson<T>(match: (m: T) => boolean, from = 0): Promise<T> {
    return this.until(() => this.json<T>().slice(from).find(match))
  }

  frames() {
    return this.binaries.map((b) => decodeFrame(b)!)
  }

  async opened(): Promise<this> {
    if (this.ws.readyState === WebSocket.OPEN) return this
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', () => reject(new Error('connection failed')))
    })
    return this
  }

  close(): void {
    this.ws.close()
  }
}

/** Authenticated Mac; with a `key` different from the id or a wrong signature, authentication fails. */
export async function connectMac(dev: Dev, key: MacKey, options: { tamper?: boolean; origin?: string } = {}): Promise<TestSocket> {
  const mac = new TestSocket(relayEndpoint(dev.url, key.id, 'mac'))
  // The real Mac writes right away (ping): see the comment in connectPhone.
  mac.ws.addEventListener('open', () => mac.ws.send('ping'))
  const challenge = await mac.nextJson<{ t: string; nonce: string }>((m) => m.t === 'challenge')
  const auth = signAuth(key.secretKey, options.origin ?? relayOrigin(dev.url), key.id, options.tamper ? `${challenge.nonce}x` : challenge.nonce)
  mac.ws.send(JSON.stringify(auth))
  return mac
}

export async function connectPhone(dev: Dev, id: string): Promise<TestSocket> {
  const phone = new TestSocket(relayEndpoint(dev.url, id, 'phone'))
  // Like the real phone (keepalive right after opening). With wrangler dev a client that has never written does not complete the close started by the relay.
  phone.ws.addEventListener('open', () => phone.ws.send('ping'))
  return phone
}

export const isOnline = (m: RelayToPhone): boolean => m.t === 'mac' && m.online
