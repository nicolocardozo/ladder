// Pairing QR. Always dark modules on a white tile with a 4-module margin, in every theme: phones only read it that way.
// Drawn by hand from the `qrcode` matrix (a single <path>, crisp edges) instead of injecting an SVG as text.
import { useMemo } from 'react'
import QRCode from 'qrcode'

const QUIET_ZONE = 4

export function QrCode({ value, label, maxSize = 264, className }: { value: string; label: string; maxSize?: number; className?: string }) {
  const drawn = useMemo(() => {
    try {
      const { modules } = QRCode.create(value, { errorCorrectionLevel: 'M' })
      let path = ''
      for (let row = 0; row < modules.size; row++) {
        let col = 0
        while (col < modules.size) {
          if (!modules.get(row, col)) {
            col++
            continue
          }
          // A run of adjacent dark modules is a single rectangle.
          const start = col
          while (col < modules.size && modules.get(row, col)) col++
          path += `M${start + QUIET_ZONE} ${row + QUIET_ZONE}h${col - start}v1h-${col - start}z`
        }
      }
      return { path, span: modules.size + QUIET_ZONE * 2 }
    } catch {
      return null
    }
  }, [value])
  if (!drawn) return null
  // A whole number of pixels per module: edges stay crisp and the phone does not have to interpolate.
  const pixels = drawn.span * Math.max(2, Math.floor(maxSize / drawn.span))
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${drawn.span} ${drawn.span}`} width={pixels} height={pixels} shapeRendering="crispEdges" className={className} style={{ background: '#fff' }}>
      <path d={drawn.path} fill="#000" />
    </svg>
  )
}
