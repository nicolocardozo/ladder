// Trasporto locale per le prove: WebSocket su 127.0.0.1, un messaggio binario = un messaggio Noise.
// Parte solo con LADDER_REMOTE_PORT (vedi host/index.ts): abbinamento e relay arrivano con LAD-51 e LAD-50.
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
        // Solo binari: un messaggio di testo non è Noise.
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

/** Avvia il server su 127.0.0.1:port (0 = porta libera). Risolve con la porta in ascolto e uno `stop`. */
export function startLocalWsServer(gateway: RemoteGateway, port: number): Promise<{ port: number; stop: () => void }> {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port,
      maxPayload: NOISE_MAX_MESSAGE,
      // Un client nativo non manda Origin: se c'è, viene da una pagina web, e a una pagina qui non si risponde.
      verifyClient: ({ origin }: { origin: string }) => !origin
    })
    server.on('error', reject)
    server.on('listening', () => {
      server.off('error', reject)
      server.on('error', (error) => console.error('[remote] server', error.message))
      const address = server.address()
      resolve({ port: typeof address === 'object' && address ? address.port : port, stop: () => server.close() })
    })
    // Ping ogni 30 s: chi non ha risposto al giro prima è sparito e si chiude (il pong conta anche come attività per il gateway).
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
