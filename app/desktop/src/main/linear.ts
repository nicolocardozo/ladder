// Linear issues for "New session from…". You paste your personal API key in Settings:
// it is stored encrypted with the macOS keychain (safeStorage) and used only for the Linear API.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { t } from '@shared/i18n'
import type { IssueItem, IssueList } from '@shared/protocol'

/** LADDER_LINEAR_API replaces the address for tests with a fake server. */
const ENDPOINT = () => process.env.LADDER_LINEAR_API || 'https://api.linear.app/graphql'
const keyFile = () => join(app.getPath('userData'), 'linear-key.bin')

function readKey(): string | null {
  try {
    if (!existsSync(keyFile()) || !safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(readFileSync(keyFile()))
  } catch {
    return null
  }
}

async function query<T>(key: string, body: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(ENDPOINT(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: key },
    body: JSON.stringify({ query: body, variables }),
    signal: AbortSignal.timeout(15000)
  })
  const data = (await response.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null
  if (!response.ok || !data?.data) throw new Error(data?.errors?.[0]?.message ?? t('Linear responded with {status}', { status: response.status }))
  return data.data
}

export interface LinearStatus {
  connected: boolean
  name: string | null
  error: string | null
}

export async function linearStatus(): Promise<LinearStatus> {
  const key = readKey()
  if (!key) return { connected: false, name: null, error: null }
  try {
    const data = await query<{ viewer: { name: string } }>(key, 'query { viewer { name } }')
    return { connected: true, name: data.viewer.name, error: null }
  } catch (error) {
    return { connected: false, name: null, error: (error as Error).message }
  }
}

/** Saves the key after testing it; null removes it. */
export async function setLinearKey(key: string | null): Promise<LinearStatus> {
  if (!key) {
    rmSync(keyFile(), { force: true })
    return { connected: false, name: null, error: null }
  }
  const trimmed = key.trim()
  try {
    const data = await query<{ viewer: { name: string } }>(trimmed, 'query { viewer { name } }')
    if (!safeStorage.isEncryptionAvailable()) return { connected: false, name: null, error: t('The macOS keychain is not available.') }
    writeFileSync(keyFile(), safeStorage.encryptString(trimmed), { mode: 0o600 })
    return { connected: true, name: data.viewer.name, error: null }
  } catch (error) {
    return { connected: false, name: null, error: (error as Error).message }
  }
}

interface RawIssue {
  identifier: string
  title: string
  description: string | null
  url: string
  branchName: string | null
  updatedAt: string
  state: { name: string } | null
}

const FIELDS = 'identifier title description url branchName updatedAt state { name }'

const toItem = (i: RawIssue): IssueItem => ({
  source: 'linear',
  ref: i.identifier,
  title: i.title,
  body: i.description?.trim() || null,
  url: i.url,
  branch: i.branchName,
  state: i.state?.name ?? null,
  updatedAt: Date.parse(i.updatedAt) || null
})

/** Your open issues; with an identifier (ABC-123) also that issue, if it is not among yours. */
export async function linearIssues(search: string): Promise<IssueList> {
  const key = readKey()
  if (!key) return { items: [], problem: t('Connect Linear in Settings → Integrations with a personal API key.') }
  try {
    const data = await query<{ viewer: { assignedIssues: { nodes: RawIssue[] } } }>(
      key,
      `query { viewer { assignedIssues(first: 50, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${FIELDS} } } } }`
    )
    const items = data.viewer.assignedIssues.nodes.map(toItem)
    const id = search.trim().toUpperCase()
    if (/^[A-Z][A-Z0-9]*-\d+$/.test(id) && !items.some((i) => i.ref === id)) {
      const single = await query<{ issue: RawIssue | null }>(key, `query ($id: String!) { issue(id: $id) { ${FIELDS} } }`, { id }).catch(() => null)
      if (single?.issue) items.unshift(toItem(single.issue))
    }
    return { items, problem: null }
  } catch (error) {
    return { items: [], problem: `Linear: ${(error as Error).message}` }
  }
}
