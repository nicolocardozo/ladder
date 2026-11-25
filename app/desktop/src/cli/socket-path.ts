// Path of the local socket on which the host listens for the `ladder` CLI. Main, host and CLI compute it the same way:
// no path aliases, because the CLI runs on its own (node with type stripping in development, a bundle in the packaged app).
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The sockaddr_un limit on macOS is 104 bytes including the terminator: stay under it with a margin. */
const MAX_PATH_BYTES = 100

/** The app's data folder: Electron's (`~/Library/Application Support/Ladder`), or LADDER_USER_DATA for test profiles. */
export function defaultUserData(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return env.LADDER_USER_DATA || join(home, 'Library', 'Application Support', 'Ladder')
}

/**
 * `<userData>/run/ladder.sock`. If the path is too long for a Unix socket, a short one under /tmp derived from the data folder
 * (`/tmp/ladder-<uid>-<hash>/ladder.sock`): same result for anyone starting from the same data folder.
 */
export function socketPathFor(userData: string, uid: number = process.getuid?.() ?? 0): string {
  const normal = join(userData, 'run', 'ladder.sock')
  if (Buffer.byteLength(normal) <= MAX_PATH_BYTES) return normal
  const hash = createHash('sha1').update(userData).digest('hex').slice(0, 10)
  return join('/tmp', `ladder-${uid}-${hash}`, 'ladder.sock')
}

/** Where the CLI looks for the socket: LADDER_SOCKET, otherwise the one in the default data folder. */
export function discoverSocket(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return env.LADDER_SOCKET || socketPathFor(defaultUserData(env, home))
}
