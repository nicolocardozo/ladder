// Modifiche, file e cronologia di una cartella di lavoro: diff per ambito, ripristino con annullamento e linea del tempo.
import { createHash, randomUUID } from 'node:crypto'
import type { ChatItem, DiffResult, DiffScope, FilePatch, HistoryEntry } from '@shared/protocol'
import type { CheckpointRow, Db, SessionRow } from './db'
import { blobAt, changedFiles, commitLog, createCheckpoint, EMPTY_TREE, filePatch, parentOf, repoInfo, resolveCommit, restorePaths } from './git'

const MAX_PATCH = 2 * 1024 * 1024

/** Fotografia dello stato attuale, su un ref fisso per cartella: il lato "dopo" dei diff attuali. */
export async function liveSnapshot(root: string): Promise<string> {
  const key = createHash('sha1').update(root).digest('hex').slice(0, 16)
  const sha = await createCheckpoint(root, `refs/ladder/live/${key}`, 'ladder: stato attuale')
  if (!sha) throw new Error('Il diff richiede un repository git.')
  return sha
}

export function recordCheckpoint(db: Db, row: Omit<CheckpointRow, 'id'>): void {
  db.prepare('insert into checkpoints (id, session_id, turn_id, kind, sha, root, label, at) values (?, ?, ?, ?, ?, ?, ?, ?)').run(
    randomUUID(),
    row.session_id,
    row.turn_id,
    row.kind,
    row.sha,
    row.root,
    row.label,
    row.at
  )
}

function turnCheckpoint(db: Db, sessionId: string, turnId: string, kind: 'start' | 'end'): string | null {
  const row = db.prepare('select sha from checkpoints where session_id = ? and turn_id = ? and kind = ? order by at desc limit 1').get(sessionId, turnId, kind) as
    | { sha: string }
    | undefined
  return row?.sha ?? null
}

export async function diffFiles(db: Db, root: string, scope: DiffScope): Promise<DiffResult> {
  const info = await repoInfo(root)
  if (!info.isGit) throw new Error('Il diff richiede un repository git.')
  let from: string
  let to: string
  let live = false
  switch (scope.kind) {
    case 'turn': {
      // Le sessioni della fase 1 hanno solo i ref con il nome del turno.
      const start = turnCheckpoint(db, scope.sessionId, scope.turnId, 'start') ?? (await resolveCommit(root, `refs/ladder/${scope.sessionId}/${scope.turnId}-start`))
      if (!start) throw new Error('Per questo turno non c’è un checkpoint: era fuori da git o è stato cancellato.')
      const end = turnCheckpoint(db, scope.sessionId, scope.turnId, 'end') ?? (await resolveCommit(root, `refs/ladder/${scope.sessionId}/${scope.turnId}-end`))
      from = start
      if (end) to = end
      else {
        to = await liveSnapshot(root)
        live = true
      }
      break
    }
    case 'session': {
      const first = db.prepare(`select sha from checkpoints where session_id = ? and kind = 'start' order by at limit 1`).get(scope.sessionId) as
        | { sha: string }
        | undefined
      if (!first) throw new Error('La sessione non ha ancora checkpoint: il diff arriva dopo il primo turno.')
      from = first.sha
      to = await liveSnapshot(root)
      live = true
      break
    }
    case 'uncommitted':
      from = (await resolveCommit(root, 'HEAD')) ?? EMPTY_TREE
      to = await liveSnapshot(root)
      live = true
      break
    case 'commit':
      from = await parentOf(root, scope.sha)
      to = scope.sha
      break
    case 'range':
      from = scope.from
      to = scope.to
      break
  }
  return { root, from, to, files: await changedFiles(root, from, to), live }
}

