// Highlighting of whole files for viewer and diff: Shiki with theme variables, one line at a time.
import { memo, useEffect, useState } from 'react'
import { highlight, resolveLang, type TokenLines } from '@/components/chat/highlighter'

/** Above this size the text stays plain: highlighting would block the UI. */
const MAX_HIGHLIGHT = 400_000

export function useFileTokens(text: string | null, path: string): TokenLines | null {
  const lang = resolveLang(path)
  const [state, setState] = useState<{ text: string; tokens: TokenLines } | null>(null)
  useEffect(() => {
    if (!text || !lang || text.length > MAX_HIGHLIGHT) return
    let cancelled = false
    highlight(text, lang).then(
      (tokens) => {
        if (!cancelled) setState({ text, tokens })
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [text, lang])
  return state && state.text === text ? state.tokens : null
}

const ITALIC = 1
const BOLD = 2

/** A line of code: the tokens if there are any, otherwise the text. */
export const CodeText = memo(function CodeText({ text, tokens }: { text: string; tokens: TokenLines[number] | undefined }) {
  if (!tokens) return <>{text || ' '}</>
  if (tokens.length === 0) return <> </>
  return (
    <>
      {tokens.map((token, i) => {
        const fs = token.fontStyle ?? 0
        return (
          <span key={i} style={{ color: token.color, fontStyle: fs & ITALIC ? 'italic' : undefined, fontWeight: fs & BOLD ? 600 : undefined }}>
            {token.content}
          </span>
        )
      })}
    </>
  )
})
