// Pure decisions about power and background mode: no Electron, so they can be tested with node --test.

/** The sleep blocker is needed if the preference is on and there is work in progress or a phone connected. */
export function wantKeepAwake(keepAwake: boolean, running: number, phones: number): boolean {
  return keepAwake && (running > 0 || phones > 0)
}

/** The remote channel is on: from the preferences, or (development only) from LADDER_REMOTE_PORT / LADDER_RELAY_URL. */
export function remoteIsOn(prefsEnabled: boolean, packaged: boolean, env: Record<string, string | undefined>): boolean {
  return prefsEnabled || (!packaged && Boolean(env.LADDER_REMOTE_PORT || env.LADDER_RELAY_URL))
}

/** Closing the last window keeps Ladder in the menu bar only with the remote channel on (and only on macOS). */
export function staysInBackground(platform: string, remoteOn: boolean): boolean {
  return platform === 'darwin' && remoteOn
}
