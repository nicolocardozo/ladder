// CLI connection to Ladder's socket: JSON, one line per message, `rid` to match replies.
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import type { FromHost, HostCommand, HostEvent } from '../shared/protocol'

export interface Conn {
  request(command: HostCommand): Promise<unknown>
  /** The session's `session.items` and `session.upsert` events arrive here. */
  subscribe(sessionId: string, onEvent: (event: HostEvent) => void): Promise<void>
  onClose(fn: () => void): void
  close(): void
}

export const NOT_RUNNING = 'Ladder is not running. Open Ladder first.'

export function connectSocket(path: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    const pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>()
    let handler: ((event: HostEvent) => void) | null = null
    let closeFn: (() => void) | null = null
    // Closed on purpose by us (Ctrl-C, end of the command): this is not "Ladder closed the connection".
    let closing = false
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') reject(new Error(NOT_RUNNING))
      else reject(new Error(`Cannot connect to Ladder: ${error.message}`))
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let at: number
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        if (!line.trim()) continue
        const message = JSON.parse(line) as FromHost
        if (message.kind === 'event') handler?.(message.event)
        else {
          const waiter = pending.get(message.rid)
          if (!waiter) continue
          pending.delete(message.rid)
          if (message.ok) waiter.resolve(message.data)
          else waiter.reject(new Error(message.error))
        }
      }
    })
    socket.on('close', () => {
      for (const waiter of pending.values()) waiter.reject(new Error('Ladder closed the connection.'))
      pending.clear()
      if (!closing) closeFn?.()
    })
    const send = (frame: object) =>
      new Promise<unknown>((res, rej) => {
        const rid = randomUUID()
        pending.set(rid, { resolve: res, reject: rej })
        socket.write(`${JSON.stringify({ rid, ...frame })}\n`)
      })
    socket.once('connect', () =>
      resolve({
        request: (command) => send({ command }),
        subscribe: async (sessionId, onEvent) => {
          handler = onEvent
          await send({ subscribe: sessionId })
        },
        onClose: (fn) => void (closeFn = fn),
        close: () => {
          closing = true
          socket.destroy()
        }
      })
    )
  })
}
