// Richieste dell'agente: card di approvazione e di domanda quando sono aperte, riga compatta quando sono chiuse.
import { ArrowUpRight, Check, CircleAlert, CircleQuestionMark, Clock, File, X } from 'lucide-react'
import { memo, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { RequestOption } from '@shared/protocol'
import { plural, t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Kbd } from './bits'
import { useChatActions, useNow } from './chat-context'
import { formatSince } from './format'
import type { RequestItem } from './turns'

const btnBase =
  'inline-flex h-8 items-center gap-2 rounded-sm border px-3 text-sm font-medium whitespace-nowrap outline-none transition-[background-color,opacity] ' +
  'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-card disabled:pointer-events-none disabled:opacity-50'
const btnPrimary = `${btnBase} border-primary bg-primary text-primary-foreground hover:opacity-90`
const btnSecondary = `${btnBase} border-input/70 bg-card text-foreground hover:bg-accent`

interface FrameProps {
  item: RequestItem
  label: string
  icon: ReactNode
  frameRef?: RefObject<HTMLDivElement | null>
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  children: ReactNode
}

/** Cornice comune: bordo neutro, barretta ambra interna dritta, etichetta esplicita. */
function CardFrame({ item, label, icon, frameRef, onKeyDown, children }: FrameProps) {
  const now = useNow(15_000)
  return (
    <div
      ref={frameRef}
      data-item-id={item.id}
      role="group"
      aria-label={`${label}: ${item.command ?? item.path ?? item.title}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="grid min-w-0 gap-2.5 rounded-xl border border-attention/45 bg-[color-mix(in_oklab,var(--card),var(--attention)_4%)] px-4 py-3.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-attention">
        {icon}
        <span className="truncate">{label}</span>
        <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground tabular-nums">{formatSince(item.at, now)}</span>
      </div>
      {children}
    </div>
  )
}

/** Oltre queste righe una modifica si legge nel diff: da "In attesa" resta solo "Apri". */
export const INLINE_PREVIEW_LINES = 40

/** Modifica proposta, righe con - e +. Nella chat oltre 40 righe si apre su richiesta. */
function EditPreview({ preview }: { preview: NonNullable<RequestItem['preview']> }) {
  const [all, setAll] = useState(false)
  const rows = preview.text.split('\n')
  const shown = all ? rows : rows.slice(0, INLINE_PREVIEW_LINES)
  const hidden = preview.lines - shown.filter((r) => r !== '…').length
  return (
    <div className="min-w-0 overflow-hidden rounded-[7px] border border-border bg-[var(--chat-code-bg)] dark:border-input/60">
      <pre className="m-0 max-h-[360px] overflow-auto py-1.5 font-mono text-xs leading-[1.55]">
        {shown.map((row, i) => (
          <div
            key={i}
            className={cn(
              'px-2.5 whitespace-pre',
              row.startsWith('+') && 'bg-[color-mix(in_oklab,var(--ladder-success)_13%,transparent)] text-foreground',
              row.startsWith('-') && 'bg-[color-mix(in_oklab,var(--ladder-error)_13%,transparent)] text-foreground',
              row === '…' && 'text-muted-foreground'
            )}
          >
            <span aria-hidden className={cn('mr-2 inline-block w-2 select-none', row[0] === '+' ? 'text-success' : row[0] === '-' ? 'text-destructive' : 'text-muted-foreground')}>
              {row[0] === '+' ? '+' : row[0] === '-' ? '−' : ' '}
            </span>
            {row === '…' ? '…' : row.slice(1)}
          </div>
        ))}
      </pre>
      {hidden > 0 || preview.truncated ? (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="w-full border-t border-border px-2.5 py-1 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 dark:border-input/60"
        >
          {all ? t('Show less') : plural(hidden, 'Show {n} more line', 'Show {n} more lines')}
          {preview.truncated && all ? ` · ${t('preview truncated')}` : ''}
        </button>
      ) : null}
    </div>
  )
}

function pickShortcuts(options: RequestOption[]) {
  const allow = options.find((o) => o.kind === 'allow') ?? null
  const always = options.find((o) => o.kind === 'allow-always') ?? null
  const deny = options.find((o) => o.kind === 'deny') ?? null
  return { primary: allow ?? always, always: allow ? always : null, deny }
}

const PermissionCard = memo(function PermissionCard({ item }: { item: RequestItem }) {
  const { respond, canTakeFocus, openFile, surface, openSession } = useChatActions()
  const frameRef = useRef<HTMLDivElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [sent, setSent] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [message, setMessage] = useState('')
  const { primary, always, deny } = pickShortcuts(item.options)

  useEffect(() => {
    if (canTakeFocus()) (primaryRef.current ?? frameRef.current)?.focus({ preventScroll: true })
    // Solo alla comparsa della card.
  }, [])

  useEffect(() => {
    if (rejecting) inputRef.current?.focus({ preventScroll: true })
  }, [rejecting])

  const sentRef = useRef(false)
  const choose = (option: RequestOption, text?: string) => {
    if (sentRef.current) return
    sentRef.current = true
    setSent(option.id)
    const trimmed = text?.trim()
    respond(item.requestId, trimmed ? { optionId: option.id, message: trimmed } : { optionId: option.id })
  }

  const onOption = (option: RequestOption) => {
    if (option.kind === 'deny') setRejecting(true)
    else choose(option)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (sent) return
    const target = event.target as HTMLElement
    const inField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
    if (inField) return
    if (event.key === 'Enter' && event.altKey && !event.metaKey && !event.ctrlKey && always) {
      event.preventDefault()
      choose(always)
    } else if (event.key === 'Backspace' && event.metaKey && deny) {
      event.preventDefault()
      setRejecting(true)
    } else if (
      event.key === 'Enter' &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      target.tagName !== 'BUTTON' &&
      primary
    ) {
      event.preventDefault()
      choose(primary)
    }
  }

  const onRejectSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (deny) choose(deny, message)
  }

  const shortcutFor = (option: RequestOption) =>
    option === primary ? '↵' : option === always ? '⌥↵' : option === deny ? '⌘⌫' : null
  // Da "In attesa" una modifica lunga si approva solo dopo averla letta nel diff della sessione.
  const tooLong = surface === 'inbox' && (item.preview?.lines ?? 0) > INLINE_PREVIEW_LINES

  return (
    <CardFrame
      item={item}
      label={t('Approval requested')}
      icon={<CircleAlert aria-hidden className="size-[15px] shrink-0" strokeWidth={2} />}
      frameRef={frameRef}
      onKeyDown={onKeyDown}
    >
      {item.title && item.title !== item.command ? (
        <p className="text-sm leading-[1.45] font-medium text-foreground">{item.title}</p>
      ) : null}
      {item.command ? (
        <pre className="m-0 rounded-[7px] border border-border bg-[var(--chat-code-bg)] px-2.5 py-2 font-mono text-sm leading-[1.5] break-words whitespace-pre-wrap text-foreground dark:border-input/60">
          {item.command}
        </pre>
      ) : item.path ? (
        <button
          type="button"
          onClick={(event) => item.path && openFile(item.path, undefined, event.altKey)}
          className="flex min-w-0 items-center gap-2 rounded-[7px] border border-border bg-[var(--chat-code-bg)] px-2.5 py-2 text-left font-mono text-sm text-foreground outline-none hover:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/50 dark:border-input/60"
        >
          <File aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{item.path}</span>
        </button>
      ) : null}
      {item.preview && !tooLong ? <EditPreview preview={item.preview} /> : null}
      {item.reason ? <p className="text-sm leading-[1.5] text-secondary-foreground">“{item.reason}”</p> : null}
      <p className="text-xs text-muted-foreground">
        {t('Tool: {name}', { name: item.toolName })}
        {item.preview ? ` · ${plural(item.preview.lines, '{n} line', '{n} lines')}` : ''}
      </p>
      {tooLong ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" data-primary onClick={() => openSession?.()} className={btnPrimary}>
            {t('Open and read the change')}
            <ArrowUpRight aria-hidden className="size-3.5" />
          </button>
          <span className="text-xs text-muted-foreground">{t('More than {n} lines: approve it from the session.', { n: INLINE_PREVIEW_LINES })}</span>
        </div>
      ) : (
      <div className="flex flex-wrap items-center gap-2">
        {item.options.map((option) => {
          const shortcut = shortcutFor(option)
          const isPrimary = option === primary
          const label = option.kind === 'deny' && !option.label.endsWith('…') ? `${option.label}…` : option.label
          return (
            <button
              key={option.id}
              ref={isPrimary ? primaryRef : undefined}
              data-primary={isPrimary ? '' : undefined}
              type="button"
              disabled={sent !== null}
              aria-pressed={option.kind === 'deny' ? rejecting : undefined}
              aria-keyshortcuts={
                shortcut === '↵' ? 'Enter' : shortcut === '⌥↵' ? 'Alt+Enter' : shortcut === '⌘⌫' ? 'Meta+Backspace' : undefined
              }
              onClick={() => onOption(option)}
              className={isPrimary ? btnPrimary : btnSecondary}
            >
              {sent === option.id ? t('Sending…') : label}
              {shortcut ? <Kbd>{shortcut}</Kbd> : null}
            </button>
          )
        })}
      </div>
      )}
      {rejecting && deny ? (
        <form onSubmit={onRejectSubmit} className="flex min-w-0 flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`reject-${item.id}`}>
            {t('Message for the agent')}
          </label>
          <input
            id={`reject-${item.id}`}
            ref={inputRef}
            value={message}
            disabled={sent !== null}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setRejecting(false)
                setMessage('')
                ;(primaryRef.current ?? frameRef.current)?.focus({ preventScroll: true })
              }
            }}
            placeholder={t('What should it do instead? Optional')}
            className="h-7 min-w-[200px] flex-1 rounded-[7px] border border-input bg-background px-2.5 text-sm text-foreground outline-none placeholder:text-faint focus:border-ring/70"
          />
          <button type="submit" disabled={sent !== null} className={btnSecondary}>
            {sent === deny.id ? t('Sending…') : deny.label}
            <Kbd>↵</Kbd>
          </button>
        </form>
      ) : null}
    </CardFrame>
  )
})

const OTHER = '\u0000altro'

const QuestionCard = memo(function QuestionCard({ item }: { item: RequestItem }) {
  const { respond, canTakeFocus } = useChatActions()
  const uid = useId()
  const frameRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLInputElement>(null)
  const questions = item.questions ?? []
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})
  const [sent, setSent] = useState(false)
  const deny = item.options.find((o) => o.kind === 'deny') ?? null

  useEffect(() => {
    if (canTakeFocus()) (firstRef.current ?? frameRef.current)?.focus({ preventScroll: true })
  }, [])

  const answerFor = (index: number): string | null => {
    const values = (picked[index] ?? []).map((v) => (v === OTHER ? (other[index] ?? '').trim() : v)).filter(Boolean)
    return values.length > 0 ? values.join(', ') : null
  }
  const valid = questions.length > 0 && questions.every((_, i) => answerFor(i) !== null)

  const toggle = (index: number, value: string, multi: boolean, on?: boolean) => {
    setPicked((prev) => {
      const current = prev[index] ?? []
      if (!multi) return { ...prev, [index]: [value] }
      const has = current.includes(value)
      const want = on ?? !has
      if (want === has) return prev
      return { ...prev, [index]: want ? [...current, value] : current.filter((v) => v !== value) }
    })
  }

  const sentRef = useRef(false)
  const submit = () => {
    if (!valid || sentRef.current) return
    sentRef.current = true
    const answers: Record<string, string> = {}
    questions.forEach((q, i) => {
      answers[q.question] = answerFor(i) ?? ''
    })
    setSent(true)
    respond(item.requestId, { answers })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && target.tagName !== 'BUTTON' && target.tagName !== 'TEXTAREA') {
      event.preventDefault()
      submit()
    }
  }

  return (
    <CardFrame
      item={item}
      label={t('Question')}
      icon={<CircleQuestionMark aria-hidden className="size-[15px] shrink-0" strokeWidth={2} />}
      frameRef={frameRef}
      onKeyDown={onKeyDown}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        className="grid gap-3.5"
      >
        {questions.map((q, qi) => {
          const name = `${uid}-q${qi}`
          const multi = q.multiSelect
          const values = picked[qi] ?? []
          const otherOn = values.includes(OTHER)
          return (
            <fieldset key={qi} disabled={sent} className="grid min-w-0 gap-0.5">
              <legend className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm leading-[1.45] font-medium text-foreground">
                {q.header ? (
                  <span className="rounded-md bg-muted px-1.5 text-xs font-medium text-muted-foreground">
                    {q.header}
                  </span>
                ) : null}
                <span>{q.question}</span>
                {multi ? <span className="text-xs font-normal text-muted-foreground">{t('Multiple choice')}</span> : null}
              </legend>
              {q.options.map((opt, oi) => {
                const checked = values.includes(opt.label)
                return (
                  <label
                    key={oi}
                    className={cn(
                      '-mx-2 flex cursor-pointer items-start gap-2.5 rounded-[7px] px-2 py-[5px] transition-colors',
                      checked ? 'bg-accent' : 'hover:bg-accent/60'
                    )}
                  >
                    <input
                      ref={qi === 0 && oi === 0 ? firstRef : undefined}
                      data-primary={qi === 0 && oi === 0 ? '' : undefined}
                      type={multi ? 'checkbox' : 'radio'}
                      name={name}
                      checked={checked}
                      onChange={(e) => toggle(qi, opt.label, multi, e.target.checked)}
                      className="mt-[3px] size-3.5 shrink-0 accent-primary [color-scheme:light] dark:[color-scheme:dark]"
                    />
                    <span className="grid min-w-0 gap-0.5">
                      <span className="text-sm leading-[1.4] text-foreground">{opt.label}</span>
                      {opt.description ? (
                        <span className="text-xs leading-[1.4] text-muted-foreground">{opt.description}</span>
                      ) : null}
                    </span>
                  </label>
                )
              })}
              <label
                className={cn(
                  '-mx-2 flex cursor-pointer items-center gap-2.5 rounded-[7px] px-2 py-[3px] transition-colors',
                  otherOn ? 'bg-accent' : 'hover:bg-accent/60'
                )}
              >
                <input
                  type={multi ? 'checkbox' : 'radio'}
                  name={name}
                  checked={otherOn}
                  onChange={(e) => toggle(qi, OTHER, multi, e.target.checked)}
                  className="size-3.5 shrink-0 accent-primary [color-scheme:light] dark:[color-scheme:dark]"
                />
                <span className="shrink-0 text-sm text-foreground">{t('Other')}</span>
                <input
                  type="text"
                  aria-label={t('Other answer: {question}', { question: q.question })}
                  value={other[qi] ?? ''}
                  onChange={(e) => {
                    const value = e.target.value
                    setOther((prev) => ({ ...prev, [qi]: value }))
                    toggle(qi, OTHER, multi, value.trim().length > 0 ? true : multi ? false : true)
                  }}
                  placeholder={t('Type an answer')}
                  className="h-6 min-w-0 flex-1 rounded-[5px] border border-transparent bg-transparent px-1.5 text-sm text-foreground outline-none placeholder:text-faint hover:border-input focus:border-input focus:bg-background"
                />
              </label>
            </fieldset>
          )
        })}
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={!valid || sent} className={btnPrimary} aria-keyshortcuts="Enter">
            {sent ? t('Sending…') : t('Send answer')}
            <Kbd>↵</Kbd>
          </button>
          {deny ? (
            <button
              type="button"
              disabled={sent}
              onClick={() => {
                if (sentRef.current) return
                sentRef.current = true
                setSent(true)
                respond(item.requestId, { optionId: deny.id })
              }}
              className={btnSecondary}
            >
              {deny.label}
            </button>
          ) : null}
          {!valid && !sent ? <span className="text-xs text-muted-foreground">{t('Choose an answer to continue')}</span> : null}
        </div>
      </form>
    </CardFrame>
  )
})

export function RequestCard({ item }: { item: RequestItem }) {
  return item.requestType === 'question' ? <QuestionCard item={item} /> : <PermissionCard item={item} />
}

/** Richiesta chiusa: "Approvato · pnpm add -D msw", "Rifiutato: usa pnpm · …", "Scaduta · …". */
export const ResolvedRequest = memo(function ResolvedRequest({ item }: { item: RequestItem }) {
  const expired = item.state === 'expired'
  const resolution = item.resolution ?? ''
  const denied = /^(denied|rejected|declined|rifiut|negat|non )/i.test(resolution)
  const question = item.requestType === 'question'
  const Icon = expired ? Clock : denied ? X : question ? CircleQuestionMark : Check
  const head = expired ? t('Expired') : resolution || (question ? t('Answer sent') : t('Approved'))
  const mono = item.command ?? item.path
  const subject = mono ?? (question ? (item.questions?.[0]?.question ?? item.title) : item.title)
  return (
    <div data-item-id={item.id} className="flex h-[22px] min-w-0 items-center gap-2 text-sm text-muted-foreground">
      <Icon
        aria-hidden
        className={cn('size-[13px] shrink-0', !expired && !denied && !question && 'text-success', denied && 'text-destructive')}
        strokeWidth={2.1}
      />
      <span className="min-w-0 truncate">
        <span className="text-foreground/85">{head}</span>
        {subject ? (
          <>
            {' · '}
            {mono ? <code className="font-mono text-[0.93em]">{subject}</code> : subject}
          </>
        ) : null}
      </span>
    </div>
  )
})
