// App update state, from main (electron-updater) to the renderer.
// Versions come from the public releases of nicolocardozo/ladder-releases.
export type UpdateState =
  /** Development or unpackaged build: no updates. */
  | { status: 'unsupported'; version: string }
  | { status: 'idle'; version: string; checkedAt: number | null }
  | { status: 'checking'; version: string }
  | { status: 'downloading'; version: string; next: string; percent: number }
  /** Downloaded: installs on restart, or anyway on Ladder's next quit. */
  | { status: 'ready'; version: string; next: string }
  | { status: 'error'; version: string; message: string }
