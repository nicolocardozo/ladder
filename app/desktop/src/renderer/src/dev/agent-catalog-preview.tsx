// Preview of "Add an agent" and of first-launch detection, with a fake host:
// the install really goes through the steps (download, verification, installation, done), can be cancelled, and Junie fails at the checksum.
// Safety scenarios: blocked entries (no checksum, host, conflict, too large), confirmation with size and checksum
// (host github.com/owner/repo shown that way and sent back unchanged), version, checksum or host changed with the confirmation reopening
// and success on the second attempt without Rescan (promise rejection, event with `checksum-changed`, entry that becomes blocked),
// unreadable checksum (Try again, also for an update) and release without digest, signing team (curated but unsigned, or from another
// team), signature (signed, unverified, adhoc, unsigned, failed, quarantine) and sign-in (agent, terminal, unsupported, Stop waiting).
// Stale states ("Stale states and conflict"): a non-final error (transient 404) that becomes actionable again after Rescan; a failed signature that
// unblocks only when the registry publishes another version (second Rescan); two rejections almost at once with a row in the closed group; checksum-conflict
// as a rejected promise and as an event (same warning in attention color, no Try again, no reopening).
// Like the real host, the error code travels in the `agent.install` event (before the rejection) and the rejected promise carries only the message. A redirect to a disallowed
// host (`host`) and a momentarily missing checksum rejected by start() (`no-checksum`) stay visible with Try again even after the reread caused by the rejection.
// The fake host behaves like the real one: it compares the version, sha256 and host it receives with the registry's NOW and rejects in start().
import { useMemo, useState } from 'react'
import type { AgentBlockCode, AgentCatalogEntry, AgentInstall, AgentLogin, AgentSignature } from '@shared/protocol'
import { AgentCatalog } from '@/components/agents/agent-catalog'
import { Onboarding } from '@/components/connections/onboarding'
import type { AgentCatalogActions } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import { connectionScenario } from './fixtures'

const btn = 'h-7 rounded-md border border-input px-2.5 text-[12px] text-secondary-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50'

export type CatalogScenario = 'catalog' | 'late' | 'loading' | 'error' | 'empty' | 'blocked' | 'confirm' | 'checksum' | 'changed' | 'team' | 'signature' | 'login' | 'stale'
const SCENARIOS: { id: CatalogScenario; label: string }[] = [
  { id: 'catalog', label: 'Catalogo completo' },
  { id: 'late', label: 'Lettura lenta, evento più recente' },
  { id: 'loading', label: 'Caricamento' },
  { id: 'error', label: 'Registro non raggiungibile' },
  { id: 'empty', label: 'Nessun agente' },
  { id: 'blocked', label: 'Voci bloccate' },
  { id: 'confirm', label: 'Conferma: dimensione e checksum' },
  { id: 'checksum', label: 'Checksum non leggibile' },
  { id: 'changed', label: 'Versione, checksum o host cambiati' },
  { id: 'team', label: 'Team di firma' },
  { id: 'signature', label: 'Firma e quarantena' },
  { id: 'login', label: 'Accesso richiesto' },
  { id: 'stale', label: 'Stati superati e conflitto' }
]

const idle: { login: AgentLogin } = { login: { state: 'unknown', methods: [], checkedAt: null } }
const entry = (e: Partial<AgentCatalogEntry> & Pick<AgentCatalogEntry, 'id' | 'name' | 'description'>): AgentCatalogEntry => ({
  registryVersion: '1.0.0',
  curated: false,
  state: 'downloadable',
  reason: null,
  reasonCode: null,
  added: false,
  docsUrl: `https://example.com/${e.id}`,
  installUrl: null,
  distribution: 'npx',
  download: null,
  detected: null,
  installed: null,
  install: null,
  ...idle,
  ...e
})
const ready: AgentLogin = { state: 'ready', methods: [], checkedAt: Date.now() - 3_600_000 }
const SHA_A = '9f2b6c1e0a7d4835b1c9e6f402d8a37ce15b9046f3a2d7e8c0b1495a6d3e7f21'
const SHA_B = '41d0e8a5c3b7962f0e1a4d8b7c6359f2a0e8d1c7b4a96350f2e8d1c3b7a5964e'
const binary = (checksum: 'registry' | 'github-release' | 'missing', host = 'github.com/acme/agent-cli', extra: Partial<NonNullable<AgentCatalogEntry['download']>> = {}) => ({
  distribution: 'binary' as const,
  download: { checksum, host, sha256: checksum === 'missing' ? null : SHA_A, size: checksum === 'missing' ? null : 90_000_000, blocked: null, ...extra }
})
const signed: AgentSignature = { state: 'signed', signer: 'Developer ID Application: Example Software Inc. (ABCDE12345)', team: 'ABCDE12345' }
const unverified: AgentSignature = { state: 'unverified', signer: null, team: null }
const adhoc: AgentSignature = { state: 'adhoc', signer: null, team: null }
const unsigned: AgentSignature = { state: 'unsigned', signer: null, team: null }
const failure = (id: string, version: string, error: string, errorCode: AgentBlockCode | null = null): AgentInstall => ({ id, version, state: 'error', stage: null, progress: null, bytes: null, total: null, error, errorCode, signature: null })
const agentLogin = (methods: AgentLogin['methods']): AgentLogin => ({ state: 'required', methods, checkedAt: Date.now() - 300_000 })

