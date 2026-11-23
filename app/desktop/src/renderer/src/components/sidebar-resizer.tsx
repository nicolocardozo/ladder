// Divisore sul bordo destro della sidebar (LAD-75). Ha uno stato suo: cambiare larghezza non ridisegna la sidebar.
import { useState } from 'react'
import { t } from '@shared/i18n'
import { ResizeHandle } from '@/components/resize-handle'
import { applySidebarWidth, clamp, MIN_CONTENT_WIDTH, readSidebarWidth, SIDEBAR_WIDTH, writeSize } from '@/lib/panel-size'

/** Larghezza applicata ora (la variabile CSS che usa la sidebar, anche a metà gesto): non dipende dalla scrittura in localStorage. */
const currentWidth = () => {
  const value = parseFloat(document.documentElement.style.getPropertyValue('--sidebar-w'))
  return Number.isFinite(value) ? value : readSidebarWidth()
}

const maxWidth = () => Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, window.innerWidth - MIN_CONTENT_WIDTH))

export function SidebarResizer() {
  const [width, setWidth] = useState(readSidebarWidth)
  const commit = (value: number) => {
    const next = clamp(Math.round(value), SIDEBAR_WIDTH.min, maxWidth())
    applySidebarWidth(next)
    writeSize(SIDEBAR_WIDTH.key, next)
    setWidth(next)
  }
  return (
    <ResizeHandle
      label={t('Resize sidebar')}
      value={width}
      min={SIDEBAR_WIDTH.min}
      max={maxWidth()}
      measure={() => ({ value: currentWidth(), min: SIDEBAR_WIDTH.min, max: maxWidth() })}
      onPreview={applySidebarWidth}
      onCommit={commit}
      onReset={() => commit(SIDEBAR_WIDTH.default)}
      className="absolute inset-y-0 -right-1"
    />
  )
}
