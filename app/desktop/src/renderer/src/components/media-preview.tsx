// Preview of images, SVG, PDF, audio and video inside Ladder, and before/after comparison for the Changes panel.
// The bytes don't go through the MessagePort: the elements read from `ladder-file://` (FileMedia url). SVGs are drawn only with <img>,
// the PDF sits in an <iframe> without sandbox (Chromium's viewer doesn't start with sandbox).
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { File, FileAudio, FolderSearch, TriangleAlert } from 'lucide-react'
import type { FileChange, FileMedia } from '@shared/protocol'
import { isKnownRev } from '@shared/file-type'
import { t } from '@shared/i18n'
import { isElectron, request } from '@/lib/host-client'
import { cn } from '@/lib/utils'

// ── Formats ──────────────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

const dimensionsLabel = (w: number, h: number) => t('{width} × {height} px', { width: w, height: h })
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const extension = (path: string) => (path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toUpperCase() : '')

/** Changes when the file changes on disk: remounts the element and the protocol (which answers no-store) re-reads the bytes. */
const stampOf = (media: FileMedia) => `${media.mtimeMs ?? 'rev'}:${media.size}`

/** Checkerboard for transparency: two tones taken from the theme, subtle enough not to be noisy. */
const checkerboard: CSSProperties = {
  backgroundColor: 'var(--color-background)',
  backgroundImage:
    'conic-gradient(color-mix(in oklab, var(--color-foreground) 10%, transparent) 25%, transparent 0 50%, color-mix(in oklab, var(--color-foreground) 10%, transparent) 0 75%, transparent 0)',
  backgroundSize: '16px 16px'
}

const quietButton =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-input px-2 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50'

// ── Common pieces ────────────────────────────────────────────────────────────

function Notice({ icon, children, action }: { icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div role="status" className="m-auto flex max-w-sm flex-col items-center gap-3 px-6 py-6 text-center text-sm text-muted-foreground">
      {icon}
      <p>{children}</p>
      {action}
    </div>
  )
}

function Failed({ onRetry }: { onRetry: () => void }) {
  return (
    <Notice
      icon={<TriangleAlert aria-hidden className="size-5 text-destructive" />}
      action={
        <button type="button" onClick={onRetry} className={quietButton}>
          {t('Try again')}
        </button>
      }
    >
      {t('Couldn’t load this file. It may have been removed or changed.')}
    </Notice>
  )
}

export function RevealButton({ root, path }: { root: string; path: string }) {
  const [problem, setProblem] = useState<string | null>(null)
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setProblem(null)
          request({ type: 'fs.reveal', root, path }).catch((e: Error) => setProblem(e.message))
        }}
        className={quietButton}
      >
        <FolderSearch aria-hidden className="size-3.5 text-muted-foreground" />
        {t('Show in Finder')}
      </button>
      {problem && <span className="text-xs text-destructive">{problem}</span>}
    </>
  )
}

