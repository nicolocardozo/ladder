// Impostazioni → Abbonamenti → "You": il nome che si legge in basso a sinistra nella sidebar. Facoltativo, resta solo sul Mac (`prefs.userName`).
import { useEffect, useId, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { Input } from '@/components/ui/input'
import { SettingRow, SettingsBlock } from '@/components/settings-parts'
import { usePrefs } from '@/hooks/use-prefs'

/** Un solo limite, lo stesso del main (cleanUserName): 80 punti di codice. */
const NAME_MAX = 80

export function YouBlock() {
  const [prefs, update] = usePrefs()
  const saved = prefs?.userName ?? ''
  const [value, setValue] = useState(saved)
  const editing = useRef(false)
  const id = useId()
  // Un cambio che arriva da fuori (un'altra finestra) vale solo se non sto scrivendo.
  useEffect(() => {
    if (!editing.current) setValue(saved)
  }, [saved])
  if (!prefs) return null

  // Si salva all'uscita dal campo o con Invio, non a ogni tasto; un nome vuoto lo toglie.
  const commit = () => {
    editing.current = false
    const next = value.trim().replace(/\s+/g, ' ')
    setValue(next)
    if (next !== saved) update({ userName: next || null })
  }
  return (
    <SettingsBlock id={`${id}-title`} title={t('You')} className="mt-6">
      <div className="mt-3 flex flex-col divide-y divide-border rounded-lg border border-border">
        <SettingRow label={t('First and last name')} hint={t('Optional. It stays on this Mac and shows at the bottom left of the sidebar.')}>
          <Input
            value={value}
            autoComplete="off"
            spellCheck={false}
            aria-label={t('First and last name')}
            placeholder={t('Your name')}
            onFocus={() => (editing.current = true)}
            onChange={(e) => {
              // Dopo Invio il campo resta attivo: chi scrive ancora torna in modifica e un cambio da un'altra finestra non lo sovrascrive.
              editing.current = true
              setValue(Array.from(e.target.value).slice(0, NAME_MAX).join(''))
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape' && value !== saved) {
                // Esc annulla la modifica prima di chiudere le impostazioni.
                e.preventDefault()
                e.stopPropagation()
                setValue(saved)
              }
            }}
            className="w-[200px] @[820px]:w-[260px]"
          />
        </SettingRow>
      </div>
    </SettingsBlock>
  )
}