/** Test data: curated entries detected, downloadable, unavailable without checksum, download in progress, error, update and login required. */
export function catalogFixture(): AgentCatalogEntry[] {
  return [
    entry({ id: 'gemini', name: 'Gemini CLI', curated: true, description: 'Google’s open-source agent for the terminal, with a large context window.', registryVersion: '0.14.0', state: 'detected', added: true, distribution: 'npx', detected: { path: '/opt/homebrew/bin/gemini', version: '0.14.0' }, login: ready }),
    entry({
      id: 'cursor', name: 'Cursor', curated: true, description: 'The Cursor agent, with the models of your Cursor plan.', registryVersion: '2026.11.3', state: 'detected', distribution: 'npx',
      detected: { path: '/Users/dev/.local/bin/cursor-agent', version: '2026.11.3' },
      login: { state: 'required', checkedAt: Date.now() - 600_000, methods: [{ id: 'cursor-login', name: 'Cursor account', description: null, type: 'terminal' }] }
    }),
    entry({ id: 'github-copilot-cli', name: 'GitHub Copilot', curated: true, description: 'GitHub’s coding agent in your terminal, with your Copilot subscription.', registryVersion: '1.0.34', ...binary('github-release') }),
    entry({
      id: 'opencode', name: 'OpenCode', curated: true, description: 'Open-source coding agent that works with many model providers.', registryVersion: '1.5.0', state: 'detected', added: true,
      ...binary('registry'), installed: { version: '1.4.2', updateAvailable: true, signature: signed }, login: ready
    }),
    // Update reported on an npx entry: without download data there is no confirmation, so no Update.
    entry({ id: 'kilo', name: 'Kilo Code', curated: true, description: 'Open-source coding agent with several modes.', registryVersion: '2.1.0', state: 'detected', added: true, installed: { version: '2.0.0', updateAvailable: true, signature: null }, login: ready }),
    entry({ id: 'amp', name: 'Amp', curated: true, description: 'Sourcegraph’s agent for large codebases.', registryVersion: '0.9.2', state: 'detected', detected: { path: '/usr/local/bin/amp', version: null } }),
    entry({ id: 'goose', name: 'goose', curated: true, description: 'Block’s extensible local agent, with tools through MCP.', registryVersion: '1.12.0', ...binary('registry') }),
    entry({ id: 'cline', name: 'Cline', curated: true, description: 'Autonomous coding agent that asks before it edits or runs.', registryVersion: '3.8.1' }),
    entry({ id: 'qwen-code', name: 'Qwen Code', curated: true, description: 'Alibaba’s coding agent, based on the Qwen models.', registryVersion: '0.4.0', state: 'unavailable', reason: 'Its download has no checksum Ladder can verify, so Ladder does not download it.', reasonCode: 'no-checksum', installUrl: 'https://example.com/qwen/install', ...binary('missing', 'example.com') }),
    entry({
      id: 'kiro', name: 'Kiro CLI', curated: true, description: 'Spec-driven agent from AWS.', registryVersion: '1.20.0', ...binary('github-release'),
      install: { id: 'kiro', version: '1.20.0', state: 'running', stage: 'downloading', progress: 0.42, bytes: 38_000_000, total: 90_000_000, error: null, errorCode: null, signature: null }
    }),
    entry({
      id: 'junie', name: 'Junie', curated: true, description: 'JetBrains’ coding agent.', registryVersion: '2.1.0', ...binary('registry', 'download.example.com'),
      install: failure('junie', '2.1.0', 'The download is corrupted (checksum mismatch). Try again.')
    }),
    entry({ id: 'factory-droid', name: 'Factory Droid', curated: true, description: 'Factory’s agent for software teams.', registryVersion: '0.6.0', state: 'unavailable', reason: 'There is no build for this Mac yet.', distribution: null, docsUrl: 'https://example.com/droid' }),
    entry({ id: 'auggie', name: 'Auggie CLI', description: 'Augment’s agent, with deep context of your codebase.' }),
    entry({ id: 'codebuddy', name: 'CodeBuddy Code', description: 'Tencent’s coding assistant.', state: 'unavailable', reason: 'Its download has no checksum Ladder can verify, so Ladder does not download it.', reasonCode: 'no-checksum', installUrl: 'https://example.com/codebuddy', ...binary('missing', 'example.com') }),
    entry({ id: 'fast-agent', name: 'fast-agent', description: 'Build and run agents with MCP and many providers.', distribution: 'uvx' }),
    entry({ id: 'kimi', name: 'Kimi CLI', description: 'Moonshot’s coding agent.', registryVersion: '0.7.3', ...binary('registry') }),
    entry({ id: 'mistral-vibe', name: 'Mistral Vibe', description: 'Mistral’s command-line coding assistant.', registryVersion: '1.1.0', ...binary('github-release') }),
    entry({ id: 'stakpak', name: 'Stakpak', description: 'DevOps agent for infrastructure and deployments.', docsUrl: null }),
    entry({ id: 'vtcode', name: 'VT Code', description: 'Rust coding agent with semantic code search.', state: 'unavailable', reason: 'npx isn’t installed on this Mac.', distribution: 'npx' })
  ]
}

