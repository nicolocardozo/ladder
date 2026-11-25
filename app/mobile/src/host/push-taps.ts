// Tocco su una notifica di Ladder: apre la sessione (e la richiesta, se c'è e è ancora aperta). Funziona con l'app chiusa
// (l'ultima risposta si legge all'avvio), in sfondo e in primo piano (ascolto). Il layout lo monta solo a boot finito: a quel punto
// l'abbinamento è già caricato e `pushMacKey()` dice quale Mac è il nostro. Le notifiche di un altro Mac o senza i `data` giusti si ignorano.
import * as Notifications from 'expo-notifications'
import { usePathname, useRootNavigationState, useRouter } from 'expo-router'
import { useEffect, useRef } from 'react'
import { tapTarget } from '@/lib/push-data'
import { follow } from '@/host/controller'
import { pushMacKey } from '@/host/push'
import { useApp } from '@/store/app'
import { usePush } from '@/store/push'

export function useNotificationTaps(): void {
  const router = useRouter()
  const pathname = usePathname()
  const navReady = !!useRootNavigationState()?.key
  // Risposte già gestite: la stessa può arrivare dall'ascolto e dalla lettura "ultima risposta" all'avvio.
  const seen = useRef(new Set<string>())
  // Il percorso "vero": uno sheet nativo aperto (/sheet/…) non conta, sotto c'è la schermata che si vede e su cui decidere.
  const pathRef = useRef(pathname)
  if (!pathname.startsWith('/sheet/')) pathRef.current = pathname
  const sheetOpen = useRef(false)
  sheetOpen.current = pathname.startsWith('/sheet/')

  useEffect(() => {
    if (!navReady) return
    const run = (response: Notifications.NotificationResponse) => {
      if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return
      const key = `${response.notification.request.identifier}|${response.notification.date}`
      if (seen.current.has(key)) return
      seen.current.add(key)
      const target = tapTarget(response.notification.request.content.data, pushMacKey())
      if (!target) return
      // Collegamento revocato o chiave cambiata: l'app sta già mostrando la schermata che lo spiega.
      const conn = useApp.getState().conn.kind
      if (conn === 'revoked' || conn === 'key-changed') return
      if (target.requestId) {
        // La chat in memoria può essere vecchia: si segna "da rileggere" e si rilegge, e la richiesta si apre solo dopo (session/[id].tsx).
        useApp.setState((s) => ({ loaded: { ...s.loaded, [target.sessionId]: false } }))
        usePush.getState().set({ openRequest: { sessionId: target.sessionId, requestId: target.requestId, at: Date.now() } })
        void follow(target.sessionId).catch(() => {})
      }
      const href = `/session/${target.sessionId}`
      // Già su quella sessione: solo la richiesta. Su un'altra sessione si sostituisce (i tocchi non impilano chat); altrove si aggiunge.
      if (pathRef.current === href) return
      // Uno sheet nativo aperto (rotta /sheet/…) si chiude: la sessione si apre sotto, nella sua pila, senza impilare doppioni.
      if (sheetOpen.current) router.dismissAll()
      if (pathRef.current.startsWith('/session/')) router.replace({ pathname: '/session/[id]', params: { id: target.sessionId } })
      else router.push({ pathname: '/session/[id]', params: { id: target.sessionId } })
    }
    // App chiusa: il tocco che l'ha aperta. Poi si ascoltano i tocchi con l'app in sfondo o in primo piano.
    const last = Notifications.getLastNotificationResponse()
    if (last) run(last)
    const sub = Notifications.addNotificationResponseReceivedListener(run)
    return () => sub.remove()
  }, [navReady, router])
}
