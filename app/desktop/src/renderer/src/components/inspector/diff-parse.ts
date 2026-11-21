// Lettura del diff unificato di git in blocchi e righe, più l'allineamento per la vista affiancata.

export interface DiffLine {
  kind: 'context' | 'add' | 'del'
  oldNo: number | null
  newNo: number | null
  text: string
}

export interface Hunk {
  header: string
  /** Testo dopo il secondo @@: di solito la funzione che contiene il blocco. */
  section: string
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = []
  let current: Hunk | null = null
  let oldNo = 0
  let newNo = 0
  for (const raw of patch.split('\n')) {
    const match = HUNK.exec(raw)
    if (match) {
      oldNo = Number(match[1])
      newNo = Number(match[3])
      current = { header: raw, section: match[5].trim(), oldStart: oldNo, newStart: newNo, lines: [] }
      hunks.push(current)
      continue
    }
    if (!current) continue // intestazione del file: diff --git, index, ---, +++
    if (raw.startsWith('\\')) continue // "\ No newline at end of file"
    const sign = raw[0]
    const text = raw.slice(1)
    if (sign === '+') current.lines.push({ kind: 'add', oldNo: null, newNo: newNo++, text })
    else if (sign === '-') current.lines.push({ kind: 'del', oldNo: oldNo++, newNo: null, text })
    else if (sign === ' ' || raw === '') current.lines.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text })
  }
  // Una riga vuota finale del patch non è una riga di contesto.
  for (const hunk of hunks) {
    const last = hunk.lines[hunk.lines.length - 1]
    if (last && last.kind === 'context' && last.text === '' && hunk === hunks[hunks.length - 1]) hunk.lines.pop()
  }
  return hunks
}

export interface SplitRow {
  left: DiffLine | null
  right: DiffLine | null
}

/** Righe affiancate: le tolte a sinistra e le aggiunte a destra, appaiate nell'ordine in cui arrivano. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.kind === 'context') {
      rows.push({ left: line, right: line })
      i++
      continue
    }
    const dels: DiffLine[] = []
    const adds: DiffLine[] = []
    while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++])
    while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++])
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null })
  }
  return rows
}

/** Chiave stabile di una riga per i commenti: lato e numero di riga. */
export function lineKey(line: DiffLine): string {
  return line.kind === 'del' ? `o${line.oldNo}` : `n${line.newNo}`
}
