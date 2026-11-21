// Editor leggero per i file aperti come tab: CodeMirror 6 con i colori del tema. Niente linguaggi "intelligenti": per quelli c'è Cursor.
import { useEffect, useRef } from 'react'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, HighlightStyle, indentOnInput, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { unifiedMergeView } from '@codemirror/merge'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import { crosshairCursor, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { t } from '@shared/i18n'
import { currentDoc, type FileBuffer } from './buffers'

const language = new Compartment()
const compare = new Compartment()

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword], color: 'var(--shiki-token-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--shiki-token-string)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.function(tags.variableName)), tags.macroName], color: 'var(--shiki-token-function)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.constant(tags.name), tags.typeName, tags.className, tags.namespace], color: 'var(--shiki-token-constant)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: 'var(--shiki-token-comment)' },
  { tag: [tags.punctuation, tags.separator, tags.bracket, tags.operator], color: 'var(--shiki-token-punctuation)' },
  { tag: [tags.link, tags.url], color: 'var(--shiki-token-link)' },
  { tag: tags.heading, color: 'var(--shiki-token-keyword)', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.inserted, color: 'var(--shiki-token-inserted)' },
  { tag: tags.deleted, color: 'var(--shiki-token-deleted)' },
  { tag: tags.invalid, color: 'var(--ladder-error)' }
])

const control = {
  backgroundColor: 'var(--background)',
  backgroundImage: 'none',
  color: 'var(--foreground)',
  border: '1px solid var(--input)',
  borderRadius: '6px',
  fontSize: '12px',
  fontFamily: 'inherit'
}

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', backgroundColor: 'var(--background)', color: 'var(--foreground)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '20px', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--primary)', padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'var(--background)', color: 'var(--faint)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 16px', fontVariantNumeric: 'tabular-nums' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--foreground) 5%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--muted-foreground)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--primary)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--ladder-selection)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in oklab, var(--primary) 18%, transparent)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in oklab, var(--primary) 26%, transparent)', outline: 'none' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in oklab, var(--ladder-waiting) 30%, transparent)', outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in oklab, var(--ladder-waiting) 55%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--card)', color: 'var(--foreground)' },
  '.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panel.cm-search': { padding: '8px 12px', fontFamily: 'var(--font-sans)', fontSize: '12px' },
  '.cm-panel.cm-search label': { fontSize: '12px', color: 'var(--muted-foreground)' },
  '.cm-textfield': { ...control, padding: '3px 6px' },
  '.cm-button': { ...control, padding: '3px 8px' },
  '.cm-panel button[name=close]': { color: 'var(--muted-foreground)', fontSize: '16px' },
  '.cm-changedLine': { backgroundColor: 'color-mix(in oklab, var(--color-diff-added) 13%, transparent) !important' },
  '.cm-deletedChunk': { backgroundColor: 'color-mix(in oklab, var(--color-diff-removed) 13%, transparent)' },
  '.cm-changedText, .cm-insertedLine .cm-changedText': { background: 'color-mix(in oklab, var(--color-diff-added) 30%, transparent)' },
  '.cm-deletedChunk .cm-deletedText': { background: 'color-mix(in oklab, var(--color-diff-removed) 30%, transparent)' },
  '.cm-changeGutter': { width: '3px' },
  '.cm-changedLineGutter': { background: 'var(--color-diff-added)' },
  '.cm-deletedLineGutter': { background: 'var(--color-diff-removed)' }
})

function createState(buffer: FileBuffer): EditorState {
  return EditorState.create({
    doc: buffer.saved,
    extensions: [
      ...(buffer.crlf ? [EditorState.lineSeparator.of('\r\n')] : []),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(highlight, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      EditorView.contentAttributes.of({ 'aria-label': t('Text of {file}', { file: buffer.path }) }),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            buffer.onSave()
            return true
          }
        },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        indentWithTab
      ]),
      language.of([]),
      compare.of([]),
      theme,
      EditorView.updateListener.of((update) => {
        buffer.state = update.state
        if (update.docChanged) buffer.onChange(update.state)
      })
    ]
  })
}

export function CodeEditor({ buffer, compareWith }: { buffer: FileBuffer; compareWith: string | null }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!host.current) return
    const created = !buffer.state
    const state = buffer.state ?? createState(buffer)
    buffer.state = state
    const view = new EditorView({ state, parent: host.current })
    buffer.view = view
    view.scrollDOM.scrollTop = buffer.scrollTop
    view.focus()
    if (created) {
      // La grammatica si carica a parte, solo per i linguaggi che apri.
      void LanguageDescription.matchFilename(languages, buffer.path)
        ?.load()
        .then((support) => {
          if (buffer.view === view) view.dispatch({ effects: language.reconfigure(support) })
          else if (buffer.state) buffer.state = buffer.state.update({ effects: language.reconfigure(support) }).state
        })
        .catch(() => undefined)
    }
    return () => {
      buffer.scrollTop = view.scrollDOM.scrollTop
      buffer.state = view.state
      buffer.view = null
      view.destroy()
    }
  }, [buffer])

  useEffect(() => {
    buffer.view?.dispatch({
      effects: compare.reconfigure(compareWith === null ? [] : unifiedMergeView({ original: compareWith, gutter: true, mergeControls: false, highlightChanges: true }))
    })
  }, [buffer, compareWith])

  return <div ref={host} data-doc-length={currentDoc(buffer).length} className="min-h-0 flex-1 overflow-hidden" />
}