const download = (checksum: 'registry' | 'github-release', extra: Partial<NonNullable<AgentCatalogEntry['download']>>) => binary(checksum, 'github.com/acme/agent-cli', extra)

/** Safety scenarios: each has only the entries needed to see it. */
function scenarioFixture(scenario: CatalogScenario): AgentCatalogEntry[] {
  switch (scenario) {
    case 'blocked':
      return [
        entry({ id: 'cursor', name: 'Cursor', curated: true, description: 'The Cursor agent, with the models of your Cursor plan.', registryVersion: '2026.11.3', state: 'unavailable', reasonCode: 'no-checksum', reason: 'No checksum.', installUrl: 'https://cursor.com/cli', docsUrl: 'https://cursor.com/docs', ...binary('missing', 'downloads.cursor.com') }),
        entry({ id: 'upper-link', name: 'Upper Case Link', description: 'The install link is written HTTPS://: it still opens.', state: 'unavailable', reasonCode: 'no-checksum', reason: 'No checksum.', installUrl: 'HTTPS://EXAMPLE.com/upper/install', docsUrl: null, ...binary('missing', 'example.com') }),
        entry({ id: 'cortex-code', name: 'Cortex Code', description: 'Snowflake’s coding agent.', state: 'unavailable', reasonCode: 'no-checksum', reason: 'No checksum.', installUrl: 'https://example.com/cortex/install', docsUrl: null, ...binary('missing', 'example.com') }),
        entry({ id: 'devin', name: 'Devin', description: 'Cognition’s software agent. This one has no link to follow.', state: 'unavailable', reasonCode: 'no-checksum', reason: 'No checksum.', installUrl: null, docsUrl: null, ...binary('missing', 'example.com') }),
        entry({ id: 'devin-cli', name: 'Devin for Terminal', description: 'The CLI is already on this Mac, so Add still works.', state: 'detected', reasonCode: 'no-checksum', installUrl: 'https://example.com/devin/install', detected: { path: '/usr/local/bin/devin', version: '3.2.0' }, ...binary('missing', 'example.com') }),
        entry({ id: 'odd-host', name: 'Odd Host Agent', description: 'The archive is on an address Ladder does not expect.', registryVersion: '1.2.0', installUrl: 'https://example.com/odd/install', ...download('registry', { host: 'files.not-the-vendor.example', blocked: 'host' }) }),
        entry({ id: 'conflict', name: 'Conflict Agent', description: 'Same version, different checksum from the one downloaded before.', registryVersion: '1.2.0', installUrl: 'https://example.com/conflict/install', ...download('registry', { blocked: 'checksum-conflict' }) }),
        entry({ id: 'huge', name: 'Huge Agent', description: 'An archive over the limit.', state: 'unavailable', reasonCode: 'too-large', reason: 'Too large.', installUrl: 'https://example.com/huge/install', ...download('registry', { size: 900_000_000 }) })
      ]
    case 'confirm':
      return [
        entry({ id: 'full', name: 'Full Details', description: 'Size and checksum known.', registryVersion: '1.3.0', ...download('registry', {}) }),
        entry({ id: 'size-null', name: 'Unknown Size', description: 'The size could not be read.', registryVersion: '1.3.0', ...download('registry', { size: null }) }),
        entry({ id: 'plain-host', name: 'Plain Host', description: 'A host that is not github.com: shown as it is.', registryVersion: '1.3.0', ...binary('registry', 'downloads.vendor.example') }),
        entry({ id: 'update-me', name: 'Update Me', description: 'A new version, with the same confirmation as the first download.', state: 'detected', added: true, registryVersion: '1.4.0', installed: { version: '1.3.0', updateAvailable: true, signature: signed }, ...download('registry', { size: 64_500_000 }), login: ready })
      ]
    case 'checksum':
      return [
        entry({ id: 'cu-flaky', name: 'Flaky Checksum', description: 'The checksum cannot be read now. The second reading works.', registryVersion: '1.3.0', state: 'unavailable', reasonCode: 'checksum-unavailable', reason: 'Try later.', installUrl: 'https://example.com/flaky/install', ...download('github-release', { sha256: null, blocked: 'checksum-unavailable' }) }),
        entry({ id: 'cu-stays', name: 'Stuck Checksum', description: 'The checksum is still not readable after Try again.', registryVersion: '1.3.0', state: 'unavailable', reasonCode: 'checksum-unavailable', reason: 'Try later.', installUrl: 'https://example.com/stuck/install', ...download('github-release', { sha256: null, blocked: 'checksum-unavailable' }) }),
        entry({ id: 'sha-null', name: 'Checksum Not Known', description: 'No checksum and no block from the host: no confirmation, only Try again.', registryVersion: '1.3.0', ...download('github-release', { sha256: null }) }),
        entry({ id: 'update-flaky', name: 'Update Without Checksum', description: 'An update is available, but its checksum cannot be read now. Try again reads it.', state: 'detected', added: true, registryVersion: '1.4.0', installed: { version: '1.3.0', updateAvailable: true, signature: signed }, ...download('github-release', { sha256: null, blocked: 'checksum-unavailable' }), login: ready }),
        entry({ id: 'no-digest', name: 'Release Without Digest', description: 'A GitHub release with no digest: install from the official site.', registryVersion: '1.3.0', state: 'unavailable', reasonCode: 'no-checksum', reason: 'No digest.', installUrl: 'https://example.com/digest/install', ...download('github-release', { sha256: null, blocked: 'no-checksum' }) })
      ]
    case 'changed':
      return [
        entry({ id: 'checksum-moved', name: 'Moving Checksum', description: 'The registry changes the checksum between your read and your confirmation.', registryVersion: '2.0.0', ...download('registry', {}) }),
        entry({ id: 'host-moved', name: 'Moving Host', description: 'The archive moves to another host between your read and your confirmation.', registryVersion: '2.0.0', ...download('registry', {}) }),
        entry({ id: 'checksum-event', name: 'Checksum Event', description: 'The host answers, then an error event with checksum-changed arrives. The confirmation reopens with the new checksum.', registryVersion: '2.0.0', ...download('github-release', {}) }),
        entry({ id: 'checksum-blocked', name: 'Checksum Now Blocked', description: 'After the change the entry cannot be confirmed any more: the block note shows, no Try again.', registryVersion: '2.0.0', ...download('registry', {}) })
      ]
    case 'team':
      return [
        entry({ id: 'team-unsigned', name: 'OpenCode (unsigned)', curated: true, description: 'A curated agent with a pinned team that arrives not signed.', registryVersion: '1.5.0', ...binary('registry') }),
        entry({ id: 'team-other', name: 'Kiro (other team)', curated: true, description: 'A curated agent with a pinned team that arrives signed by another team.', registryVersion: '1.20.0', ...binary('github-release') }),
        entry({ id: 'team-adhoc', name: 'Junie (ad hoc)', curated: true, description: 'A curated agent with a pinned team that arrives signed ad hoc.', registryVersion: '2.1.0', ...binary('registry') }),
        entry({ id: 'team-reason', name: 'Team As Reason', description: 'The catalog itself says team: no download, no Try again.', state: 'unavailable', reasonCode: 'team', reason: 'Not signed by the expected developer.', installUrl: 'https://example.com/team/install', ...binary('registry') }),
        entry({ id: 'sig-compare', name: 'Signature That Fails', description: 'For comparison: a broken signature is another text.', registryVersion: '1.0.0', installUrl: 'https://example.com/sig/install', ...binary('registry') })
      ]
    case 'signature':
      return [
        entry({ id: 'signed-app', name: 'Signed Agent', description: 'Installed by Ladder, signed with a Developer ID.', state: 'detected', added: true, registryVersion: '1.0.0', ...binary('registry'), installed: { version: '1.0.0', updateAvailable: false, signature: signed }, login: ready }),
        entry({ id: 'unverified-app', name: 'Unverified Agent', description: 'Installed by Ladder, signature intact but the signer is not verified.', state: 'detected', added: true, registryVersion: '1.0.0', ...binary('registry'), installed: { version: '1.0.0', updateAvailable: false, signature: unverified }, login: ready }),
        entry({ id: 'adhoc-app', name: 'Ad Hoc Agent', description: 'Installed by Ladder, signed ad hoc.', state: 'detected', added: true, registryVersion: '1.0.0', ...binary('registry'), installed: { version: '1.0.0', updateAvailable: false, signature: adhoc }, login: ready }),
        entry({ id: 'unsigned-app', name: 'Unsigned Agent', description: 'Installed by Ladder, not signed.', state: 'detected', added: true, registryVersion: '1.0.0', ...binary('registry'), installed: { version: '1.0.0', updateAvailable: false, signature: unsigned }, login: ready }),
        entry({ id: 'new-signed', name: 'Install: signed', description: 'Downloads, then shows who signed it.', registryVersion: '1.0.0', ...binary('registry') }),
        entry({ id: 'new-unverified', name: 'Install: signer not verified', description: 'Downloads and installs, and says the signer is not verified.', registryVersion: '1.0.0', ...binary('registry') }),
        entry({ id: 'new-unsigned', name: 'Install: not signed', description: 'Downloads and installs, and says it is not signed.', registryVersion: '1.0.0', ...binary('registry') }),
        entry({ id: 'sig-fail', name: 'Install: signature fails', description: 'Signed, but the signature does not hold: not installed.', registryVersion: '1.0.0', installUrl: 'https://example.com/sig/install', ...binary('registry') }),
        entry({ id: 'quarantine', name: 'Install: quarantine', description: 'macOS puts the download in quarantine.', registryVersion: '1.0.0', installUrl: 'https://example.com/quarantine/install', ...binary('registry') })
      ]
    case 'stale':
      return [
        entry({ id: 'flaky-404', name: 'Momentary 404', curated: true, description: 'The tag answers 404 once: no checksum. After Rescan the row can be downloaded again.', registryVersion: '1.0.0', ...binary('github-release') }),
        entry({ id: 'sig-version', name: 'Signature Then New Version', curated: true, description: 'The signature does not hold. Rescan keeps the note; only a new registry version clears it (second Rescan).', registryVersion: '1.0.0', installUrl: 'https://example.com/sig/install', ...binary('registry') }),
        entry({ id: 'redirect-host', name: 'Redirect To Other Host', curated: true, description: 'The download is redirected to a host Ladder does not allow. The error stays, with Try again.', registryVersion: '1.0.0', installUrl: 'https://example.com/redirect/install', ...binary('registry') }),
        entry({ id: 'flaky-start', name: 'Checksum Refused At Start', curated: true, description: 'The host refuses at start for a missing checksum, the registry has it again at once. The error stays, with Try again.', registryVersion: '1.0.0', ...binary('github-release') }),
        entry({ id: 'conflict-promise', name: 'Conflict (refused)', curated: true, description: 'The host refuses with checksum-conflict as the answer of the command.', registryVersion: '1.0.0', installUrl: 'https://example.com/conflict/install', ...binary('registry') }),
        entry({ id: 'conflict-event', name: 'Conflict (event)', curated: true, description: 'The host answers, then an event with checksum-conflict arrives: same final state.', registryVersion: '1.0.0', installUrl: 'https://example.com/conflict/install', ...binary('registry') }),
        entry({ id: 'two-a', name: 'Parallel A', curated: true, description: 'Refused because the host moved. Confirm it together with Parallel B, then close the group.', registryVersion: '2.0.0', ...binary('registry') }),
        entry({ id: 'two-b', name: 'Parallel B', description: 'In the closed group. Refused because the checksum moved: the confirmation reopens when the group is open.', registryVersion: '2.0.0', ...binary('registry') })
      ]
    case 'login':
      return [
        entry({ id: 'agent-ok', name: 'Browser Sign-in', description: 'Declares two methods the agent handles itself. Succeeds.', state: 'detected', added: true, detected: { path: '/opt/homebrew/bin/agent-ok', version: '1.0.0' }, login: agentLogin([{ id: 'oauth', name: 'Sign in with your account', description: 'Opens your browser.', type: 'agent' }, { id: 'api-key', name: 'Use an API key', description: null, type: 'agent' }]) }),
        entry({ id: 'agent-fail', name: 'Flaky Sign-in', description: 'The first attempt fails, the second works.', state: 'detected', added: true, detected: { path: '/opt/homebrew/bin/agent-fail', version: '1.0.0' }, login: agentLogin([{ id: 'oauth', name: 'Sign in with your account', description: null, type: 'agent' }]) }),
        entry({ id: 'agent-still', name: 'Still Required', description: 'The agent answers, but the account is still not signed in.', state: 'detected', added: true, detected: { path: '/opt/homebrew/bin/agent-still', version: '1.0.0' }, login: agentLogin([{ id: 'oauth', name: 'Sign in with your account', description: null, type: 'agent' }]) }),
        entry({ id: 'agent-hang', name: 'Slow Sign-in', description: 'Never finishes by itself: Stop waiting sends the cancel, then Sign in works again.', state: 'detected', added: true, detected: { path: '/opt/homebrew/bin/agent-hang', version: '1.0.0' }, login: agentLogin([{ id: 'oauth', name: 'Sign in with your account', description: 'Opens your browser.', type: 'agent' }]) }),
        entry({ id: 'unsupported', name: 'Unsupported Sign-in', description: 'The only methods are ones Ladder cannot do: no Sign in button.', state: 'detected', added: true, detected: { path: '/opt/homebrew/bin/unsupported', version: '1.0.0' }, login: agentLogin([{ id: 'env', name: 'API key in the environment', description: 'Set ACME_API_KEY before you start the agent.', type: 'unsupported' }, { id: 'other', name: 'Device certificate', description: null, type: 'unsupported' }]) }),
        entry({ id: 'mixed', name: 'Mixed Methods', description: 'One method Ladder does, one it does not.', state: 'detected', added: true, detected: { path: '/opt/homebrew/bin/mixed', version: '1.0.0' }, login: agentLogin([{ id: 'oauth', name: 'Sign in with your account', description: null, type: 'agent' }, { id: 'env', name: 'API key in the environment', description: null, type: 'unsupported' }]) }),
        entry({ id: 'terminal-only', name: 'Terminal Sign-in', description: 'Only a terminal method: no button, no invented command.', state: 'detected', added: true, detected: { path: '/opt/homebrew/bin/terminal-only', version: '1.0.0' }, login: agentLogin([{ id: 'cli-login', name: 'Cursor account', description: null, type: 'terminal' }]) }),
        entry({ id: 'terminal-hint', name: 'Terminal With Hint', description: 'The method says what to run.', state: 'detected', added: true, detected: { path: '/opt/homebrew/bin/terminal-hint', version: '1.0.0' }, login: agentLogin([{ id: 'cli-login', name: 'Account', description: 'Run “hint auth login” in a terminal.', type: 'terminal' }]) }),
        entry({ id: 'not-added', name: 'Not Added Yet', description: 'Not added: the state shows, the button comes after Add.', state: 'detected', detected: { path: '/opt/homebrew/bin/not-added', version: '1.0.0' }, login: agentLogin([{ id: 'oauth', name: 'Sign in with your account', description: null, type: 'agent' }]) })
      ]
    default:
      return catalogFixture()
  }
}

