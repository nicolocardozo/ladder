// Markdown dell'agente con react-markdown e GFM.
// Il testo è diviso in blocchi memorizzati: durante lo streaming si rianalizza solo l'ultimo.
import { ImageIcon } from 'lucide-react'
import { memo, useMemo, type ComponentProps, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { FileChip } from './bits'
import { CodeBlock } from './code-block'
import { parseFileHref, parseFileRef } from './format'
import { isLangName } from './highlighter'

interface Block {
  text: string
  /** Il blocco finisce dentro un recinto ``` non ancora chiuso. */
  openFence: boolean
}

/**
 * Divide il markdown sulle righe vuote fuori dai blocchi di codice.
 * Non divide quando la riga successiva è indentata (continuazione di un elemento di elenco).
 */
export function splitBlocks(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let current: string[] = []
  let fence: { char: string; size: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (fence) {
      current.push(line)
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (close && close[1][0] === fence.char && close[1].length >= fence.size) fence = null
      continue
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (open) {
      fence = { char: open[1][0], size: open[1].length }
      current.push(line)
      continue
    }
    if (line.trim() === '') {
      let j = i + 1
      while (j < lines.length && lines[j].trim() === '') j++
      const next = lines[j]
      if (current.length > 0 && next !== undefined && !/^\s/.test(next)) {
        blocks.push({ text: current.join('\n'), openFence: false })
        current = []
        i = j - 1
        continue
      }
    }
    current.push(line)
  }
  if (current.length > 0) blocks.push({ text: current.join('\n'), openFence: fence !== null })
  return blocks
}

type HastNode = NonNullable<ExtraProps['node']>

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'props' in node) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

/** Linguaggio e percorso dall'info string: ```ts src/x.ts, ```src/x.ts, ```ts title="src/x.ts", ```ts:src/x.ts */
function parseInfo(langClass: string | null, meta: string | null): { lang: string | null; path: string | null } {
  let lang = langClass
  let path: string | null = null
  if (lang && lang.includes(':') && !isLangName(lang)) {
    const [l, ...rest] = lang.split(':')
    lang = l || null
    path = rest.join(':') || null
  }
  if (lang && !isLangName(lang) && parseFileRef(lang)) {
    path = lang
    lang = null
  }
  if (meta && !path) {
    const attr = /(?:title|file|filename|path)=["']?([^"'\s]+)["']?/.exec(meta)
    if (attr) path = attr[1]
    else {
      const candidate = meta.split(/\s+/).find((part) => parseFileRef(part))
      if (candidate) path = candidate
    }
  }
  if (!lang && path) {
    const dot = path.lastIndexOf('.')
    lang = dot >= 0 ? path.slice(dot + 1) : null
  }
  return { lang, path }
}

function makePre(live: boolean) {
  return function Pre({ node, children }: ComponentProps<'pre'> & ExtraProps) {
    const codeEl = node?.children?.[0] as HastNode | undefined
    if (codeEl && codeEl.type === 'element' && codeEl.tagName === 'code') {
      const classes = codeEl.properties?.className
      const langClass = Array.isArray(classes)
        ? (classes.map(String).find((c) => c.startsWith('language-'))?.slice(9) ?? null)
        : null
      const meta = (codeEl.data as { meta?: string | null } | undefined)?.meta ?? null
      const raw = codeEl.children.map((child) => (child.type === 'text' ? child.value : '')).join('')
      const code = raw.endsWith('\n') ? raw.slice(0, -1) : raw
      const { lang, path } = parseInfo(langClass, meta)
      return <CodeBlock code={code} lang={lang} path={path} live={live} />
    }
    return <pre>{children}</pre>
  }
}

function InlineCode({ children }: ComponentProps<'code'> & ExtraProps) {
  const text = textOf(children)
  const ref = parseFileRef(text)
  if (ref) return <FileChip path={ref.path} line={ref.line} />
  return <code>{children}</code>
}

function Link({ href, children }: ComponentProps<'a'> & ExtraProps) {
  const ref = href ? parseFileHref(href) : null
  if (ref) {
    const label = textOf(children).trim()
    return <FileChip path={ref.path} line={ref.line} label={label || undefined} />
  }
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

function Table({ children }: ComponentProps<'table'> & ExtraProps) {
  return (
    <div className="chat-wide">
      <div className="chat-md-table">
        <table>{children}</table>
      </div>
    </div>
  )
}

/** Le immagini esterne sono bloccate dalla CSP: al loro posto un link. */
function Img({ src, alt }: ComponentProps<'img'> & ExtraProps) {
  if (typeof src !== 'string' || !src) return null
  return (
    <a href={src} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">
      <ImageIcon aria-hidden className="size-[0.9em]" />
      {alt || t('Image')}
    </a>
  )
}

const baseComponents: Components = { code: InlineCode, a: Link, table: Table, img: Img }
const components: Components = { ...baseComponents, pre: makePre(false) }
const liveComponents: Components = { ...baseComponents, pre: makePre(true) }
const remarkPlugins = [remarkGfm]

const MarkdownBlock = memo(function MarkdownBlock({ source, live }: { source: string; live: boolean }) {
  return (
    <div className="chat-md-b">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={live ? liveComponents : components}>
        {source}
      </ReactMarkdown>
    </div>
  )
})

interface MarkdownProps {
  text: string
  streaming?: boolean
  /** Messaggi intermedi dentro i passaggi: più piccoli e meno contrastati. */
  compact?: boolean
  className?: string
}

export const Markdown = memo(function Markdown({ text, streaming, compact, className }: MarkdownProps) {
  const blocks = useMemo(() => splitBlocks(text), [text])
  return (
    <div
      className={cn(
        'chat-md',
        compact ? 'chat-md-compact text-sm leading-[1.55]' : 'text-foreground',
        className
      )}
      data-streaming={streaming ? '' : undefined}
    >
      {blocks.map((block, i) => (
        <MarkdownBlock key={i} source={block.text} live={!!streaming && i === blocks.length - 1 && block.openFence} />
      ))}
    </div>
  )
})
