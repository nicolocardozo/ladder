// Host finto per l'anteprima web: risponde ai comandi shortcuts.* come farebbe l'host vero, così Impostazioni → Shortcuts
// si prova senza Electron. Entra dalla stessa porta dell'app (window.postMessage), quindi passa da host-client.
import type { FromHost, HostCommand, HostEvent, ShortcutsState } from '@shared/protocol'
import type { Keybinding, ShortcutPreset } from '@shared/shortcuts'

let installed = false
let channelPort: MessagePort | null = null

type PreviewAnswer = { ok: true; data: unknown } | { ok: false; error: string }
const extraHandlers: ((command: HostCommand) => PreviewAnswer | undefined)[] = []

/** Altri comandi che l'host finto deve capire (dev/settings-preview.ts); il primo che risponde vince. */
export function registerPreviewHandler(handler: (command: HostCommand) => PreviewAnswer | undefined): void {
  extraHandlers.push(handler)
}

/** Manda un evento all'app come farebbe l'host. Serve dopo installShortcutsHost. */
export function emitPreviewEvent(event: HostEvent): void {
  channelPort?.postMessage({ kind: 'event', event } satisfies FromHost)
}

export function installShortcutsHost(initial?: Partial<ShortcutsState>): void {
  if (installed) return
  installed = true
  let state: ShortcutsState = { preset: 'vscode', overrides: [], warnings: [], file: '~/Library/Application Support/Ladder/keybindings.json', invalid: false, ...initial }
  const channel = new MessageChannel()
  channelPort = channel.port1
  const reply = (message: FromHost) => channel.port1.postMessage(message)
  channel.port1.onmessage = (event: MessageEvent<{ rid: string; command: HostCommand }>) => {
    const { rid, command } = event.data
    const publish = () => {
      reply({ kind: 'event', event: { type: 'shortcuts.changed', state } })
      reply({ kind: 'result', rid, ok: true, data: state })
    }
    if (command.type === 'shortcuts.get') reply({ kind: 'result', rid, ok: true, data: state })
    else if (command.type === 'shortcuts.save') {
      if (state.invalid) reply({ kind: 'result', rid, ok: false, error: 'keybindings.json is not valid JSON: fix it first.' })
      else {
        state = { ...state, preset: command.preset as ShortcutPreset, overrides: command.overrides as Keybinding[] }
        publish()
      }
    } else if (command.type === 'shortcuts.reset') {
      state = { ...state, overrides: [], warnings: [], invalid: false }
      publish()
    } else if (command.type === 'shortcuts.openFile') reply({ kind: 'result', rid, ok: true, data: null })
    else {
      const answer = extraHandlers.map((handler) => handler(command)).find((a) => a !== undefined)
      if (!answer) reply({ kind: 'result', rid, ok: false, error: 'not available in the preview' })
      else if (answer.ok) reply({ kind: 'result', rid, ok: true, data: answer.data })
      else reply({ kind: 'result', rid, ok: false, error: answer.error })
    }
  }
  window.postMessage('ladder:host-port', '*', [channel.port2])
}