const STEP = 450

function fakeActions(scenario: CatalogScenario): AgentCatalogActions & { remove: (id: string) => void } {
  const world = new Map<string, AgentCatalogEntry>()
  if (scenario !== 'loading' && scenario !== 'error' && scenario !== 'empty') for (const e of scenarioFixture(scenario)) world.set(e.id, e)
  const listeners = new Set<(install: AgentInstall) => void>()
  const loginListeners = new Set<(id: string, login: AgentLogin) => void>()
  const attempts = new Map<string, number>()
  const removed = new Set<(id: string) => void>()
  const timers = new Map<string, number[]>()
  const emit = (install: AgentInstall) => {
    const current = world.get(install.id)
    // Like the host: on a successful run the catalog says install: null, never `done`.
    if (current) world.set(install.id, { ...current, install: install.state === 'done' ? null : install })
    listeners.forEach((l) => l(install))
  }
  const later = (id: string, ms: number, fn: () => void) => timers.set(id, [...(timers.get(id) ?? []), window.setTimeout(fn, ms)])
  const wait = <T,>(ms: number, value: () => T) => new Promise<T>((resolve) => window.setTimeout(() => resolve(value()), ms))

  // The registry changes between the read and the command (once per entry): at the first `agents.install` the world has already changed, and what the user
  // had confirmed no longer matches. Like the real host, the rejection happens in start() (and sometimes also as an event with `checksum-changed`).
  const moves: Record<string, (current: AgentCatalogEntry) => AgentCatalogEntry> = {
    goose: (c) => ({ ...c, registryVersion: '1.13.0' }),
    'host-moved': (c) => ({ ...c, download: { ...c.download!, host: 'cdn.vendor.example' } }),
    'checksum-moved': (c) => ({ ...c, download: { ...c.download!, sha256: SHA_B, size: 91_250_000 } }),
    'checksum-event': (c) => ({ ...c, download: { ...c.download!, sha256: SHA_B, size: 91_250_000 } }),
    'two-a': (c) => ({ ...c, download: { ...c.download!, host: 'cdn.vendor.example' } }),
    'two-b': (c) => ({ ...c, download: { ...c.download!, sha256: SHA_B, size: 91_250_000 } }),
    'checksum-blocked': (c) => ({ ...c, download: { ...c.download!, blocked: 'checksum-conflict' } })
  }
  const moved = new Set<string>()
  /** What the host rejects right now: version, host, sha256 or block, with the raw message; null if everything matches what the user saw. */
  const refusal = (sent: AgentCatalogEntry, now: AgentCatalogEntry): string | null => {
    if (sent.registryVersion !== now.registryVersion) return `The registry now lists version ${now.registryVersion} for ${now.name}, not ${sent.registryVersion}. Review the new version and try again.`
    if (!now.download || now.download.blocked) return `${now.name} cannot be downloaded any more: the registry entry changed. Review it and try again.`
    if (sent.download?.host !== now.download.host) return `The download host of ${now.name} is now ${now.download.host}, not ${sent.download?.host}. Review it and confirm again.`
    if (sent.download?.sha256 !== now.download.sha256) return `The registry now lists a different checksum for ${now.name} v${now.registryVersion}. Review it and confirm again.`
    return null
  }
  const hanging = new Map<string, (login: AgentLogin) => void>()
  // StrictMode mounts twice and the first read is discarded: reads in the first 250 ms count as the initial one.
  let firstRead: number | null = null
  const initialRead = () => {
    const now = performance.now()
    firstRead ??= now
    return now - firstRead < 250
  }
  let lateScheduled = false
  // "stale" scenario: what the catalog says after the attempts. The transient 404 goes away by itself; the failed signature changes only with a new version.
  const original = new Map<string, AgentCatalogEntry>()
  const healed = new Set<string>()
  let sigFailed = false
  let sigReads = 0
  /** Event towards the list without writing it into the world: the host catalog does not keep these errors. */
  const emitOnly = (install: AgentInstall) => listeners.forEach((l) => l(install))

  const actions: AgentCatalogActions & { remove: (id: string) => void } = {
    remove: (id) => {
      const current = world.get(id)
      if (current) world.set(id, { ...current, added: false, installed: null, install: null })
      removed.forEach((l) => l(id))
    },
    catalog: () => {
      if (scenario === 'empty') return wait(300, () => [])
      if (scenario === 'loading') return new Promise(() => undefined)
      if (scenario === 'late' && initialRead()) {
        // Slow read: the response is built now (kiro downloading) and arrives after kiro's error and its out-of-order "running".
        const snapshot = [...world.values()]
        const kiro = world.get('kiro')?.install
        if (lateScheduled) return wait(3000, () => snapshot)
        lateScheduled = true
        later('kiro', 800, () => emit({ ...kiro!, state: 'error', stage: null, progress: null, bytes: null, total: null, error: 'The download is corrupted (checksum mismatch). Try again.' }))
        later('kiro', 1200, () => emit({ ...kiro!, state: 'running', stage: 'downloading', progress: 0.5 }))
        later('kiro', 1600, () => emit({ ...kiro!, state: 'error', stage: null, progress: null, bytes: null, total: null, error: 'The download is corrupted (checksum mismatch). Try again.' }))
        return wait(3000, () => snapshot)
      }
      if (scenario === 'error') return new Promise((_, reject) => window.setTimeout(() => reject(new Error('getaddrinfo ENOTFOUND cdn.agentclientprotocol.com')), 500))
      // "Flaky Checksum" and "Update Without Checksum": the initial read cannot read the checksum, the later ones (Try again) can.
      if (scenario === 'checksum' && !initialRead()) {
        for (const id of ['cu-flaky', 'update-flaky']) {
          const flaky = world.get(id)
          if (flaky?.download && flaky.download.sha256 === null) world.set(id, { ...flaky, state: flaky.state === 'unavailable' ? 'downloadable' : flaky.state, reasonCode: null, reason: null, download: { ...flaky.download, sha256: SHA_A, size: 90_000_000, blocked: null } })
        }
      }
      if (scenario === 'stale') {
        for (const id of healed) if (original.has(id)) world.set(id, original.get(id)!)
        healed.clear()
        if (sigFailed && ++sigReads >= 2) world.set('sig-version', { ...world.get('sig-version')!, registryVersion: '1.1.0' })
      }
      return wait(400, () => [...world.values()])
    },
    detect: () => (scenario === 'error' ? Promise.reject(new Error('offline')) : wait(500, () => [...world.values()].filter((e) => e.state === 'detected' && e.detected))),
    add: (e) =>
      wait(300, () => {
        world.set(e.id, { ...world.get(e.id)!, added: true })
      }),
    install: (e) => {
      const move = moves[e.id]
      if (move && !moved.has(e.id) && world.has(e.id)) {
        moved.add(e.id)
        world.set(e.id, move(world.get(e.id)!))
      }
      if (scenario === 'stale') {
        const base = { id: e.id, version: e.registryVersion, state: 'error' as const, stage: null, progress: null, bytes: null, total: null, signature: null }
        const code = (errorCode: AgentBlockCode, error: string): AgentInstall => ({ ...base, error, errorCode })
        // Like the real host: the code travels only in the event, which fires BEFORE the rejection; the promise carries only the message.
        if (e.id === 'conflict-promise') {
          later(e.id, 20, () => emitOnly(code('checksum-conflict', 'Raw host message, replaced by the coded text.')))
          return new Promise((_, reject) => window.setTimeout(() => reject(new Error('Raw host message, replaced by the coded text.')), 300))
        }
        // start() rejects for a momentarily missing checksum (event with code, then rejection without); the reread sees it whole: the error must stay with Try again.
        if (e.id === 'flaky-start') {
          later(e.id, 20, () => emitOnly(code('no-checksum', 'The checksum was not found.')))
          return new Promise((_, reject) => window.setTimeout(() => reject(new Error('The checksum was not found.')), 300))
        }
        // During the download a redirect goes to a disallowed host: error with code `host`; the catalog (which only checks the registry URL) sees no blocks.
        if (e.id === 'redirect-host') {
          later(e.id, 100, () => emitOnly({ ...base, state: 'running', stage: 'downloading', progress: 0.2, bytes: 18_000_000, total: 90_000_000, error: null, errorCode: null }))
          later(e.id, 700, () => emitOnly(code('host', 'Raw host message, replaced by the coded text.')))
          return Promise.resolve({ ...base, state: 'running', stage: null, error: null, errorCode: null })
        }
        if (e.id === 'conflict-event') {
          later(e.id, 500, () => emitOnly(code('checksum-conflict', 'Raw host message, replaced by the coded text.')))
          return Promise.resolve()
        }
        if (e.id === 'flaky-404') {
          // The current reread sees the entry without checksum; the next one, after Rescan, sees it as it was.
          const now = world.get(e.id)!
          original.set(e.id, now)
          world.set(e.id, { ...now, state: 'unavailable', reasonCode: 'no-checksum', reason: 'No checksum.', download: { ...now.download!, sha256: null, blocked: 'no-checksum' } })
          healed.add(e.id)
          later(e.id, 500, () => emitOnly(code('no-checksum', 'The checksum was not found.')))
          return Promise.resolve()
        }
        if (e.id === 'sig-version') {
          sigFailed = true
          later(e.id, 600, () => emitOnly(code('signature', 'Raw host message, replaced by the coded text.')))
          return Promise.resolve()
        }
      }
      const now = world.get(e.id)
      const refused = now ? refusal(e, now) : null
      if (refused) {
        const code = { id: e.id, version: e.registryVersion, state: 'error' as const, stage: null, progress: null, bytes: null, total: null, error: refused, errorCode: 'checksum-changed' as const, signature: null }
        // Event only: the request answers and shortly after the error arrives with the code. Promise and event: like the real host. Promise only: version, host or block.
        if (e.id === 'checksum-event') {
          later(e.id, 500, () => emitOnly(code))
          return Promise.resolve()
        }
        if (e.id === 'checksum-moved') window.setTimeout(() => emitOnly(code), 20)
        return new Promise((_, reject) => window.setTimeout(() => reject(new Error(refused)), 300))
      }
      const signature = e.id === 'new-unsigned' ? unsigned : e.id === 'new-unverified' ? unverified : e.id === 'sig-fail' || e.id === 'quarantine' ? null : signed
      const base = { id: e.id, version: e.registryVersion, state: 'running' as const, stage: null, error: null, errorCode: null, signature: null as AgentSignature | null }
      let at = 0
      const total = 90_000_000
      for (let p = 0; p <= 10; p++) {
        later(e.id, (at += STEP), () => emit({ ...base, stage: 'downloading', progress: p / 10, bytes: (total * p) / 10, total }))
      }
      later(e.id, (at += 700), () => emit({ ...base, stage: 'verifying', progress: null, bytes: null, total: null }))
      if (e.id === 'junie') {
        later(e.id, (at += 900), () => emit({ ...base, state: 'error', stage: null, progress: null, bytes: null, total: null, error: 'The download is corrupted (checksum mismatch). Try again.' }))
        return Promise.resolve()
      }
      if (e.id === 'sig-fail' || e.id === 'quarantine' || e.id === 'sig-compare' || e.id.startsWith('team-')) {
        const code = e.id === 'sig-fail' || e.id === 'sig-compare' ? 'signature' : e.id === 'quarantine' ? 'quarantine' : 'team'
        later(e.id, (at += 900), () => emit({ ...base, state: 'error', stage: null, progress: null, bytes: null, total: null, error: 'Raw host message, replaced by the coded text.', errorCode: code }))
        return Promise.resolve()
      }
      later(e.id, (at += 900), () => emit({ ...base, stage: 'installing', progress: null, bytes: null, total: null, signature }))
      later(e.id, (at += 900), () => emit({ ...base, stage: 'finishing', progress: null, bytes: null, total: null, signature }))
      later(e.id, (at += 600), () => {
        world.set(e.id, { ...world.get(e.id)!, state: 'detected', added: true, installed: { version: e.registryVersion, updateAvailable: false, signature }, install: null, login: { state: 'unknown', methods: [], checkedAt: null } })
        emit({ ...base, state: 'done', stage: null, progress: null, bytes: null, total: null, signature })
      })
      return Promise.resolve()
    },
    authenticate: (id, methodId) => {
      const current = world.get(id)
      const n = (attempts.get(id) ?? 0) + 1
      attempts.set(id, n)
      if (!current || !current.added) return Promise.reject(new Error('Add the agent first.'))
      const ok = id === 'agent-ok' || (id === 'agent-fail' && n > 1)
      if (id === 'agent-fail' && n === 1) return new Promise((_, reject) => window.setTimeout(() => reject(new Error('The sign-in was not completed in the browser.')), 1200))
      if (id === 'agent-hang' && n === 1) {
        // Stays pending until `cancelAuthenticate` arrives, which answers with the login as it was (no error).
        return new Promise<AgentLogin>((resolve) => hanging.set(id, resolve))
      }
      if (id === 'agent-hang') return wait(1200, () => {
        const login: AgentLogin = { state: 'ready', methods: current.login.methods, checkedAt: Date.now() }
        world.set(id, { ...world.get(id)!, login })
        loginListeners.forEach((l) => l(id, login))
        return login
      })
      if (!ok) return wait(1200, () => ({ ...current.login, checkedAt: Date.now() }))
      return wait(1800, () => {
        const login: AgentLogin = { state: 'ready', methods: current.login.methods, checkedAt: Date.now() }
        world.set(id, { ...world.get(id)!, login })
        loginListeners.forEach((l) => l(id, login))
        void methodId
        return login
      })
    },
    cancelAuthenticate: async (id) => {
      hanging.get(id)?.({ ...world.get(id)!.login })
      hanging.delete(id)
    },
    onLogin: (listener) => {
      loginListeners.add(listener)
      return () => loginListeners.delete(listener)
    },
    cancel: async (id) => {
      timers.get(id)?.forEach((timer) => window.clearTimeout(timer))
      timers.delete(id)
      const current = world.get(id)?.install
      if (current) emit({ ...current, state: 'cancelled', stage: null, progress: null, bytes: null, total: null })
    },
    onInstall: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onRemoved: (listener) => {
      removed.add(listener)
      return () => removed.delete(listener)
    }
  }
  return actions
}

