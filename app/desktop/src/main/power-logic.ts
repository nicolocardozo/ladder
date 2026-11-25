// Decisioni pure sull'energia e sulla modalità in background (LAD-54): niente Electron, così si provano con node --test.

/** Il blocco del sonno serve se la preferenza è accesa e c'è lavoro in corso o un telefono collegato. */
export function wantKeepAwake(keepAwake: boolean, running: number, phones: number): boolean {
  return keepAwake && (running > 0 || phones > 0)
}

/** Il canale remoto è acceso: dalle preferenze, o (solo in sviluppo) da LADDER_REMOTE_PORT / LADDER_RELAY_URL. */
export function remoteIsOn(prefsEnabled: boolean, packaged: boolean, env: Record<string, string | undefined>): boolean {
  return prefsEnabled || (!packaged && Boolean(env.LADDER_REMOTE_PORT || env.LADDER_RELAY_URL))
}

/** Chiudere l'ultima finestra tiene Ladder nella barra dei menu solo con il canale remoto acceso (e solo su macOS). */
export function staysInBackground(platform: string, remoteOn: boolean): boolean {
  return platform === 'darwin' && remoteOn
}
