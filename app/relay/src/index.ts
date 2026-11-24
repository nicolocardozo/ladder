// Worker d'ingresso del relay: smista ogni WebSocket al Durable Object del suo id. Non legge né registra nulla del traffico.
import { isRelayId, RELAY_VERSION } from '../../desktop/src/shared/remote/relay-protocol.ts'
import type { RelayDurableObject } from './relay-do.ts'

export { RelayDurableObject } from './relay-do.ts'

interface Env {
  RELAY: DurableObjectNamespace<RelayDurableObject>
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/' || url.pathname === '/health') return new Response('ladder-relay\n', { headers: { 'content-type': 'text/plain' } })
    // /v1/<id>?role=mac|phone
    const [, version, id, ...rest] = url.pathname.split('/')
    if (version !== RELAY_VERSION || !id || rest.length > 0 || !isRelayId(id)) return new Response('Not found', { status: 404 })
    const role = url.searchParams.get('role')
    if (role !== 'mac' && role !== 'phone') return new Response('Bad request', { status: 400 })
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 })
    return env.RELAY.get(env.RELAY.idFromName(id)).fetch(request)
  }
}
