// Prove locali del relay: avvia `wrangler dev` (Miniflare, nessun account) su una porta libera e fornisce socket di prova.
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

/** Avvia wrangler dev; `persistDir` conserva lo storage dei Durable Object tra un riavvio e l'altro. */
export async function startDev(port?: number, persistDir?: string): Promise<Dev> {
  const p = port ?? (await freePort())
  const persist = persistDir ?? mkdtempSync(join(tmpdir(), 'ladder-relay-'))
  // Dall'ambiente del figlio si tolgono ANTHROPIC_* e CLAUDE*.
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
    if (child.exitCode !== null) throw new Error(`wrangler dev è uscito:\n${log}`)
    try {
      if ((await fetch(`${url}/health`)).ok) break
    } catch {
      // non ancora pronto
    }
    if (Date.now() > deadline) throw new Error(`wrangler dev non parte:\n${log}`)
    await new Promise((r) => setTimeout(r, 300))
  }
  return {
    url,
    async stop() {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      // Il gruppo di processi: pnpm → wrangler → workerd.
      try {
        process.kill(-child.pid!, 'SIGTERM')
      } catch {
        // già uscito
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // già uscito
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

/** Un WebSocket che accumula i messaggi e permette di aspettarne uno. */
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

  /** Aspetta che `check` sia vera (controllata a ogni messaggio o chiusura). */
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
      this.ws.addEventListener('error', () => reject(new Error('connessione non riuscita')))
    })
    return this
  }

  close(): void {
    this.ws.close()
  }
}

/** Mac autenticato; con `key` diversa dall'id o firma sbagliata l'autenticazione fallisce. */
export async function connectMac(dev: Dev, key: MacKey, options: { tamper?: boolean; origin?: string } = {}): Promise<TestSocket> {
  const mac = new TestSocket(relayEndpoint(dev.url, key.id, 'mac'))
  // Il Mac vero scrive subito (ping): vedi il commento in connectPhone.
  mac.ws.addEventListener('open', () => mac.ws.send('ping'))
  const challenge = await mac.nextJson<{ t: string; nonce: string }>((m) => m.t === 'challenge')
  const auth = signAuth(key.secretKey, options.origin ?? relayOrigin(dev.url), key.id, options.tamper ? `${challenge.nonce}x` : challenge.nonce)
  mac.ws.send(JSON.stringify(auth))
  return mac
}

export async function connectPhone(dev: Dev, id: string): Promise<TestSocket> {
  const phone = new TestSocket(relayEndpoint(dev.url, id, 'phone'))
  // Come fa il telefono vero (keepalive appena aperto). Con wrangler dev un client che non ha mai scritto non completa la chiusura iniziata dal relay.
  phone.ws.addEventListener('open', () => phone.ws.send('ping'))
  return phone
}

export const isOnline = (m: RelayToPhone): boolean => m.t === 'mac' && m.online
