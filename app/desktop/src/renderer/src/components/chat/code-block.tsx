// Code block: header with path or language, Copy (and Run for shell blocks), horizontal scrolling, Shiki when ready.
import { Check, Copy, Play } from 'lucide-react'
import { Fragment, memo, useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { commandOfBlock, isShellBlock, runInSessionTerminal } from '@/lib/run-command'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { useChatActions } from './chat-context'
import { getCachedTokens, highlight, resolveLang, type TokenLines } from './highlighter'

interface CodeBlockProps {
  code: string
  /** Block label: ```ts */
  lang: string | null
  /** Path from the rest of the info string: ```ts src/x.ts */
  path: string | null
  /** The block is still streaming in: no highlighting until it is closed. */
  live?: boolean
}

function useTokens(code: string, langLabel: string | null, path: string | null, enabled: boolean) {
  const lang = resolveLang(langLabel) ?? resolveLang(path)
  const [state, setState] = useState<{ code: string; lang: string; tokens: TokenLines } | null>(() => {
    const tokens = lang ? getCachedTokens(code, lang) : null
    return tokens && lang ? { code, lang, tokens } : null
  })
  useEffect(() => {
    if (!enabled || !lang) return
    let cancelled = false
    highlight(code, lang).then(
      (tokens) => {
        if (!cancelled) setState({ code, lang, tokens })
      },
      () => {
        // Without highlighting the text stays readable: no error to show.
      }
    )
    return () => {
      cancelled = true
    }
  }, [code, lang, enabled])
  return state && state.code === code && state.lang === lang ? state.tokens : null
}

const FONT_STYLE_ITALIC = 1
const FONT_STYLE_BOLD = 2
const FONT_STYLE_UNDERLINE = 4

/** Same structure as the plain text (lines separated by \n): the height does not change when the colors arrive. */
function Highlighted({ tokens }: { tokens: TokenLines }) {
  return (
    <>
      {tokens.map((line, i) => (
        <Fragment key={i}>
          {line.map((token, j) => {
            const fs = token.fontStyle ?? 0
            return (
              <span
                key={j}
                style={{
                  color: token.color,
                  fontStyle: fs & FONT_STYLE_ITALIC ? 'italic' : undefined,
                  fontWeight: fs & FONT_STYLE_BOLD ? 600 : undefined,
                  textDecoration: fs & FONT_STYLE_UNDERLINE ? 'underline' : undefined
                }}
              >
                {token.content}
              </span>
            )
          })}
          {i < tokens.length - 1 ? '\n' : null}
        </Fragment>
      ))}
    </>
  )
}

/**
 * Run for a shell block of a chat session: the command runs in a terminal of the session, in its folder (the worktree when it
 * has one), so a command copied from the chat never runs in the wrong checkout. Not while the block streams in.
 */
function RunButton({ code }: { code: string }) {
  const { sessionId } = useChatActions()
  const session = useApp((s) => (sessionId ? s.sessions[sessionId] : undefined))
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  if (!session || session.archived || session.mode === 'terminal') return null
  const command = commandOfBlock(code)
  if (!command) return null
  const onRun = () => {
    setState({ busy: true, error: null })
    runInSessionTerminal(session.projectId, session.id, command).then(
      () => setState({ busy: false, error: null }),
      (error: unknown) => setState({ busy: false, error: error instanceof Error ? error.message : String(error) })
    )
  }
  return (
    <>
      <button
        type="button"
        onClick={onRun}
        disabled={state.busy}
        title={state.error ?? t('Run in a terminal of this session, in {cwd}', { cwd: session.cwd })}
        aria-label={t('Run in terminal')}
        className={cn(
          'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[5px] border border-border px-1.5 font-sans text-xs font-medium text-secondary-foreground outline-none transition-colors dark:border-input/70',
          'hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60',
          state.error && 'text-destructive'
        )}
      >
        <Play className="size-3" strokeWidth={1.9} />
        {t('Run')}
      </button>
      <span aria-live="polite" className="sr-only">
        {state.error ?? ''}
      </span>
    </>
  )
}

export const CodeBlock = memo(function CodeBlock({ code, lang, path, live }: CodeBlockProps) {
  const { openFile } = useChatActions()
  const tokens = useTokens(code, lang, path, !live)
  const codeRef = useRef<HTMLElement>(null)
  const [copied, setCopied] = useState<'copied' | 'selected' | null>(null)
  const resetRef = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(resetRef.current), [])

  const flash = (value: 'copied' | 'selected') => {
    setCopied(value)
    window.clearTimeout(resetRef.current)
    resetRef.current = window.setTimeout(() => setCopied(null), 1600)
  }

  const selectText = () => {
    const node = codeRef.current
    const selection = window.getSelection()
    if (!node || !selection) return false
    const range = document.createRange()
    range.selectNodeContents(node)
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  }

  const onCopy = () => {
    // The call stays in the click handler: the clipboard permission requires a user gesture.
    const fallback = () => {
      if (!selectText()) return
      let ok = false
      try {
        ok = document.execCommand('copy')
      } catch {
        ok = false
      }
      flash(ok ? 'copied' : 'selected')
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(() => flash('copied'), fallback)
    } else {
      fallback()
    }
  }

  const label = lang

  return (
    <div className="chat-wide overflow-hidden rounded-[9px] border border-border bg-[var(--chat-code-bg)] dark:border-input/70">
      <div className="flex h-8 items-center gap-2 border-b border-border bg-[var(--chat-code-head)] pr-1.5 pl-3 font-mono text-xs font-medium text-muted-foreground dark:border-input/70">
        {path ? (
          <button
            type="button"
            onClick={(event) => openFile(path, undefined, event.altKey)}
            title={t('Open {path}', { path })}
            className="min-w-0 truncate text-left text-foreground/85 outline-none hover:text-foreground hover:underline focus-visible:underline"
          >
            {path}
          </button>
        ) : null}
        {label ? <span className={cn('shrink-0', path && 'text-faint')}>{path ? `· ${label}` : label}</span> : null}
        {!path && !label ? <span>{t('text')}</span> : null}
        <span className="flex-1" />
        {!live && isShellBlock(lang) ? <RunButton code={code} /> : null}
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied === 'copied' ? t('Copied') : t('Copy code')}
          className={cn(
            'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[5px] border border-border px-1.5 font-sans text-xs font-medium text-secondary-foreground outline-none transition-colors dark:border-input/70',
            'hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
            copied === 'copied' && 'text-success'
          )}
        >
          {copied === 'copied' ? <Check className="size-3" strokeWidth={2.2} /> : <Copy className="size-3" strokeWidth={1.9} />}
          {copied === 'copied' ? t('Copied') : copied === 'selected' ? t('Selected') : t('Copy')}
        </button>
        <span aria-live="polite" className="sr-only">
          {copied === 'copied' ? t('Code copied') : ''}
        </span>
      </div>
      <pre className="m-0 overflow-x-auto px-3 py-2.5 font-[family-name:var(--font-code)] text-xs leading-[1.62] text-[var(--shiki-foreground)]">
        <code ref={codeRef} className="block w-max min-w-full whitespace-pre">
          {tokens ? <Highlighted tokens={tokens} /> : code}
        </code>
      </pre>
    </div>
  )
})
