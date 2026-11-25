// Fake host for the web preview: answers shortcuts.* commands as the real host would, so Settings → Shortcuts
// can be tried without Electron. It enters through the same port as the app (window.postMessage), so it goes through host-client.
import type { FromHost, HostCommand, HostEvent, ShortcutsState } from '@shared/protocol'
import type { Keybinding, ShortcutPreset } from '@shared/shortcuts'

let installed = false
let channelPort: MessagePort | null = null

type PreviewAnswer = { ok: true; data: unknown } | { ok: false; error: string }
const extraHandlers: ((command: HostCommand) => PreviewAnswer | undefined)[] = []

/** Other commands the fake host must understand (dev/settings-preview.ts); the first that answers wins. */
export function registerPreviewHandler(handler: (command: HostCommand) => PreviewAnswer | undefined): void {
  extraHandlers.push(handler)
}

/** Sends an event to the app as the host would. Needed after installShortcutsHost. */
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
