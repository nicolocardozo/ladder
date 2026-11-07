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
`

export type Db = DatabaseSync

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('pragma journal_mode = wal; pragma synchronous = normal; pragma foreign_keys = on;')
  db.exec(SCHEMA)
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
}

export interface ProjectRow {
  id: string
  name: string
  path: string
  added_at: number
}
