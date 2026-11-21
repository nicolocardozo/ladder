// Impostazioni → Workspace → Servizi del worktree (LAD-66): i comandi lunghi che partono in un terminale a parte alla creazione del worktree.
// Il progetto li definisce in .ladder/settings.toml (sola lettura), la persona nel file personale: ogni modifica riscrive per intero l'elenco
// personale (`personalServices`), mai `services`, che è già fuso. Disattivare un servizio del progetto = voce personale con stesso nome e comando
// vuoto; riattivarlo = togliere quella voce.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Plus } from 'lucide-react'
import { t } from '@shared/i18n'
import type { WorktreeService } from '@shared/protocol'
import { Outcome, settingsButton, settingsField } from '@/components/settings-parts'
import { cn } from '@/lib/utils'

export interface PersonalService {
  name: string
  command: string
  port: boolean
}

type Change = (personal: PersonalService[]) => PersonalService[]

/** Una modifica applicata all'elenco personale attuale dell'host. Restituisce null se va bene, altrimenti il messaggio d'errore. */
type OnChange = (change: Change) => Promise<string | null>

/** Sostituisce la voce di nome `name` (nella sua posizione) o la aggiunge in fondo; ne toglie le altre con lo stesso nome. */
function upsert(personal: PersonalService[], name: string, entry: PersonalService): PersonalService[] {
  const others = personal.filter((p) => p.name !== entry.name || p.name === name)
  const index = others.findIndex((p) => p.name === name)
  return index === -1 ? [...others, entry] : others.map((p, i) => (i === index ? entry : p))
}

const without = (personal: PersonalService[], name: string) => personal.filter((p) => p.name !== name)

export function ServicesBlock({ services, onChange }: { services: WorktreeService[]; onChange: OnChange }) {
  // Nome del servizio in modifica, '' = nuovo, null = nessuna modifica in corso.
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const addButton = useRef<HTMLButtonElement>(null)

  const run = async (change: Change) => {
    setError(null)
    const failed = await onChange(change)
    if (failed) setError(failed)
    return failed
  }
  const close = () => {
    setEditing(null)
    // Il tasto che ha aperto il modulo sparisce o resta: il focus torna comunque a un punto prevedibile.
    window.setTimeout(() => addButton.current?.focus(), 30)
  }

  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-medium">{t('Services')}</h4>
      <p className="max-w-[62ch] text-xs text-muted-foreground">
        {t('Commands that keep running, like a dev server. Each one starts in its own terminal when a worktree is created, after the setup script. Yours are saved in .ladder/settings.local.toml; the project’s come from .ladder/settings.toml.')}
      </p>
      <ul aria-label={t('Services')} className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {services.length === 0 && editing !== '' && <li className="px-4 py-3 text-sm text-muted-foreground">{t('No services yet. Add one to start it with every new worktree.')}</li>}
        {services.map((service) =>
          editing === service.name ? (
            <li key={service.name}>
              <ServiceForm
                service={service}
                services={services}
                onCancel={close}
                onSave={async (entry) => {
                  const failed = await run((personal) => upsert(personal, service.name, entry))
                  if (!failed) close()
                  return failed
                }}
              />
            </li>
          ) : (
            <ServiceRow key={service.name} service={service} onEdit={() => setEditing(service.name)} onChange={run} />
          )
        )}
        {editing === '' && (
          <li>
            <ServiceForm
              service={null}
              services={services}
              onCancel={close}
              onSave={async (entry) => {
                const failed = await run((personal) => upsert(personal, entry.name, entry))
                if (!failed) close()
                return failed
              }}
            />
          </li>
        )}
      </ul>
      {error && editing === null && <Outcome tone="error">{error}</Outcome>}
      {editing === null && (
        <div>
          <button ref={addButton} data-services-add type="button" onClick={() => setEditing('')} className={settingsButton}>
            <Plus aria-hidden className="mr-1.5 inline size-3.5 align-[-2px]" />
            {t('Add service')}
          </button>
        </div>
      )}
    </div>
  )
}

function Badge({ children, title, mono }: { children: string; title?: string; mono?: boolean }) {
  return (
    <span title={title} className={cn('shrink-0 rounded border border-border px-1 text-xs text-muted-foreground', mono && 'font-mono')}>
      {children}
    </span>
  )
}

