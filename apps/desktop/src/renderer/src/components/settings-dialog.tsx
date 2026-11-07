import { useEffect, useRef } from 'react'
import { Check, Moon, Palette, Sun } from 'lucide-react'
import type { ThemeInfo } from '@shared/themes.generated'
import { LadderLockup } from '@/components/brand/logo'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { THEMES, useSettings } from '@/hooks/use-theme'
import { cn } from '@/lib/utils'

/** Anteprima del tema con i suoi colori: sidebar, messaggio, risposta, richiesta, stati. */
function ThemePreview({ theme }: { theme: ThemeInfo }) {
  const t = theme.tokens
  return (
    <div className="flex h-[92px] overflow-hidden rounded-md" style={{ background: t.background, boxShadow: `inset 0 0 0 1px ${t.border}` }} aria-hidden>
      <div className="flex w-[30%] flex-col gap-1.5 p-2" style={{ background: t.sidebar, borderRight: `1px solid ${t.border}` }}>
        <span className="h-1.5 w-4/5 rounded-sm" style={{ background: t.textMuted, opacity: 0.6 }} />
        <span className="flex items-center gap-1">
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: t.unread }} />
          <span className="h-1.5 flex-1 rounded-sm" style={{ background: t.text, opacity: 0.85 }} />
        </span>
        <span className="flex items-center gap-1 rounded-sm px-0.5 py-0.5" style={{ background: t.selection }}>
          <span className="size-1.5 shrink-0 rounded-full" style={{ border: `1.5px solid ${t.running}`, borderTopColor: 'transparent' }} />
          <span className="h-1.5 flex-1 rounded-sm" style={{ background: t.onSelection, opacity: 0.8 }} />
        </span>
        <span className="relative flex items-center gap-1 pl-1">
          <span className="absolute top-0 bottom-0 left-0 w-[2px]" style={{ background: t.waiting }} />
          <span className="h-1.5 flex-1 rounded-sm" style={{ background: t.textMuted, opacity: 0.7 }} />
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2">
        <span className="ml-auto h-3 w-3/5 rounded" style={{ background: t.surface, boxShadow: `inset 0 0 0 1px ${t.border}` }} />
        <span className="h-1.5 w-[90%] rounded-sm" style={{ background: t.text, opacity: 0.85 }} />
        <span className="h-1.5 w-[70%] rounded-sm" style={{ background: t.text, opacity: 0.85 }} />
        <span className="relative mt-auto flex h-5 items-center gap-1 rounded pl-2" style={{ background: t.surface, boxShadow: `inset 0 0 0 1px ${t.border}` }}>
          <span className="absolute top-1 bottom-1 left-1 w-[2px]" style={{ background: t.waiting }} />
          <span className="ml-1 h-1.5 w-1/3 rounded-sm" style={{ background: t.waiting }} />
          <span className="mr-1 ml-auto h-3 w-6 rounded-sm" style={{ background: t.accent }} />
        </span>
      </div>
    </div>
  )
}

export function SettingsDialog() {
  const open = useSettings((s) => s.settingsOpen)
  const setOpen = useSettings((s) => s.setSettingsOpen)
  const current = useSettings((s) => s.theme)
  const setTheme = useSettings((s) => s.setTheme)
  const grid = useRef<HTMLDivElement>(null)

  // All'apertura il focus va sul tema in uso, non sul primo della griglia.
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[86vh] w-[min(920px,calc(100vw-48px))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <div className="flex min-h-0 flex-1">
          <nav className="flex w-[190px] shrink-0 flex-col gap-1 border-r border-border bg-sidebar p-3" aria-label="Sezioni delle impostazioni">
            <LadderLockup className="mx-1 mt-1 mb-4 h-[18px] w-auto" title="Ladder" />
            <span className="flex h-8 items-center gap-2 rounded-md bg-accent px-2.5 text-[13px] text-accent-foreground">
              <Palette className="size-4" strokeWidth={1.75} />
              Aspetto
            </span>
          </nav>
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
            <DialogTitle className="text-[17px] font-semibold">Aspetto</DialogTitle>
            <DialogDescription className="mt-1 max-w-[60ch] text-[13px] text-muted-foreground">
              Il tema cambia chat, navigazione, pannelli e dialoghi in tutte le finestre e resta dopo il riavvio. Il marchio e l’icona dell’app restano Circuit.
            </DialogDescription>
            <div ref={grid} className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3" role="radiogroup" aria-label="Tema">
              {THEMES.map((theme) => {
                const selected = theme.id === current
                return (
                  <button
                    key={theme.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setTheme(theme.id)}
                    className={cn(
                      'flex flex-col gap-2 rounded-lg border p-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                      selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-input'
                    )}
                  >
                    <ThemePreview theme={theme} />
                    <span className="flex items-center gap-2 px-0.5 pb-0.5">
                      <span className={cn('text-[13px]', selected ? 'font-semibold' : 'font-medium')}>{theme.name}</span>
                      {theme.id === 'circuit' && <span className="rounded border border-border px-1 text-[10px] text-muted-foreground">predefinito</span>}
                      <span className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
                        {theme.appearance === 'dark' ? <Moon className="size-3" /> : <Sun className="size-3" />}
                        {theme.appearance === 'dark' ? 'Scuro' : 'Chiaro'}
                      </span>
                      {selected && <Check className="size-3.5 text-primary" aria-label="Selezionato" />}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
