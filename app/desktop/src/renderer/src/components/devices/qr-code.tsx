// QR di abbinamento. Sempre moduli scuri su tessera bianca con margine di 4 moduli, in ogni tema: i telefoni lo leggono solo così.
// Si disegna a mano dalla matrice di `qrcode` (un solo <path>, bordi netti) invece di iniettare un SVG come testo.
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
          // Una striscia di moduli scuri vicini è un solo rettangolo.
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
  // Un numero intero di pixel per modulo: i bordi restano netti e il telefono non deve interpolare.
  const pixels = drawn.span * Math.max(2, Math.floor(maxSize / drawn.span))
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${drawn.span} ${drawn.span}`} width={pixels} height={pixels} shapeRendering="crispEdges" className={className} style={{ background: '#fff' }}>
      <path d={drawn.path} fill="#000" />
    </svg>
  )
}
