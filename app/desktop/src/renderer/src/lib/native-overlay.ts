// The built-in browser view is native and sits above the HTML: menus, dialogs, palette and drags would have to be hidden
// under it, so the view hides itself while anything is above the area. We look at the DOM: the ui/ components put
// their popups in a portal outside #root, with a `data-slot` that identifies them.
import { useEffect, useState } from 'react'

/** Popups that float above the page. Tooltips excluded: they pop up on the edge and hiding the page on every hover is more disruptive than useful. */
const OVERLAYS = [
  '[data-slot="dialog-content"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="select-content"]',
  '[data-slot="context-menu-content"]',
  '[role="dialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  // Panels inside #root that cover the area (second sidebar of "All sessions").
  '[data-native-overlay]'
].join(',')

function overlayOpen(): boolean {
  if (document.documentElement.dataset.dragging === 'true') return true
  const root = document.getElementById('root')
  for (const el of document.querySelectorAll(OVERLAYS)) {
    // A popup that is closing does not count; roles inside #root belong to the view, not popups (but the marked panel does).
    if (el.hasAttribute('data-closed') || el.hasAttribute('data-ending-style')) continue
    if (root?.contains(el) && !el.hasAttribute('data-native-overlay')) continue
    return true
  }
  return false
}

/** True while there is a popup, a dialog or a drag above the page. */
export function useOverlayOpen(): boolean {
  const [open, setOpen] = useState(overlayOpen)
  useEffect(() => {
    // At most one check per frame: terminal output mutates the DOM continuously.
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
    // Nodes that come and go (portals) and the attributes that say "open", "closing" or "dragging".
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-closed', 'data-ending-style', 'data-open'] })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-dragging'] })
    return () => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])
  return open
}
