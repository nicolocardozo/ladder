// La vista del browser integrato è nativa e sta sopra l'HTML: menu, dialoghi, palette e trascinamenti vanno nascosti
// sotto di lei, quindi la vista si nasconde finché c'è qualcosa sopra l'area. Si guarda il DOM: i componenti ui/ mettono
// i loro popup in un portale fuori da #root, con un `data-slot` che li riconosce.
import { useEffect, useState } from 'react'

/** Popup che galleggiano sopra la pagina. Tooltip esclusi: spuntano sul bordo e nascondere la pagina a ogni passaggio disturba più di quanto serva. */
const OVERLAYS = [
  '[data-slot="dialog-content"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="select-content"]',
  '[data-slot="context-menu-content"]',
  '[role="dialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  // Pannelli dentro #root che coprono l'area (seconda sidebar di "All sessions").
  '[data-native-overlay]'
].join(',')

function overlayOpen(): boolean {
  if (document.documentElement.dataset.dragging === 'true') return true
  const root = document.getElementById('root')
  for (const el of document.querySelectorAll(OVERLAYS)) {
    // Un popup che si sta chiudendo non conta; i ruoli dentro #root sono della vista, non popup (ma il pannello marcato sì).
    if (el.hasAttribute('data-closed') || el.hasAttribute('data-ending-style')) continue
    if (root?.contains(el) && !el.hasAttribute('data-native-overlay')) continue
    return true
  }
  return false
}

/** Vero finché c'è un popup, un dialogo o un trascinamento sopra la pagina. */
export function useOverlayOpen(): boolean {
  const [open, setOpen] = useState(overlayOpen)
  useEffect(() => {
    // Un controllo per frame al massimo: l'output del terminale muta il DOM di continuo.
    let frame = 0
    const check = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setOpen(overlayOpen())
      })
    }
    setOpen(overlayOpen())
    const observer = new MutationObserver(check)
    // Nodi che arrivano e se ne vanno (portali) e gli attributi che dicono "aperto" o "in chiusura" o "si sta trascinando".
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-closed', 'data-ending-style', 'data-open'] })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-dragging'] })
    return () => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])
  return open
}