/** Preview / Code of an SVG. */
export function PreviewToggle({ value, onChange }: { value: 'preview' | 'code'; onChange: (next: 'preview' | 'code') => void }) {
  const item = (id: 'preview' | 'code', label: string) => (
    <button
      type="button"
      aria-pressed={value === id}
      onClick={() => onChange(id)}
      className={cn('h-6 rounded px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50', value === id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
    >
      {label}
    </button>
  )
  return (
    <div role="group" aria-label={t('SVG view')} className="flex shrink-0 items-center rounded-md border border-input p-0.5">
      {item('preview', t('Preview'))}
      {item('code', t('Code'))}
    </div>
  )
}

// ── Elements ─────────────────────────────────────────────────────────────────

function ImageBody({ media, name, compact, onDims }: { media: FileMedia; name: string; compact?: boolean; onDims?: (w: number, h: number) => void }) {
  const [actual, setActual] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  // Click-to-100% only makes sense if the image is wider than the space.
  const [shrunk, setShrunk] = useState(false)
  const stamp = `${stampOf(media)}:${attempt}`
  useEffect(() => {
    setFailed(false)
    setActual(false)
  }, [stamp])

  if (failed) return <Failed onRetry={() => setAttempt((n) => n + 1)} />
  const img = (
    <img
      key={stamp}
      src={media.url ?? undefined}
      alt={name}
      decoding="async"
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      onLoad={(e) => {
        const el = e.currentTarget
        if (el.naturalWidth > 0) onDims?.(el.naturalWidth, el.naturalHeight)
        setShrunk(el.clientWidth + 1 < el.naturalWidth)
      }}
      style={checkerboard}
      className={cn('block', compact ? 'max-h-72 max-w-full object-contain' : actual ? 'max-w-none' : 'h-auto max-w-full')}
    />
  )
  if (compact) return img
  const zoomable = shrunk || actual
  return (
    <button
      type="button"
      disabled={!zoomable}
      onClick={() => setActual((v) => !v)}
      aria-label={actual ? t('Fit to width') : t('Show at actual size')}
      title={zoomable ? (actual ? t('Fit to width') : t('Show at actual size')) : undefined}
      className={cn('m-auto block shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50', zoomable ? (actual ? 'cursor-zoom-out' : 'cursor-zoom-in') : 'cursor-default')}
    >
      {img}
    </button>
  )
}

function PdfBody({ media, name, compact }: { media: FileMedia; name: string; compact?: boolean }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const stamp = `${stampOf(media)}:${attempt}`
  useEffect(() => {
    setLoaded(false)
    setFailed(false)
  }, [stamp])
  if (failed) return <Failed onRetry={() => setAttempt((n) => n + 1)} />
  return (
    <div className={cn('relative w-full', compact ? 'h-96' : 'h-full')}>
      {!loaded && <p className="absolute inset-0 z-[1] grid place-items-center text-xs text-muted-foreground">{t('Loading PDF…')}</p>}
      {/* Without the sandbox attribute: with sandbox Chromium's PDF viewer doesn't open. The URL is served only for known roots. */}
      <iframe key={stamp} src={media.url ?? undefined} title={t('PDF preview of {name}', { name })} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} className="size-full border-0 bg-background" />
    </div>
  )
}

function PlayerBody({ media, name, compact, onDims }: { media: FileMedia; name: string; compact?: boolean; onDims?: (w: number, h: number) => void }) {
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const stamp = `${stampOf(media)}:${attempt}`
  useEffect(() => setFailed(false), [stamp])
  if (failed) return <Failed onRetry={() => setAttempt((n) => n + 1)} />
  // preload="metadata", no autoplay: a video of hundreds of MB is not downloaded in full, the protocol serves Ranges.
  if (media.kind === 'audio')
    return (
      <div className="m-auto flex w-full max-w-md flex-col items-center gap-2 px-4 py-4">
        <FileAudio aria-hidden className="size-6 text-muted-foreground" strokeWidth={1.5} />
        <audio key={stamp} controls preload="metadata" src={media.url ?? undefined} aria-label={name} onError={() => setFailed(true)} className="w-full" />
      </div>
    )
  return (
    <video
      key={stamp}
      controls
      preload="metadata"
      src={media.url ?? undefined}
      aria-label={name}
      onError={() => setFailed(true)}
      onLoadedMetadata={(e) => e.currentTarget.videoWidth > 0 && onDims?.(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
      className={cn('m-auto block bg-black', compact ? 'max-h-72 max-w-full' : 'max-h-full max-w-full')}
    />
  )
}

function OtherBody({ media, path, root, revealable }: { media: FileMedia | null; path: string; root: string; revealable: boolean }) {
  const type = extension(path)
  return (
    <Notice
      icon={<File aria-hidden className="size-5" strokeWidth={1.5} />}
      action={revealable && isElectron ? <RevealButton root={root} path={path} /> : undefined}
    >
      <span className="block font-medium text-foreground">{type ? t('{type} file', { type }) : t('Binary file')}</span>
      {media && <span className="block text-xs">{formatBytes(media.size)}</span>}
      <span className="mt-1 block text-xs">{t('There is no preview for this type of file.')}</span>
    </Notice>
  )
}

/** The right body for the type, without a frame. */
function MediaBody({ media, root, path, compact, revealable = true, onDims }: { media: FileMedia; root: string; path: string; compact?: boolean; revealable?: boolean; onDims?: (w: number, h: number) => void }) {
  const name = baseName(path)
  if (!isElectron) return <Notice>{t('Preview is available in the Ladder app.')}</Notice>
  if (media.kind === 'other' || !media.url) return <OtherBody media={media} path={path} root={root} revealable={revealable} />
  switch (media.kind) {
    case 'image':
    case 'svg':
      return <ImageBody media={media} name={name} compact={compact} onDims={onDims} />
    case 'pdf':
      return <PdfBody media={media} name={name} compact={compact} />
    default:
      return <PlayerBody media={media} name={name} compact={compact} onDims={onDims} />
  }
}

// ── Full-height viewer (Files panel and tabs) ────────────────────────────────

/** Preview of a non-text file (or an SVG) for the Files panel and tabs. */
export function MediaView({ root, path, media }: { root: string; path: string; media: FileMedia }) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const stamp = stampOf(media)
  useEffect(() => setDims(null), [stamp])
  const w = media.width ?? dims?.w
  const h = media.height ?? dims?.h
  const bits = [w && h ? dimensionsLabel(w, h) : null, formatBytes(media.size)].filter(Boolean)
  const fills = media.kind === 'pdf'
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn('relative flex min-h-0 flex-1 overflow-auto', !fills && media.kind !== 'other' && 'p-3')}>
        <MediaBody media={media} root={root} path={path} onDims={(a, b) => setDims({ w: a, h: b })} />
      </div>
      {media.kind !== 'other' && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-t border-border bg-background px-3 text-xs text-muted-foreground tabular-nums">{bits.join(' · ')}</div>
      )}
    </div>
  )
}

