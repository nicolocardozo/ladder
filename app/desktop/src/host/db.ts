// Archivio locale dell'host: SQLite con node:sqlite (incluso in Node 24, niente moduli nativi da ricompilare).
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
create table if not exists projects (
  id text primary key,
  name text not null,
  path text not null unique,
  added_at integer not null
);
create table if not exists sessions (
  id text primary key,
  project_id text not null,
  title text not null,
  agent text not null,
  model text,
  effort text,
  permission text not null,
  created_at integer not null,
  updated_at integer not null,
  archived integer not null default 0,
  external_id text,
  run_state text not null default 'idle',
  last_seq integer not null default 0,
  last_activity_seq integer not null default 0,
  last_read_seq integer not null default 0,
  queue text not null default '[]',
  context text
);
create table if not exists items (
  session_id text not null,
  id text not null,
  seq integer not null,
  json text not null,
  primary key (session_id, id)
);
create index if not exists items_by_seq on items (session_id, seq);
create table if not exists events (
  seq integer primary key autoincrement,
  session_id text,
  type text not null,
  payload text not null,
  at integer not null
);
create table if not exists drafts (
  key text primary key,
  text text not null,
  updated_at integer not null
);
create table if not exists kv (
  key text primary key,
  value text not null
);
create table if not exists ui_state (
  project_id text primary key,
  json text not null
);
create table if not exists checkpoints (
  id text primary key,
  session_id text not null,
  turn_id text,
  kind text not null,
  sha text not null,
  root text not null,
  label text,
  at integer not null
);
create index if not exists checkpoints_by_session on checkpoints (session_id, at);
create index if not exists checkpoints_by_root on checkpoints (root, at);
create table if not exists profiles (
  id text primary key,
  agent text not null,
  name text not null,
  config_dir text not null,
  added_at integer not null
);
create table if not exists project_profiles (
  project_id text not null,
  agent text not null,
  profile_id text not null,
  primary key (project_id, agent)
);
create table if not exists terminals (
  id text primary key,
  project_id text not null,
  session_id text,
  kind text not null,
  title text not null,
  cwd text not null,
  command text,
  created_at integer not null,
  scrollback text,
  meta text
);
`

/** Colonne aggiunte dopo la prima versione: si creano se mancano, i dati esistenti restano. */
const COLUMNS: [table: string, column: string, definition: string][] = [
  ['sessions', 'mode', "text not null default 'chat'"],
  ['sessions', 'command', 'text'],
  ['sessions', 'cwd', 'text'],
  ['sessions', 'worktree', 'text'],
  ['sessions', 'estimated', 'integer not null default 0'],
  ['sessions', 'agent_ref', 'text'],
  ['sessions', 'activity_at', 'integer not null default 0'],
  ['sessions', 'source', 'text'],
  // 'provisional' | 'generated' | 'user': le sessioni esistenti diventano 'user' alla migrazione (vedi migrate), nuove partono provvisorie.
  ['sessions', 'title_source', "text not null default 'provisional'"],
  // Profilo (account) della sessione, fissato alla creazione; null = predefinito (anche per le sessioni nate prima dei profili).
  ['sessions', 'profile_id', 'text'],
  // Livello chiesto a turno in corso che l'agente applica dal turno successivo (Codex).
  ['sessions', 'permission_next', 'text'],
  // Sessione archiviata dopo l'unione ('git' | 'pr') e quando: la mappa dei branch (LAD-80) la ricorda anche dopo un riavvio. Null = non nota.
  ['sessions', 'merged_via', 'text'],
  ['sessions', 'merged_at', 'integer'],
  // JSON {sessionId, agent} of the session this one comes from ("Switch to…"); null = normal session.
  ['sessions', 'handoff_from', 'text'],
  // JSON of the handoff in progress (summary turn open); after a restart 'summarizing' stays only if this is still set, and must be closed.
  ['sessions', 'handoff', 'text'],
  // JSON {sessionId, role, itemId} of the parent session that launched this one (advice, delegation, review); null = normal session.
  ['sessions', 'parent', 'text']
]

function migrate(db: DatabaseSync): void {
  for (const [table, column, definition] of COLUMNS) {
    const columns = db.prepare(`pragma table_info(${table})`).all() as { name: string }[]
    if (columns.some((c) => c.name === column)) continue
    db.exec(`alter table ${table} add column ${column} ${definition}`)
    // Non si sa quali titoli esistenti siano stati rinominati a mano: tutti si considerano dell'utente, nessuna rigenerazione automatica li tocca.
    if (column === 'title_source') db.exec("update sessions set title_source = 'user'")
  }
}

export type Db = DatabaseSync

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('pragma journal_mode = wal; pragma synchronous = normal; pragma foreign_keys = on;')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/** Esegue `fn` in una transazione: gli aggiornamenti di elementi ed eventi arrivano insieme o per niente. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('begin')
  try {
    const result = fn()
    db.exec('commit')
    return result
  } catch (error) {
    db.exec('rollback')
    throw error
  }
}

export interface SessionRow {
  id: string
  project_id: string
  title: string
  agent: string
  model: string | null
  effort: string | null
  permission: string
  created_at: number
  updated_at: number
  archived: number
  external_id: string | null
  run_state: string
  last_seq: number
  last_activity_seq: number
  last_read_seq: number
  queue: string
  context: string | null
  mode: string
  command: string | null
  /** Cartella di lavoro; null per le sessioni nate prima della fase 2 (= cartella del progetto). */
  cwd: string | null
  /** JSON di WorktreeInfo. */
  worktree: string | null
  estimated: number
  /** Riferimento dell'agente per le sessioni terminale: id della conversazione di Claude Code. */
  agent_ref: string | null
  /** Ultima attività dell'agente; 0 per le sessioni nate prima della fase 3 (vale updated_at). */
  activity_at: number
  /** JSON di SessionSource: issue, PR o branch da cui è nata. */
  source: string | null
  /** TitleSource: chi ha scelto il titolo. */
  title_source: string
  /** Profilo non predefinito con cui gira la sessione; null = predefinito. */
  profile_id: string | null
  /** Livello di permessi in attesa del turno successivo; null se nessuno. */
  permission_next: string | null
  /** 'git' | 'pr' se la sessione è stata archiviata come unita (LAD-80); null altrimenti. */
  merged_via: string | null
  merged_at: number | null
  /** JSON {sessionId, agent}: session this one comes from via "Switch to…"; null if normal. */
  handoff_from: string | null
  /** JSON of HandoffRun: handoff whose summary turn is in progress; null otherwise. */
  handoff: string | null
  /** JSON {sessionId, role, itemId}: parent session of a child session; null if normal. */
  parent: string | null
}

export interface CheckpointRow {
  id: string
  session_id: string
  turn_id: string | null
  kind: 'start' | 'end' | 'undo'
  sha: string
  root: string
  label: string | null
  at: number
}

export interface ProjectRow {
  id: string
  name: string
  path: string
  added_at: number
}
