// "Pronto per il merge" (⌘⌥4): stato git del branch, PR, CI, commenti di review e cose ancora da fare.
// I pulsanti mandano all'agente un prompt modificabile; Ladder non fa push né merge da solo.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, CircleDashed, CircleX, ExternalLink, GitBranch, GitMerge, GitPullRequest, MessageSquare, Minus, RefreshCw, TriangleAlert } from 'lucide-react'
import type { MergeCheck, MergeInfo, SessionSummary } from '@shared/protocol'
import { PromptDialog, type PromptRequest } from '@/components/prompt-dialog'
import { request } from '@/lib/host-client'
import { relativeAge } from '@/lib/session-state'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { PanelNote } from './changes-panel'

interface Todo {
  text: string
  tone: 'attention' | 'error' | 'muted'
}

/** Cosa manca prima del merge, in ordine: commit, pubblicazione, PR, conflitti, CI, review. */
function todos(info: MergeInfo): Todo[] {
  const list: Todo[] = []
  if (info.isDefaultBranch) return [{ text: `Sei su ${info.branch ?? 'HEAD'}: per una PR serve un branch, per esempio con un worktree.`, tone: 'muted' }]
  if (info.dirty > 0) list.push({ text: `Committa ${info.dirty} ${info.dirty === 1 ? 'file modificato' : 'file modificati'}`, tone: 'attention' })
  if (!info.hasUpstream && info.ahead > 0) list.push({ text: 'Pubblica il branch su origin', tone: 'attention' })
  else if (info.unpushed) list.push({ text: `Pubblica ${info.unpushed} ${info.unpushed === 1 ? 'commit' : 'commit'}`, tone: 'attention' })
  if (info.gh === 'ok' && !info.pr && info.ahead > 0) list.push({ text: 'Apri la PR', tone: 'attention' })
  if (info.conflicts.length) list.push({ text: `Risolvi i conflitti con ${info.base} in ${info.conflicts.length} ${info.conflicts.length === 1 ? 'file' : 'file'}`, tone: 'error' })
  else if (info.pr?.mergeable === 'conflicts') list.push({ text: `Risolvi i conflitti con ${info.base}`, tone: 'error' })
  const failing = info.checks.filter((c) => c.state === 'failing').length
  if (failing) list.push({ text: `Correggi ${failing} ${failing === 1 ? 'controllo fallito' : 'controlli falliti'}`, tone: 'error' })
  const pending = info.checks.filter((c) => c.state === 'pending').length
  if (pending) list.push({ text: `Aspetta ${pending} ${pending === 1 ? 'controllo' : 'controlli'} in corso`, tone: 'muted' })
  if (info.pr?.review === 'changes') list.push({ text: 'La review chiede modifiche', tone: 'error' })
  else if (info.pr?.review === 'pending') list.push({ text: 'Manca una review', tone: 'muted' })
  return list
}

const checkIcon: Record<MergeCheck['state'], ReactNode> = {
  passing: <Check aria-label="Riuscito" className="size-3.5 text-success" />,
  failing: <CircleX aria-label="Fallito" className="size-3.5 text-destructive" />,
  pending: <CircleDashed aria-label="In corso" className="size-3.5 text-muted-foreground" />,
  skipped: <Minus aria-label="Saltato" className="size-3.5 text-faint" />
}

const actionButton =
  'inline-flex h-7 items-center gap-1.5 rounded-md border border-input px-2.5 text-[12.5px] font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50'
const primaryButton =
  'inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[12.5px] font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50'

