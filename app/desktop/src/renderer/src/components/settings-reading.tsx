// Impostazioni → Aspetto, leggibilità: dimensione del testo della chat, editor e font del codice, densità della sidebar.
// Si applicano subito a tutta l'app (hooks/use-chat-font.ts riflette le preferenze su <html>).
import { t } from '@shared/i18n'
import type { AppPrefs, CodeFont, TextSize } from '@shared/protocol'
import { ChoiceGroup, SettingsBlock, type Choice } from '@/components/settings-parts'
import { DEFAULT_CHAT_FONT, DEFAULT_CODE_FONT, DEFAULT_EDITOR_TEXT_SIZE, DEFAULT_SIDEBAR_DENSITY, DEFAULT_TEXT_SIZE, EDITOR_TEXT_SIZE_RANGE } from '@/hooks/use-chat-font'
import { usePrefs } from '@/hooks/use-prefs'

const TEXT_SIZES: Choice<TextSize>[] = [
  { id: 'small', label: 'Small', hint: 'A little smaller' },
  { id: 'default', label: 'Default', hint: 'Sized for the font', badge: 'default' },
  { id: 'large', label: 'Large', hint: 'A little bigger' },
  { id: 'xlarge', label: 'Extra large', hint: 'Much bigger' }
]

const CODE_FONTS: Choice<CodeFont>[] = [
  { id: 'system-mono', label: 'System monospace', hint: 'SF Mono, or Menlo', badge: 'default' },
  { id: 'monaspace-neon', label: 'Monaspace Neon', hint: 'Comes with Ladder' }
]

const DENSITIES: Choice<AppPrefs['sidebarDensity']>[] = [
  { id: 'comfortable', label: 'Comfortable', hint: 'Taller rows with more air', badge: 'default' },
  { id: 'compact', label: 'Compact', hint: 'Shorter rows, more sessions in view' }
]

const translate = (list: Choice<string>[]) => list.map((c) => ({ ...c, label: t(c.label), hint: c.hint ? t(c.hint) : undefined, badge: c.badge ? t(c.badge) : undefined }))

const SAMPLE_CODE = 'const total = items.reduce((sum, item) => sum + item.price, 0)'

export function ReadingBlocks() {
  const [prefs, update] = usePrefs()
  if (!prefs) return null
  const chatSize = prefs.chatTextSize ?? DEFAULT_TEXT_SIZE
  const codeFont = prefs.editorFont ?? DEFAULT_CODE_FONT
  const editorSize = prefs.editorTextSize ?? DEFAULT_EDITOR_TEXT_SIZE
  return (
    <>
      <SettingsBlock id="chat-size-title" title={t('Chat text size')} description={t('How big replies and your messages are, on top of the size of the chat font. Code blocks and the rest of the app keep theirs.')}>
        <ChoiceGroup label={t('Chat text size')} value={chatSize} choices={translate(TEXT_SIZES) as Choice<TextSize>[]} onChange={(chatTextSize) => update({ chatTextSize })} minWidth={150} />
        <div data-chat-font={prefs.chatFont ?? DEFAULT_CHAT_FONT} data-chat-size={chatSize} role="group" aria-label={t('Preview')} className="mt-3 rounded-lg border border-border p-4">
          <p className="max-w-[62ch] font-[family-name:var(--font-chat)] text-[length:var(--chat-size)] leading-[var(--chat-leading)] text-foreground">
            {t('The agent explains what it changed and why, in the font you picked.')}
          </p>
        </div>
      </SettingsBlock>

      <SettingsBlock id="code-title" title={t('Code')} description={t('The font applies to the file editor and to code blocks in the chat. The size applies to the file editor only.')}>
        <ChoiceGroup label={t('Code font')} value={codeFont} choices={translate(CODE_FONTS) as Choice<CodeFont>[]} onChange={(editorFont) => update({ editorFont })} />
        <div className="mt-3 flex items-center gap-3">
          <label htmlFor="editor-size" className="text-sm font-medium">
            {t('File editor text size')}
          </label>
          <input
            id="editor-size"
            type="range"
            min={EDITOR_TEXT_SIZE_RANGE.min}
            max={EDITOR_TEXT_SIZE_RANGE.max}
            step={1}
            value={editorSize}
            aria-valuetext={t('{n} px', { n: editorSize })}
            onChange={(e) => update({ editorTextSize: Number(e.target.value) })}
            className="h-8 w-[220px] accent-primary [color-scheme:light] dark:[color-scheme:dark]"
          />
          <span className="w-12 text-sm text-muted-foreground tabular-nums">{t('{n} px', { n: editorSize })}</span>
          {editorSize !== DEFAULT_EDITOR_TEXT_SIZE && (
            <button type="button" onClick={() => update({ editorTextSize: DEFAULT_EDITOR_TEXT_SIZE })} className="h-7 rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
              {t('Reset to {n} px', { n: DEFAULT_EDITOR_TEXT_SIZE })}
            </button>
          )}
        </div>
        <div data-code-font={codeFont} role="group" aria-label={t('Preview')} className="mt-3 overflow-hidden rounded-lg border border-border bg-[var(--code-bg)]">
          <pre className="m-0 overflow-x-auto px-3 py-2 font-[family-name:var(--font-code)] text-foreground" style={{ fontSize: editorSize, lineHeight: `${(editorSize * 5) / 3}px` }}>
            {SAMPLE_CODE}
          </pre>
        </div>
      </SettingsBlock>

      <SettingsBlock id="density-title" title={t('Sidebar density')} description={t('Height of the session rows in the sidebar. The content is the same.')}>
        <ChoiceGroup label={t('Sidebar density')} value={prefs.sidebarDensity ?? DEFAULT_SIDEBAR_DENSITY} choices={translate(DENSITIES) as Choice<AppPrefs['sidebarDensity']>[]} onChange={(sidebarDensity) => update({ sidebarDensity })} />
      </SettingsBlock>
    </>
  )
}
