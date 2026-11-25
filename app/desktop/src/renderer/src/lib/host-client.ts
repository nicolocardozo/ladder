// Channel to the sessions host. The port arrives from the preload via window.postMessage;
// if the host restarts, a new one arrives and the client reconnects by itself.
import type { FromHost, HostCommand, HostEvent } from '@shared/protocol'
import { t } from '@shared/i18n'

type Listener = (event: HostEvent) => void
type ConnectListener = () => void

let port: MessagePort | null = null
let counter = 0
const pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>()
const listeners = new Set<Listener>()
const connectListeners = new Set<ConnectListener>()

function attach(next: MessagePort): void {
  port?.close()
  port = next
  for (const [, request] of pending) request.reject(new Error(t('Host restarted')))
  pending.clear()
  port.onmessage = (event: MessageEvent<FromHost>) => {
    const message = event.data
    if (message.kind === 'event') {
      for (const listener of listeners) listener(message.event)
      return
    }
    const request = pending.get(message.rid)
    if (!request) return
    pending.delete(message.rid)
    if (message.ok) request.resolve(message.data)
    else {
      // If the host attaches an `errorCode` to the rejection (e.g. `checksum-conflict` of agents.install) it is left on the error; today's contract carries only the message.
      const errorCode = (message as { errorCode?: string }).errorCode
      request.reject(errorCode ? Object.assign(new Error(message.error), { errorCode }) : new Error(message.error))
    }
  }
  port.start()
  for (const listener of connectListeners) listener()
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.data === 'ladder:host-port' && event.ports[0]) attach(event.ports[0])
})

export const isElectron = typeof window !== 'undefined' && Boolean(window.ladder)

export function onHostEvent(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Called on every (re)connection with the host, even if the port has already arrived. */
export function onHostConnect(listener: ConnectListener): () => void {
  connectListeners.add(listener)
  if (port) listener()
  return () => connectListeners.delete(listener)
}

/** Sends a command and waits for the host's response. */
export function request<T = unknown>(command: HostCommand): Promise<T> {
  if (!port) return Promise.reject(new Error(t('Host not connected')))
  const rid = `r${++counter}`
  return new Promise<T>((resolve, reject) => {
    pending.set(rid, { resolve: resolve as (data: unknown) => void, reject })
    port!.postMessage({ rid, command })
  })
}

/** Sends a command without waiting for the response. */
export function send(command: HostCommand): void {
  port?.postMessage({ command })
}