export function MergePanel({ projectId, root, isGit, session }: { projectId: string; root: string; isGit: boolean; session: SessionSummary | null }) {
  const [info, setInfo] = useState<MergeInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [prompt, setPrompt] = useState<PromptRequest | null>(null)
  const version = useApp((s) => s.fsVersion[root] ?? 0)
  const prKey = session?.pr ? `${session.pr.number}:${session.pr.state}:${session.pr.checks}:${session.pr.mergeable}` : ''
  const latest = useRef(0)

  const load = useCallback(
    (fetch: boolean) => {
      const id = ++latest.current
      setLoading(true)
      request<MergeInfo>({ type: 'merge.info', root, fetch })
        .then((data) => {
          if (id !== latest.current) return
          setInfo(data)
          setError(null)
        })
        .catch((e: Error) => id === latest.current && setError(e.message))
        .finally(() => id === latest.current && setLoading(false))
    },
    [root]
  )

  // Si rilegge quando cambiano i file o lo stato della PR; "Aggiorna" legge anche i branch da origin.
  useEffect(() => {
    if (!isGit) return
    const timer = window.setTimeout(() => load(false), version === 0 ? 0 : 600)
    return () => window.clearTimeout(timer)
  }, [isGit, load, version, prKey])

  if (!isGit) return <PanelNote>Il progetto non è un repository git.</PanelNote>
  if (error && !info) return <PanelNote tone="error">{error}</PanelNote>
  if (!info) return <PanelNote>Leggo lo stato del branch…</PanelNote>

  const list = todos(info)
  const ready = !info.isDefaultBranch && info.pr?.state === 'open' && list.filter((t) => t.tone !== 'muted').length === 0 && info.pr.review !== 'pending'
  const failing = info.checks.filter((c) => c.state === 'failing')
  const prRef = info.pr ? `#${info.pr.number}` : ''
  const ask = (name: string, title: string, vars: Record<string, string>) => setPrompt({ name, title, vars })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-[12.5px]">
        <GitBranch aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-mono text-[12px]">{info.branch ?? 'HEAD staccato'}</span>
        {!info.isDefaultBranch && info.base && (
          <span className="shrink-0 text-muted-foreground">
            → <span className="font-mono text-[12px]">{info.base}</span>
          </span>
        )}
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading}
          title="Aggiorna, leggendo anche i branch da origin"
          aria-label="Aggiorna"
          className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin motion-reduce:animate-none')} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Block title={ready ? 'Pronto per il merge' : 'Da fare'}>
          {ready ? (
            <p className="flex items-center gap-2 text-[12.5px] text-success">
              <Check aria-hidden className="size-3.5" />
              PR aperta, controlli a posto, nessun conflitto.
            </p>
          ) : list.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground">{info.ahead === 0 ? `Nessun commit rispetto a ${info.base}.` : 'Niente da segnalare.'}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {list.map((todo) => (
                <li key={todo.text} className="flex items-start gap-2 text-[12.5px]">
                  <span aria-hidden className={cn('mt-[6px] size-1.5 shrink-0 rounded-full', todo.tone === 'error' ? 'bg-destructive' : todo.tone === 'attention' ? 'bg-attention' : 'bg-muted-foreground/60')} />
                  <span className={cn(todo.tone === 'muted' && 'text-muted-foreground')}>{todo.text}</span>
                </li>
              ))}
            </ul>
          )}
        </Block>

        <Block title="Branch">
          <Row label="Modifiche" value={info.dirty ? `${info.dirty} non committate` : 'tutto committato'} tone={info.dirty ? 'attention' : undefined} />
          {!info.isDefaultBranch && <Row label={`Rispetto a ${info.base}`} value={`${info.ahead} avanti · ${info.behind} indietro`} />}
          <Row label="Origin" value={info.hasUpstream ? (info.unpushed ? `${info.unpushed} da pubblicare` : 'pubblicato') : 'non pubblicato'} tone={info.hasUpstream && !info.unpushed ? undefined : 'attention'} />
          {info.conflicts.length > 0 ? (
            <div className="flex flex-col gap-1">
              <Row label="Conflitti" value={`${info.conflicts.length} file con ${info.base}`} tone="error" />
              <ul className="ml-[104px] flex flex-col gap-0.5 font-mono text-[11.5px] text-muted-foreground">
                {info.conflicts.slice(0, 8).map((file) => (
                  <li key={file} className="truncate">
                    {file}
                  </li>
                ))}
              </ul>
              <div className="ml-[104px]">
                <button
                  type="button"
                  onClick={() => ask('conflicts', 'Risolvi i conflitti', { branch: info.branch ?? '', base: info.base ?? 'main', conflicts: info.conflicts.map((f) => `- ${f}`).join('\n') })}
                  className={actionButton}
                >
                  Risolvi i conflitti…
                </button>
              </div>
            </div>
          ) : (
            !info.isDefaultBranch && info.behind > 0 && <Row label="Conflitti" value={`nessuno con ${info.base}`} />
          )}
        </Block>

        <Block title="Pull request">
          {info.gh !== 'ok' ? (
            <p className="text-[12.5px] text-muted-foreground">
              {info.gh === 'missing'
                ? 'Per PR e CI serve la CLI gh: brew install gh, poi gh auth login.'
                : info.gh === 'unauthenticated'
                  ? 'gh non ha un login: esegui gh auth login nel terminale.'
                  : info.gh === 'no-remote'
                    ? 'Il repository non ha un remote su GitHub.'
                    : `gh non risponde: ${info.ghError}`}
            </p>
          ) : info.pr ? (
            <div className="flex flex-col gap-2">
              <div className="flex min-w-0 items-center gap-2">
                {info.pr.state === 'merged' ? <GitMerge aria-hidden className="size-4 shrink-0 text-success" /> : <GitPullRequest aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
                <button type="button" onClick={() => void window.ladder?.openExternal(info.pr!.url)} className="min-w-0 truncate text-left text-[13px] font-medium outline-none hover:underline focus-visible:underline">
                  #{info.pr.number} {info.pr.title}
                </button>
                <ExternalLink aria-hidden className="size-3 shrink-0 text-faint" />
              </div>
              <div className="flex flex-wrap gap-1.5 text-[11.5px]">
                <Tag tone={info.pr.state === 'merged' ? 'success' : info.pr.state === 'closed' ? 'error' : undefined}>
                  {{ open: 'aperta', draft: 'bozza', merged: 'unita', closed: 'chiusa' }[info.pr.state]}
                </Tag>
                {info.pr.review && <Tag tone={info.pr.review === 'approved' ? 'success' : info.pr.review === 'changes' ? 'error' : undefined}>{{ approved: 'approvata', changes: 'modifiche richieste', pending: 'review da fare' }[info.pr.review]}</Tag>}
                {info.pr.mergeable === 'conflicts' && <Tag tone="error">conflitti</Tag>}
                <span className="self-center text-faint">aggiornata {relativeAge(info.pr.updatedAt)} fa</span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-2">
              <p className="text-[12.5px] text-muted-foreground">{info.isDefaultBranch ? 'Nessuna PR dal branch predefinito.' : 'Il branch non ha ancora una PR.'}</p>
              {!info.isDefaultBranch && (
                <button
                  type="button"
                  onClick={() =>
                    ask('create_pr', 'Crea la PR', {
                      branch: info.branch ?? '',
                      base: info.base ?? 'main',
                      source: session?.source?.url ? `Nella descrizione collega ${session.source.ref}: ${session.source.url}` : ''
                    })
                  }
                  className={primaryButton}
                >
                  <GitPullRequest aria-hidden className="size-3.5" />
                  Crea PR…
                </button>
              )}
            </div>
          )}
        </Block>

        {info.checks.length > 0 && (
          <Block title={`CI · ${info.checks.length}`}>
            <ul className="flex flex-col gap-1">
              {info.checks.map((check) => (
                <li key={check.name} className="flex min-w-0 items-center gap-2 text-[12.5px]">
                  {checkIcon[check.state]}
                  {check.url ? (
                    <button type="button" onClick={() => void window.ladder?.openExternal(check.url!)} className="min-w-0 truncate text-left outline-none hover:underline focus-visible:underline">
                      {check.name}
                    </button>
                  ) : (
                    <span className="min-w-0 truncate">{check.name}</span>
                  )}
                </li>
              ))}
            </ul>
            {failing.length > 0 && (
              <button
                type="button"
                onClick={() => ask('fix', 'Correggi la CI', { pr: prRef, checks: failing.map((c) => `- ${c.name}${c.url ? `: ${c.url}` : ''}`).join('\n') })}
                className={cn(actionButton, 'mt-2 self-start')}
              >
                <TriangleAlert aria-hidden className="size-3.5 text-destructive" />
                Correggi la CI…
              </button>
            )}
          </Block>
        )}

        {info.comments.length > 0 && (
          <Block title={`Commenti · ${info.comments.length}`}>
            <ul className="flex flex-col gap-2">
              {info.comments.slice(-12).map((comment, index) => (
                <li key={`${comment.at}:${index}`} className="flex flex-col gap-0.5 text-[12.5px]">
                  <span className="text-[11.5px] text-muted-foreground">
                    <span className="font-medium text-foreground">{comment.author}</span>
                    {comment.path && (
                      <span className="font-mono">
                        {' '}
                        · {comment.path}
                        {comment.line ? `:${comment.line}` : ''}
                      </span>
                    )}
                    {comment.at ? ` · ${relativeAge(comment.at)}` : ''}
                  </span>
                  <span className="line-clamp-3 whitespace-pre-wrap">{comment.body}</span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() =>
                ask('comments', 'Rispondi ai commenti', {
                  pr: prRef,
                  comments: info.comments.map((c) => `- ${c.author}${c.path ? ` su ${c.path}${c.line ? `:${c.line}` : ''}` : ''}: ${c.body.replace(/\s+/g, ' ').trim()}`).join('\n')
                })
              }
              className={cn(actionButton, 'mt-2 self-start')}
            >
              <MessageSquare aria-hidden className="size-3.5" />
              Invia i commenti all’agente…
            </button>
          </Block>
        )}
      </div>

      <PromptDialog projectId={projectId} session={session} prompt={prompt} onClose={() => setPrompt(null)} />
    </div>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-b border-border px-3 py-3" aria-label={title}>
      <h3 className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'attention' | 'error' }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-[12.5px]">
      <span className="w-[96px] shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 truncate', tone === 'attention' && 'font-medium text-attention', tone === 'error' && 'font-medium text-destructive')}>{value}</span>
    </div>
  )
}

function Tag({ tone, children }: { tone?: 'success' | 'error'; children: ReactNode }) {
  return (
    <span className={cn('rounded-[5px] border px-1.5 py-px', tone === 'success' ? 'border-success/50 text-success' : tone === 'error' ? 'border-destructive/50 text-destructive' : 'border-input text-muted-foreground')}>
      {children}
    </span>
  )
}