/** Fallback when the host doesn't describe the file (old version): it only says what can't be done. */
export function BinaryNote({ size, root, path }: { size: number; root: string; path: string }) {
  return <OtherBody media={{ kind: 'other', mime: 'application/octet-stream', size, width: null, height: null, mtimeMs: null, url: null }} path={path} root={root} revealable />
}

// ── Description of a file at a revision ──────────────────────────────────────

const mediaCache = new Map<string, Promise<FileMedia>>()

function loadMedia(root: string, path: string, rev: string): Promise<FileMedia> {
  const key = `${root}|${rev}|${path}`
  let cached = mediaCache.get(key)
  if (!cached) {
    // A git revision doesn't change: the answer is remembered, but an error can be retried.
    cached = request<FileMedia>({ type: 'fs.media', root, path, rev })
    cached.catch(() => mediaCache.delete(key))
    mediaCache.set(key, cached)
    if (mediaCache.size > 150) mediaCache.delete(mediaCache.keys().next().value as string)
  }
  return cached
}

type Side = { state: 'loading' } | { state: 'none' } | { state: 'ready'; media: FileMedia } | { state: 'error'; message: string }

function useSide(root: string, path: string | null, rev: string | null, attempt: number): Side {
  const [side, setSide] = useState<Side>(path && rev ? { state: 'loading' } : { state: 'none' })
  useEffect(() => {
    if (!path || !rev) return setSide({ state: 'none' })
    if (!isKnownRev(rev)) return setSide({ state: 'error', message: t('This version can’t be previewed.') })
    let cancelled = false
    setSide({ state: 'loading' })
    loadMedia(root, path, rev)
      .then((media) => !cancelled && setSide({ state: 'ready', media }))
      .catch((e: Error) => !cancelled && setSide({ state: 'error', message: e.message }))
    return () => {
      cancelled = true
    }
  }, [root, path, rev, attempt])
  return side
}

// ── Before and after ─────────────────────────────────────────────────────────

interface MediaCompareProps {
  root: string
  file: FileChange
  from: string
  to: string
}

const caption = 'flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground tabular-nums'

function Figure({ label, side, path, onRetry, onDims, dims, showBody = true }: { label: string; side: Side; path: string; onRetry: () => void; onDims?: (w: number, h: number) => void; dims?: { w: number; h: number } | null; showBody?: boolean }) {
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1.5">
      <figcaption className={caption}>
        <span className="font-medium text-foreground">{label}</span>
        {side.state === 'ready' && (
          <span className="truncate">
            {[(side.media.width ?? dims?.w) && (side.media.height ?? dims?.h) ? dimensionsLabel((side.media.width ?? dims?.w) as number, (side.media.height ?? dims?.h) as number) : null, formatBytes(side.media.size)].filter(Boolean).join(' · ')}
          </span>
        )}
      </figcaption>
      <div className="flex min-h-16 items-center justify-center overflow-hidden rounded-md border border-border">
        {side.state === 'loading' && <p className="px-3 py-3 text-xs text-muted-foreground">{t('Loading…')}</p>}
        {side.state === 'error' && (
          <div role="alert" className="flex flex-col items-center gap-2 px-3 py-3 text-center text-xs text-destructive">
            {side.message}
            <button type="button" onClick={onRetry} className={quietButton}>
              {t('Try again')}
            </button>
          </div>
        )}
        {side.state === 'ready' && showBody && <MediaBody media={side.media} root="" path={path} compact revealable={false} onDims={onDims} />}
      </div>
    </figure>
  )
}

