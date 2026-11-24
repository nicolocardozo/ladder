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

/**
 * Il server è solo locale: l'header Host deve essere l'indirizzo di loopback con la porta in ascolto (contro il DNS rebinding: una pagina web
 * il cui nome punta a 127.0.0.1 manda un altro Host). Origin: assente (client nativo) o `http://` + lo stesso Host (React Native).
 * Da questo server non si serve nessuna pagina, quindi le pagine web di altri siti restano fuori.
 * 10.0.2.2 è l'indirizzo con cui l'emulatore Android raggiunge il loopback del Mac: è un IP letterale, non un nome, quindi non riapre il rebinding.
 */
export function originAllowed({ origin, req }: { origin: string; req: { headers: { host?: string } } }, port: number): boolean {
  const host = req.headers.host
  const local = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `10.0.2.2:${port}`]
  if (!host || !local.includes(host)) return false
  return !origin || origin === `http://${host}`
}

/** Avvia il server su 127.0.0.1:port (0 = porta libera). Risolve con la porta in ascolto e uno `stop`. */
export function startLocalWsServer(gateway: RemoteGateway, port: number): Promise<{ port: number; stop: () => void }> {
  return new Promise((resolve, reject) => {
    // Con porta 0 quella vera si sa solo dopo l'ascolto: il controllo la legge da qui.
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
