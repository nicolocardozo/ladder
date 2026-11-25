// Session status marks, as in the app (app/desktop/src/renderer/src/components/status.tsx):
// each status has its own shape besides color. Only for the site's Circuit screens.
import { cn } from "@/lib/utils"

export type SessionState = "running" | "waiting" | "unread" | "done" | null

/** Spinning ring: session in progress. With reduced motion it stays still and dashed. */
export function RunningRing({ className }: { className?: string }) {
  return (
    <span
      aria-label="Running"
      className={cn(
        "inline-block size-[11px] shrink-0 animate-spin rounded-full border-[1.6px] border-c-border border-t-c-running",
        "motion-reduce:animate-none motion-reduce:border-dotted motion-reduce:border-c-running",
        className,
      )}
    />
  )
}

/** Iris dot: reply to read. */
export function UnreadDot({ className }: { className?: string }) {
  return <span aria-label="Unread" className={cn("inline-block size-2 shrink-0 rounded-full bg-c-accent", className)} />
}

/** Circle with an exclamation mark in amber: the session is waiting for you. */
export function NeedsYou({ className }: { className?: string }) {
  return (
    <svg aria-label="Needs you" viewBox="0 0 24 24" className={cn("size-3 shrink-0 text-c-waiting", className)} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  )
}

/** Green check: done, approved, verified. */
export function DoneCheck({ className }: { className?: string }) {
  return (
    <svg aria-label="Done" viewBox="0 0 24 24" className={cn("size-3 shrink-0 text-c-success", className)} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export function SessionGlyph({ state }: { state: SessionState }) {
  if (state === "running") return <RunningRing />
  if (state === "waiting") return <NeedsYou />
  if (state === "unread") return <UnreadDot />
  if (state === "done") return <DoneCheck />
  return null
}
