import { useState, type KeyboardEvent } from 'react'
import { ArrowUp, AtSign, Check, ChevronDown, Plus, ShieldCheck } from 'lucide-react'
import { IconButton } from '@/components/icon-button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { agentById, agents, permissionLevels, type AgentId, type PermissionLevel } from '@/lib/agents'
import { cn } from '@/lib/utils'

interface ComposerProps {
  agent: AgentId
  onAgentChange?: (agent: AgentId) => void
  /** Nelle sessioni già avviate l'agente non si cambia dal composer: serve un passaggio. */
  agentLocked?: boolean
  className?: string
}

const chip =
  'no-drag inline-flex h-7 items-center gap-1.5 rounded-md border border-input/70 px-2 text-[12px] text-secondary-foreground outline-none ' +
  'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent'

export function Composer({ agent, onAgentChange, agentLocked, className }: ComposerProps) {
  const [text, setText] = useState('')
  const [permission, setPermission] = useState<PermissionLevel>('edit')
  const info = agentById(agent)
  const level = permissionLevels.find((p) => p.id === permission) ?? permissionLevels[2]

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // ⇧Tab cicla i livelli di permesso, come nel CLI di Claude Code.
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault()
      const index = permissionLevels.findIndex((p) => p.id === permission)
      setPermission(permissionLevels[(index + 1) % permissionLevels.length].id)
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      setText('')
    }
  }

  return (
    <div
      className={cn(
        'w-full rounded-2xl border border-input bg-composer shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-colors focus-within:border-ring/50',
        className
      )}
    >
      <label htmlFor="composer-input" className="sr-only">
        Messaggio per {info.name}
      </label>
      <textarea
        id="composer-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder={`Chiedi a ${info.name}. @ per citare un file, / per i comandi`}
        className="block max-h-[40vh] min-h-[48px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14px] leading-relaxed outline-none [field-sizing:content] placeholder:text-faint"
      />
      <div className="flex items-center gap-1 px-2.5 pt-1 pb-2.5">
        <IconButton icon={Plus} label="Allega file o immagini" />
        <IconButton icon={AtSign} label="Cita un file" shortcut="@" />
        <span className="flex-1" />

        <DropdownMenu>
          <DropdownMenuTrigger className={chip} disabled={agentLocked}>
            <span className="font-semibold text-foreground">{info.name}</span>
            {info.defaultModel && <span className="text-muted-foreground">· {info.defaultModel}</span>}
            {!agentLocked && <ChevronDown className="size-3 text-faint" />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" sideOffset={6} className="w-72">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Agente per questa sessione</DropdownMenuLabel>
              {agents.map((a) => (
                <DropdownMenuItem key={a.id} onClick={() => onAgentChange?.(a.id)} className="items-start gap-2.5 py-1.5">
                  <Check className={cn('mt-0.5 size-3.5', a.id === agent ? 'opacity-100' : 'opacity-0')} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium">{a.name}</span>
                    <span className="truncate text-[11.5px] text-muted-foreground">{a.detail}</span>
                  </span>
                  <span className="mt-0.5 rounded border border-input px-1.5 font-mono text-[10px] text-muted-foreground">{a.source}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-muted-foreground">
              <Plus className="size-3.5" />
              Aggiungi un agente dal registro ACP…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger className={chip} aria-label={`Permessi: ${level.label}`}>
            <ShieldCheck className="size-3.5 text-muted-foreground" />
            {level.label}
            <ChevronDown className="size-3 text-faint" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" sideOffset={6} className="w-80">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Permessi · ⇧Tab per cambiare</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={permission} onValueChange={(value) => setPermission(value as PermissionLevel)}>
                {permissionLevels.map((p) => (
                  <DropdownMenuRadioItem key={p.id} value={p.id} className="items-start py-1.5">
                    <span className="flex flex-col">
                      <span className="font-medium">{p.label}</span>
                      <span className="text-[11.5px] text-muted-foreground">{p.hint}</span>
                      {p.native[agent] && (
                        <span className="font-mono text-[10.5px] text-faint">
                          {info.name}: {p.native[agent]}
                        </span>
                      )}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          aria-label="Invia"
          disabled={text.trim().length === 0}
          onClick={() => setText('')}
          className="no-drag ml-1 grid size-7 place-items-center rounded-full bg-primary text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:bg-muted disabled:text-faint"
        >
          <ArrowUp className="size-4" strokeWidth={2.2} />
        </button>
      </div>
    </div>
  )
}
