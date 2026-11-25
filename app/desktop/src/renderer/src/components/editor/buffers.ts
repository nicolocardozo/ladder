// State of files open as tabs: lives outside React, so text, undo history and scroll survive tab switches.
import { EditorState, Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { FileWriteResult } from '@shared/protocol'
import { request } from '@/lib/host-client'

export interface FileBuffer {
  root: string
  path: string
  state: EditorState | null
  /** Content on disk at the last read or save: decides whether there are changes. */
  saved: Text
  /** Modification time on disk that the text knows about: used to avoid overwriting an agent's work. */
  mtime: number
  crlf: boolean
  scrollTop: number
  saving: boolean
  view: EditorView | null
  /** Keys and edits go through here: the EditorState keeps this function even when the view unmounts. */
  onChange: (state: EditorState) => void
  onSave: () => void
}

const buffers = new Map<string, FileBuffer>()

export const getBuffer = (id: string) => buffers.get(id)
export const disposeBuffer = (id: string) => void buffers.delete(id)

export function toText(text: string): Text {
  return Text.of(text.split(/\r\n?|\n/))
}

export function createBuffer(id: string, root: string, path: string, text: string, mtime: number): FileBuffer {
  const buffer: FileBuffer = {
    root,
    path,
    state: null,
    saved: toText(text),
    mtime,
    // A fully CRLF file stays CRLF: otherwise the first save would change every line.
    crlf: /\r\n/.test(text) && !/(^|[^\r])\n/.test(text),
    scrollTop: 0,
    saving: false,
    view: null,
    onChange: () => undefined,
    onSave: () => undefined
  }
  buffers.set(id, buffer)
  return buffer
}

export function currentDoc(buffer: FileBuffer): Text {
  return buffer.state?.doc ?? buffer.saved
}

/** Replaces the text touching only the differing part, so cursor and scroll stay where they are. */
export function replaceDoc(buffer: FileBuffer, text: string): void {
  const state = buffer.view?.state ?? buffer.state
  if (!state) return
  const next = toText(text).toString()
  const old = state.doc.toString()
  let start = 0
  while (start < old.length && start < next.length && old[start] === next[start]) start++
  let end = 0
  while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end++
  const changes = { from: start, to: old.length - end, insert: next.slice(start, next.length - end) }
  if (buffer.view) buffer.view.dispatch({ changes })
  else buffer.state = state.update({ changes }).state
}

export type SaveResult = { kind: 'saved' } | { kind: 'conflict'; text: string; mtime: number } | { kind: 'error'; message: string }

export async function saveBuffer(buffer: FileBuffer, force = false): Promise<SaveResult> {
  const state = buffer.view?.state ?? buffer.state
  if (!state) return { kind: 'saved' }
  const text = state.sliceDoc()
  buffer.saving = true
  try {
    const result = await request<FileWriteResult>({ type: 'fs.write', root: buffer.root, path: buffer.path, text, baseMtime: force ? null : buffer.mtime })
    if (!result.ok) return { kind: 'conflict', text: result.text, mtime: result.mtimeMs }
    buffer.saved = state.doc
    buffer.mtime = result.mtimeMs
    return { kind: 'saved' }
  } catch (error) {
    return { kind: 'error', message: (error as Error).message }
  } finally {
    buffer.saving = false
  }
}