export async function diffFile(root: string, from: string, to: string, path: string, oldPath: string | null): Promise<FilePatch> {
  const [patch, before, after] = await Promise.all([
    filePatch(root, from, to, path, oldPath),
    blobAt(root, from, oldPath ?? path),
    blobAt(root, to, path)
  ])
  const tooLarge = before.tooLarge || after.tooLarge || patch.length > MAX_PATCH
  return {
    path,
    oldPath,
    patch: tooLarge ? '' : patch,
    oldText: tooLarge ? null : before.text,
    newText: tooLarge ? null : after.text,
    binary: before.binary || after.binary,
    tooLarge
  }
}

/**
 * Riporta i file allo stato `to`. Prima salva lo stato attuale in un checkpoint: restituito come `undo`,
 * basta ripristinare quello per annullare. Senza `paths` tocca tutti i file diversi da `to`.
 */
export async function restore(db: Db, root: string, to: string, paths: string[] | undefined, label: string, sessionId: string | null) {
  const undo = await createCheckpoint(root, `refs/ladder/undo/${randomUUID()}`, `ladder: prima del ripristino (${label})`)
  if (!undo) throw new Error('Il ripristino richiede un repository git.')
  let targets = paths
  if (!targets) {
    const files = await changedFiles(root, to, undo)
    targets = files.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path]))
  }
  targets = [...new Set(targets)]
  await restorePaths(root, to, targets)
  recordCheckpoint(db, { session_id: sessionId ?? '', turn_id: null, kind: 'undo', sha: undo, root, label, at: Date.now() })
  return { undo, paths: targets }
}

/** Turni (checkpoint prima di ogni richiesta), ripristini e commit in un'unica linea del tempo, dal più recente. */
export async function historyList(db: Db, root: string, sessionId: string | null, sessions: Map<string, SessionRow>): Promise<HistoryEntry[]> {
  const rows = (
    sessionId
      ? db.prepare('select * from checkpoints where session_id = ? order by at desc limit 400').all(sessionId)
      : db.prepare('select * from checkpoints where root = ? order by at desc limit 400').all(root)
  ) as unknown as CheckpointRow[]

  const entries: HistoryEntry[] = []
  const ends = new Map<string, CheckpointRow>()
  for (const row of rows) if (row.kind === 'end' && row.turn_id) ends.set(`${row.session_id}:${row.turn_id}`, row)
  const fileCount = db.prepare('select json from items where session_id = ? and id = ?')

  for (const row of rows) {
    const session = sessions.get(row.session_id)
    if (row.kind === 'start' && row.turn_id) {
      const end = ends.get(`${row.session_id}:${row.turn_id}`)
      const item = fileCount.get(row.session_id, `${row.turn_id}:end`) as { json: string } | undefined
      const turnEnd = item ? (JSON.parse(item.json) as ChatItem) : null
      entries.push({
        id: row.id,
        kind: 'turn',
        at: row.at,
        title: row.label || 'Turno senza testo',
        detail: session?.title ?? null,
        sessionId: row.session_id,
        turnId: row.turn_id,
        sha: row.sha,
        diff: end ? { from: row.sha, to: end.sha } : null,
        files: turnEnd?.kind === 'turn-end' ? turnEnd.files.length : null
      })
    } else if (row.kind === 'undo') {
      entries.push({
        id: row.id,
        kind: 'restore',
        at: row.at,
        title: `Prima del ripristino: ${row.label ?? ''}`.trim(),
        detail: session?.title ?? null,
        sessionId: row.session_id || null,
        turnId: null,
        sha: row.sha,
        diff: null,
        files: null
      })
    }
  }

  for (const commit of await commitLog(root, 40).catch(() => [])) {
    entries.push({
      id: commit.sha,
      kind: 'commit',
      at: commit.at,
      title: commit.subject,
      detail: commit.author,
      sessionId: null,
      turnId: null,
      sha: commit.sha,
      diff: { from: commit.parents[0] ?? EMPTY_TREE, to: commit.sha },
      files: null
    })
  }
  return entries.sort((a, b) => b.at - a.at)
}