function ServiceRow({ service, onEdit, onChange }: { service: WorktreeService; onEdit: () => void; onChange: OnChange }) {
  const { name, command, port, source, disabled } = service
  const overrides = source === 'both' && !disabled
  const row = useRef<HTMLLIElement>(null)
  // Il tasto premuto può sparire (Disattiva diventa Riattiva): il focus passa al primo tasto della riga, o all'aggiunta se la riga non c'è più.
  const act = async (change: Change) => {
    await onChange(change)
    window.setTimeout(() => (row.current?.isConnected ? row.current.querySelector('button') : document.querySelector<HTMLElement>('[data-services-add]'))?.focus(), 30)
  }
  const origin = source === 'personal' ? t('Personal') : overrides ? t('Personal, replaces the project’s') : t('Project')
  return (
    <li ref={row} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3">
      <div className="flex min-w-0 flex-1 basis-[240px] flex-col gap-0.5">
        <span className={cn('flex flex-wrap items-center gap-2 text-sm', disabled && 'opacity-60')}>
          <span className="font-medium">{name}</span>
          <Badge>{origin}</Badge>
          {port && <Badge mono title={t('Gets a free port, available as $LADDER_PORT')}>{':LADDER_PORT'}</Badge>}
          {disabled && <span className="rounded border border-attention/40 px-1 text-xs text-attention">{t('Disabled')}</span>}
        </span>
        <code className={cn('truncate font-mono text-xs text-muted-foreground', disabled && 'opacity-60')} title={command}>
          {command}
        </code>
        {overrides && service.projectCommand !== undefined && (
          <span className="flex min-w-0 gap-1 text-xs text-faint">
            <span className="shrink-0">{t('Project version:')}</span>
            <code className="truncate font-mono" title={service.projectCommand}>
              {service.projectCommand}
            </code>
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {disabled ? (
          <button type="button" aria-label={t('Enable {name}', { name })} onClick={() => void act((personal) => without(personal, name))} className={settingsButton}>
            {t('Enable')}
          </button>
        ) : (
          <>
            <button type="button" aria-label={t('Edit {name}', { name })} onClick={onEdit} className={settingsButton}>
              {t('Edit')}
            </button>
            {source !== 'personal' && (
              <button
                type="button"
                aria-label={t('Disable {name}', { name })}
                // Con una versione personale sopra, disattivare la sostituisce con la voce vuota: il progetto resta com'è.
                onClick={() => void act((personal) => upsert(personal, name, { name, command: '', port }))}
                className={settingsButton}
              >
                {t('Disable')}
              </button>
            )}
            {overrides && (
              <button
                type="button"
                aria-label={t('Restore the project’s version of {name}: {command}', { name, command: service.projectCommand ?? '' })}
                title={service.projectCommand}
                onClick={() => void act((personal) => without(personal, name))}
                className={settingsButton}
              >
                {t('Restore the project’s')}
              </button>
            )}
            {source === 'personal' && (
              <button type="button" aria-label={t('Remove {name}', { name })} onClick={() => void act((personal) => without(personal, name))} className={settingsButton}>
                {t('Remove')}
              </button>
            )}
          </>
        )}
      </div>
    </li>
  )
}

/** Aggiunta o modifica: Invio salva, Esc annulla. Nome e comando non vuoti, nome unico; l'errore dell'host resta nel modulo. */
function ServiceForm({ service, services, onSave, onCancel }: { service: WorktreeService | null; services: WorktreeService[]; onSave: (entry: PersonalService) => Promise<string | null>; onCancel: () => void }) {
  const [name, setName] = useState(service?.name ?? '')
  const [command, setCommand] = useState(service?.command ?? '')
  const [port, setPort] = useState(service?.port ?? true)
  const [tried, setTried] = useState(false)
  const [hostError, setHostError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const nameField = useRef<HTMLInputElement>(null)
  const commandField = useRef<HTMLInputElement>(null)
  // Un servizio del progetto si modifica solo come versione personale: il nome è quello che lo lega all'originale.
  const nameLocked = service !== null && service.source !== 'personal'
  useEffect(() => (service ? commandField : nameField).current?.focus(), [service])

  const trimmed = name.trim()
  const nameError = !trimmed ? t('Give the service a name.') : services.some((s) => s.name === trimmed && s.name !== service?.name) ? t('Another service is already called “{name}”.', { name: trimmed }) : null
  const commandError = !command.trim() ? t('Enter the command to run.') : null

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (saving) return
    setTried(true)
    if (nameError) return nameField.current?.focus()
    if (commandError) return commandField.current?.focus()
    setSaving(true)
    setHostError(null)
    const failed = await onSave({ name: trimmed, command: command.trim(), port })
    // Se è andata bene il modulo viene chiuso dal chiamante: qui resta solo l'errore.
    setSaving(false)
    if (failed) setHostError(failed)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    // Esc chiude solo il modulo, non la finestra delle impostazioni.
    e.preventDefault()
    e.stopPropagation()
    onCancel()
  }

  return (
    <form onSubmit={(e) => void submit(e)} onKeyDown={onKeyDown} aria-label={service ? t('Edit {name}', { name: service.name }) : t('Add service')} className="flex flex-col gap-3 bg-muted/30 px-4 py-3">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">{t('Name')}</span>
        <input
          ref={nameField}
          value={name}
          onChange={(e) => setName(e.target.value)}
          readOnly={nameLocked}
          aria-invalid={(tried && !!nameError) || undefined}
          aria-describedby={tried && nameError ? 'service-name-error' : undefined}
          placeholder="Web"
          spellCheck={false}
          autoComplete="off"
          className={cn(settingsField, 'w-[240px]', nameLocked && 'text-muted-foreground')}
        />
        {tried && nameError && (
          <span id="service-name-error" className="text-xs text-destructive">
            {nameError}
          </span>
        )}
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">{t('Command')}</span>
        <input
          ref={commandField}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          aria-invalid={(tried && !!commandError) || undefined}
          aria-describedby={tried && commandError ? 'service-command-error' : undefined}
          placeholder="pnpm dev --port $LADDER_PORT"
          spellCheck={false}
          autoComplete="off"
          className={cn(settingsField, 'w-full font-mono')}
        />
        {tried && commandError && (
          <span id="service-command-error" className="text-xs text-destructive">
            {commandError}
          </span>
        )}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={port} onChange={(e) => setPort(e.target.checked)} className="size-4 shrink-0 accent-primary [color-scheme:light] dark:[color-scheme:dark]" />
        <span>{t('Assign a port, available as $LADDER_PORT')}</span>
      </label>
      {service && service.source === 'project' && <p className="text-xs text-muted-foreground">{t('Saved as your personal version. The project file stays as it is.')}</p>}
      {hostError && <Outcome tone="error">{hostError}</Outcome>}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={saving} className={cn(settingsButton, 'border-primary bg-primary text-primary-foreground hover:bg-primary/90')}>
          {t('Save')}
        </button>
        <button type="button" onClick={onCancel} className={settingsButton}>
          {t('Cancel')}
        </button>
      </div>
    </form>
  )
}
