// Posizione di un carattere dentro una textarea, misurata con un div specchio che ne copia lo stile.
const COPIED = [
  'direction',
  'boxSizing',
  'width',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderStyle',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
  'wordBreak',
  'overflowWrap'
] as const

/** Coordinate del carattere in `position`, relative al bordo esterno della textarea e già al netto dello scroll. */
export function caretCoordinates(el: HTMLTextAreaElement, position: number): { top: number; left: number; height: number } {
  const computed = window.getComputedStyle(el)
  const mirror = document.createElement('div')
  const style = mirror.style
  for (const prop of COPIED) style[prop] = computed[prop]
  style.position = 'absolute'
  style.visibility = 'hidden'
  style.top = '0'
  style.left = '-9999px'
  style.whiteSpace = 'pre-wrap'
  style.overflow = 'hidden'
  style.height = 'auto'
  mirror.textContent = el.value.slice(0, position)
  const marker = document.createElement('span')
  marker.textContent = el.value.slice(position) || '.'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const borderTop = parseFloat(computed.borderTopWidth) || 0
  const borderLeft = parseFloat(computed.borderLeftWidth) || 0
  const lineHeight = parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.4
  const result = {
    top: marker.offsetTop + borderTop - el.scrollTop,
    left: marker.offsetLeft + borderLeft - el.scrollLeft,
    height: lineHeight
  }
  mirror.remove()
  return result
}