export function AgentCatalogPreview() {
  const [scenario, setScenario] = useState<CatalogScenario>('catalog')
  const [screen, setScreen] = useState<'settings' | 'onboarding'>('settings')
  const actions = useMemo(() => fakeActions(scenario), [scenario])
  const statuses = useMemo(() => connectionScenario('connected'), [])

  return (
    <div className="flex w-[900px] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {SCENARIOS.map((item) => (
          <button key={item.id} type="button" aria-pressed={scenario === item.id} onClick={() => setScenario(item.id)} className={cn(btn, scenario === item.id && 'border-ring/60 bg-accent text-foreground')}>
            {item.label}
          </button>
        ))}
        <span className="flex-1" />
        <button type="button" onClick={() => actions.remove('gemini')} className={btn}>
          Rimuovi gemini
        </button>
        {(['settings', 'onboarding'] as const).map((id) => (
          <button key={id} type="button" aria-pressed={screen === id} onClick={() => setScreen(id)} className={cn(btn, screen === id && 'border-ring/60 bg-accent text-foreground')}>
            {id === 'settings' ? 'Impostazioni → Agenti' : 'Schermata di primo avvio'}
          </button>
        ))}
      </div>
      <div className="flex h-[760px] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-[0_18px_44px_rgb(3_8_20/0.25)]">
        {screen === 'onboarding' ? (
          <div className="flex min-h-0 flex-1">
            <Onboarding key={scenario} statuses={statuses} agentActions={actions} onDone={() => setScreen('settings')} />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-8 py-7">
            <h2 className="text-xl font-semibold">{t('Add an agent')}</h2>
            <div className="max-w-[720px]">
              <AgentCatalog key={scenario} actions={actions} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