function Segmented<T extends string>({ label, value, onChange, items }: { label: string; value: T; onChange: (next: T) => void; items: { id: T; label: string }[] }) {
  return (
    <div role="group" aria-label={label} className="flex items-center rounded-md border border-input p-0.5">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={value === item.id}
          onClick={() => onChange(item.id)}
          className={cn('h-6 rounded px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50', value === item.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/** Before and after of a changed file: images side by side or overlaid with a slider; PDF, audio and video with sizes and a preview of the after. */
export function MediaCompare({ root, file, from, to }: MediaCompareProps) {
  const [attemptBefore, setAttemptBefore] = useState(0)
  const [attemptAfter, setAttemptAfter] = useState(0)
  const [view, setView] = useState<'side' | 'overlay'>('side')
  const [position, setPosition] = useState(50)
  const [beforeDims, setBeforeDims] = useState<{ w: number; h: number } | null>(null)
  const [afterDims, setAfterDims] = useState<{ w: number; h: number } | null>(null)
  const oldPath = file.oldPath ?? file.path
  const before = useSide(root, file.status === 'A' ? null : oldPath, from, attemptBefore)
  const after = useSide(root, file.status === 'D' ? null : file.path, to, attemptAfter)

  const kind = (after.state === 'ready' ? after.media.kind : before.state === 'ready' ? before.media.kind : null) as FileMedia['kind'] | null
  const imageLike = (s: Side) => s.state === 'ready' && (s.media.kind === 'image' || s.media.kind === 'svg')
  const canOverlay = imageLike(before) && imageLike(after)
  const beforeLabel = file.status === 'D' ? t('Deleted') : t('Before')
  const afterLabel = file.status === 'A' ? t('Added') : t('After')

  // Images and SVG: side by side, or one over the other with the slider.
  if (kind === 'image' || kind === 'svg') {
    const overlay = canOverlay && view === 'overlay'
    return (
      <div className="flex flex-col gap-3 px-3 py-3">
        {canOverlay && (
          <div className="flex items-center gap-2">
            <Segmented
              label={t('Before and after view')}
              value={view}
              onChange={setView}
              items={[
                { id: 'side', label: t('Side by side') },
                { id: 'overlay', label: t('Overlay') }
              ]}
            />
          </div>
        )}
        {overlay && before.state === 'ready' && after.state === 'ready' ? (
          <div className="flex flex-col gap-2">
            <div className={caption}>
              <span className="font-medium text-foreground">{beforeLabel}</span>
              <span className="ml-auto font-medium text-foreground">{afterLabel}</span>
            </div>
            <div className="relative grid overflow-hidden rounded-md border border-border [&>*]:col-start-1 [&>*]:row-start-1" style={checkerboard}>
              <img src={before.media.url ?? undefined} alt={t('{name} before the change', { name: baseName(file.path) })} decoding="async" loading="lazy" draggable={false} className="m-auto block max-h-80 max-w-full object-contain" />
              <img
                src={after.media.url ?? undefined}
                alt={t('{name} after the change', { name: baseName(file.path) })}
                decoding="async"
                loading="lazy"
                draggable={false}
                style={{ clipPath: `inset(0 0 0 ${position}%)` }}
                className="m-auto block max-h-80 max-w-full object-contain"
              />
              <span aria-hidden style={{ left: `${position}%` }} className="pointer-events-none absolute inset-y-0 w-px bg-primary" />
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={position}
              onChange={(e) => setPosition(Number(e.target.value))}
              aria-label={t('Slider between before and after')}
              aria-valuetext={t('{n}% before, {m}% after', { n: position, m: 100 - position })}
              className="w-full accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
          </div>
        ) : (
          <div className={cn('grid gap-3', file.status === 'M' || file.status === 'R' ? 'grid-cols-2' : 'grid-cols-1')}>
            {file.status !== 'A' && <Figure label={beforeLabel} side={before} path={oldPath} onRetry={() => setAttemptBefore((n) => n + 1)} onDims={(w, h) => setBeforeDims({ w, h })} dims={beforeDims} />}
            {file.status !== 'D' && <Figure label={afterLabel} side={after} path={file.path} onRetry={() => setAttemptAfter((n) => n + 1)} onDims={(w, h) => setAfterDims({ w, h })} dims={afterDims} />}
          </div>
        )}
      </div>
    )
  }

  // Other types: "modified" with the sizes before and after and the preview of the after (or the before if the file was deleted).
  const shown = file.status === 'D' ? before : after
  const sizeOf = (s: Side) => (s.state === 'ready' ? formatBytes(s.media.size) : s.state === 'loading' ? '…' : t('n/a'))
  const pending = before.state === 'loading' || after.state === 'loading'
  const failed = [before, after].find((s) => s.state === 'error')
  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      <p className="text-xs text-muted-foreground tabular-nums">
        {file.status === 'A'
          ? `${t('Added')} · ${sizeOf(after)}`
          : file.status === 'D'
            ? `${t('Deleted')} · ${sizeOf(before)}`
            : `${t('Modified')} · ${t('Before')} ${sizeOf(before)} · ${t('After')} ${sizeOf(after)}`}
      </p>
      {pending && <p className="text-xs text-muted-foreground">{t('Loading…')}</p>}
      {failed && failed.state === 'error' && (
        <p role="alert" className="text-xs text-destructive">
          {failed.message}
        </p>
      )}
      {shown.state === 'ready' && (
        <div className="overflow-hidden rounded-md border border-border">
          <MediaBody media={shown.media} root={root} path={file.status === 'D' ? oldPath : file.path} compact revealable={file.status !== 'D'} />
        </div>
      )}
    </div>
  )
}
