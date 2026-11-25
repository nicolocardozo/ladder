// Local transport for tests: WebSocket on 127.0.0.1, one binary message = one Noise message.
// Starts only with LADDER_REMOTE_PORT (see host/index.ts); pairing and the relay live in their own modules.
import { WebSocketServer, type WebSocket } from 'ws'
import { NOISE_MAX_MESSAGE } from '../../shared/remote/noise.ts'
import type { RemoteGateway, RemoteLink } from './gateway.ts'

const PING_MS = 30_000

function linkOf(ws: WebSocket): RemoteLink {
  return {
    send: (bytes) => ws.send(bytes, { binary: true }),
    close: () => ws.close(),
    onBytes: (handler) =>
      ws.on('message', (data, isBinary) => {
        // Binary only: a text message is not Noise.
        if (!isBinary || !(data instanceof Buffer)) return ws.close(1003)
        handler(new Uint8Array(data.buffer, data.byteOffset, data.length))
      }),
    onClose: (handler) => {
      ws.on('close', handler)
      ws.on('error', handler)
    },
    buffered: () => ws.bufferedAmount,
    onAlive: (handler) => ws.on('pong', handler)
  }
}

/**
 * The server is local only: the Host header must be the loopback address with the listening port (against DNS rebinding: a web page
 * whose name points to 127.0.0.1 sends a different Host). Origin: absent (native client) or `http://` + the same Host (React Native).
 * No page is served from this server, so web pages of other sites stay out.
 * 10.0.2.2 is the address the Android emulator uses to reach the Mac's loopback: it is a literal IP, not a name, so it does not reopen rebinding.
 */
export function originAllowed({ origin, req }: { origin: string; req: { headers: { host?: string } } }, port: number): boolean {
  const host = req.headers.host
  const local = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `10.0.2.2:${port}`]
  if (!host || !local.includes(host)) return false
  return !origin || origin === `http://${host}`
}

/** Starts the server on 127.0.0.1:port (0 = free port). Resolves with the listening port and a `stop`. */
export function startLocalWsServer(gateway: RemoteGateway, port: number): Promise<{ port: number; stop: () => void }> {
  return new Promise((resolve, reject) => {
    // With port 0 the real one is only known after listening: the check reads it from here.
    let actualPort = port
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port,
      maxPayload: NOISE_MAX_MESSAGE,
      verifyClient: (info: { origin: string; req: { headers: { host?: string } } }) => originAllowed(info, actualPort)
    })
    server.on('error', reject)
    server.on('listening', () => {
      server.off('error', reject)
      server.on('error', (error) => console.error('[remote] server', error.message))
      const address = server.address()
      actualPort = typeof address === 'object' && address ? address.port : port
      resolve({ port: typeof address === 'object' && address ? address.port : port, stop: () => server.close() })
    })
    // Ping every 30 s: whoever did not answer in the previous round is gone and is closed (the pong also counts as activity for the gateway).
    const alive = new WeakSet<WebSocket>()
    const timer = setInterval(() => {
      for (const ws of server.clients) {
        if (!alive.has(ws)) ws.terminate()
        else {
          alive.delete(ws)
          ws.ping()
        }
      }
    }, PING_MS)
    server.on('close', () => clearInterval(timer))
    server.on('connection', (ws) => {
      alive.add(ws)
      ws.on('pong', () => alive.add(ws))
      gateway.accept(linkOf(ws))
    })
  })
}
