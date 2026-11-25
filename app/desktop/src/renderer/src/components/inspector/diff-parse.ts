// Parsing of git's unified diff into hunks and lines, plus the alignment for the side-by-side view.

export interface DiffLine {
  kind: 'context' | 'add' | 'del'
  oldNo: number | null
  newNo: number | null
  text: string
}

export interface Hunk {
  header: string
  /** Text after the second @@: usually the function containing the hunk. */
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
    if (!current) continue // file header: diff --git, index, ---, +++
    if (raw.startsWith('\\')) continue // "\ No newline at end of file"
    const sign = raw[0]
    const text = raw.slice(1)
    if (sign === '+') current.lines.push({ kind: 'add', oldNo: null, newNo: newNo++, text })
    else if (sign === '-') current.lines.push({ kind: 'del', oldNo: oldNo++, newNo: null, text })
    else if (sign === ' ' || raw === '') current.lines.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text })
  }
  // A trailing empty line of the patch is not a context line.
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

/** Side-by-side rows: removed lines on the left and added ones on the right, paired in the order they arrive. */
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

/** Stable key of a line for comments: side and line number. */
export function lineKey(line: DiffLine): string {
  return line.kind === 'del' ? `o${line.oldNo}` : `n${line.newNo}`
}
