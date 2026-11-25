import type { FileKind } from './file-type'
import type { Locale } from './i18n'
import type { Keybinding, ShortcutPreset } from './shortcuts'
import type { Plan, PlanChoice, PlanState } from './plan'
// Types shared between the session host, the main process and the renderer.
// The host is the source of truth: the renderer receives projects, sessions and chat items already built.

/** Agents in chat: the two native ones and the ACP ones, with the id of their entry (`acp:gemini`). */
export type AgentId = 'claude-code' | 'codex' | `acp:${string}`

/** An ACP agent entry: a command is enough. From the official registry or written by hand. */
export interface AcpAgentSpec {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  source: 'registry' | 'custom'
  /**
   * How the agent starts: `npx`/`uvx` (registry package), `binary` (downloaded by Ladder into `<data>/bin/<id>`,
   * `command` is the absolute path), `path` (CLI already installed, `command` is its path). Absent: hand-written entry.
   */
  distribution?: 'npx' | 'uvx' | 'binary' | 'path'
  version?: string | null
  description?: string | null
  /** Icon from the registry, downloaded when the agent is added and stored as a data URL (SVG). */
  icon?: string | null
}

// ── ACP agent catalog, detection and installation ────────────────────────────

/**
 * State of a catalog agent on this Mac:
 * - detected: found; an executable with the expected name is in the login shell's PATH (Ladder does not verify it is really that agent), or Ladder already downloaded it.
 * - downloadable: not there yet but Ladder can provide it: a binary with a verifiable checksum (`agents.install`),
 *   or an npx/uvx package (started with `agents.add`, the package is downloaded on first start).
 * - unavailable: Ladder cannot provide it; `reason` says why (no build for this Mac, no checksum, npx/uvx missing).
 */
export type AgentCatalogState = 'detected' | 'downloadable' | 'unavailable'

/** Sign-in method declared by the agent in `initialize` (ACP authMethods). */
export interface AgentAuthMethod {
  id: string
  name: string
  description: string | null
  /**
   * - agent: the agent handles sign-in (Ladder requests it via `authenticate`); this is also the case for a method without `type` (the ACP default).
   * - terminal: needs an interactive terminal (not supported yet).
   * - unsupported: any other type declared by the agent (e.g. `env_var`): Ladder cannot do it, so the UI does NOT show a
   *   "Sign in" button for these, at most the name as information. `agents.authenticate` rejects them.
   * (The field is called `type`, not `kind`.)
   */
  type: 'agent' | 'terminal' | 'unsupported'
}

/**
 * Login of an ACP agent, based only on what the protocol said in a real session:
 * - unknown: Ladder has not started the agent yet: unknown. This is not "not connected".
 * - ready: the agent opened a session without asking for sign-in (even if it declares no methods: `methods` can be empty).
 * - required: the agent answered auth_required; `methods` says how to sign in.
 * `methods` stays the one from the last `initialize`. `checkedAt` in milliseconds, null if unknown.
 */
export interface AgentLogin {
  state: 'unknown' | 'ready' | 'required'
  methods: AgentAuthMethod[]
  checkedAt: number | null
}

/**
 * Sign-in state of another agent (Gemini CLI, Copilot, Cursor, OpenCode and the like; not Claude, Codex and GitHub).
 * - connected: the agent opened a probe session (ACP `session/new`) without asking for sign-in.
 * - needs-login: the agent answered auth_required.
 * - unknown: not known: never probed, CLI missing, not probed (npx/uvx) or the probe failed (timeout, program that does not speak ACP).
 */
export type OtherAgentAuth = 'connected' | 'needs-login' | 'unknown'

/**
 * Row of "Other agents" in Subscription: a curated ACP agent (detected or not) or one added by the user, excluding the rows
 * of Claude, Codex and GitHub. `id` is the registry id, the same as AgentCatalogEntry and `agent.login`.
 * The list always contains the curated agents (even if not installed, `installed: false`) and the added ones.
 */
export interface OtherAgentConnection {
  id: string
  name: string
  /** Icon as a data URI (only if the agent is added and the registry provided it), otherwise null. */
  icon: string | null
  /** Already in "Your agents" (AgentStatus acp:<id>). Agents that are not added are added from Agents as before. */
  added: boolean
  /**
   * program: there is a local program (CLI in the login shell's PATH or a binary downloaded by Ladder) that Ladder can launch;
   * npx / uvx: the added agent starts from npx or uvx, with no local CLI. These are NEVER probed (a probe would download the package):
   * `installed` is false, `auth` unknown, no sign-in command.
   */
  runner: 'program' | 'npx' | 'uvx'
  /** The program exists (runner program and file present). Does not confirm it is really that agent: see AgentCatalogEntry.detected. */
  installed: boolean
  /** Path of the program; null if not installed. Display only (not needed to launch anything). */
  path: string | null
  /** From `--version` (4 second timeout); null if unknown. */
  version: string | null
  auth: OtherAgentAuth
  /**
   * Connected account. ACP has no standard account field and Ladder never reads the CLIs' files: for now it is always null,
   * the field exists so the UI can show it if an agent ever reports one (no UI should rely on it).
   */
  account: string | null
  /** When the last probe (or the last `agent.login` from a session) produced `auth`, in milliseconds; null if never. */
  checkedAt: number | null
  /** A probe is running: `auth` and `checkedAt` are the previous ones. */
  probing: boolean
  /**
   * Command to sign in, to show and to launch with `agents.others.login` (e.g. `copilot login`, `cursor-agent login`, `gemini`).
   * null = Ladder does not know a reliable sign-in command for this CLI: the UI shows "Open terminal" (`agents.others.login`
   * then opens the bare CLI, `openCommand`, and the user signs in from there). Also null if the agent is not installed.
   */
  loginCommand: string | null
  /** The bare CLI (e.g. `gemini`), which `agents.others.login` opens if `loginCommand` is null. null if not installed or if the program is only an ACP adapter (e.g. `amp-acp`): there is no CLI to open and sign-in happens from the agent's app or CLI. */
  openCommand: string | null
  /** Command to sign out (e.g. `cursor-agent logout`), only where the CLI has one; launched with `agents.others.logout`. */
  logoutCommand: string | null
  /** If `logoutCommand` is null: text (already translated) explaining how to disconnect, or null if nothing is known. */
  logoutHelp: string | null
  /** Terminal with a sign-in or sign-out in progress (to open in the UI); null if none. */
  terminalId: string | null
}

/**
 * Where the checksum that Ladder verifies before starting a downloaded binary comes from:
 * - registry: `sha256` in the registry entry.
 * - github-release: archive of a GitHub release; the checksum is the release `digest` (read at install time).
 * - missing: no verifiable checksum; Ladder does NOT download (install from the vendor's site, `installUrl`).
 * Even for `github-release` the checksum may turn out to be unavailable when read: see `AgentCatalogEntry.download`.
 */
export type AgentChecksumSource = 'registry' | 'github-release' | 'missing'

/**
 * Why Ladder does not download or install a binary (stable code for the UI, the text is already translated):
 * - no-checksum: no verifiable checksum (the registry does not provide one and the GitHub release does not publish the asset `digest`); not downloaded (install from the vendor's site, `installUrl`).
 * - checksum-unavailable: the GitHub release is reachable in theory but the checksum could NOT be read right now (network, rate limit). Transient state: the entry is `unavailable` with "try again later" and NO confirmation is offered; a new `agents.catalog` (after a few minutes) retries.
 * - host: the archive lives at an address Ladder does not expect for this agent (not https, domain not the vendor's, redirect elsewhere).
 * - checksum-conflict: the same version was already downloaded by Ladder with a different checksum from the one the registry gives now. `agents.install` REJECTS (the promise is rejected with only the error text, before answering: the code is NOT in the rejection) and the code arrives with the error `agent.install` event (`errorCode`), which is sent before the rejection.
 * - too-large: archive or extracted content over the limits (archive 600 MiB, extracted 2 GiB, 50,000 entries).
 * - signature: the binary is signed but the signature does not hold (`codesign --verify --deep --strict`), or (curated downloadable agents) the registry points to a different program than the one Ladder expects for the agent (`cmd` fixed in Ladder, for example the `java` of the JDK inside an app): text "points this agent to a different program", from the install and in `download.blocked`/`reasonCode` of the catalog. Signature text: "is signed, but its signature does not verify".
 * - team: curated agent with a team fixed in Ladder (OpenCode, Kiro, Junie) whose binary arrives unsigned, ad hoc signed or signed by another developer (the check is done by codesign on the certificate). Text: "not signed by the developer Ladder expects". Distinct from `signature` (broken signature).
 * - checksum-changed: the checksum, the address or the confirmation request (checksum and address of a second request differing from those of the download already in progress) do not match what the user saw in the dialog. `agents.install` REJECTS (promise rejected, with only the text, before answering) and the error `agent.install` event carries this `errorCode`: the UI reopens the confirmation with the data re-read from the catalog (to be re-read), it does not repeat the same attempt.
 * - quarantine: macOS quarantined the download and it would not start (Ladder does not remove the attribute).
 */
export type AgentBlockCode = 'no-checksum' | 'checksum-unavailable' | 'host' | 'checksum-conflict' | 'too-large' | 'signature' | 'team' | 'checksum-changed' | 'quarantine'

/**
 * Code signature of an installed binary, read by `codesign` after extraction and before the move:
 * - signed: intact signature AND certificate verified as Apple Developer ID (chain up to the Apple root, leaf Developer ID Application) or a system Apple signature; `signer` is the leaf's Authority (e.g. "Developer ID Application: Name (TEAM)") and `team` the TeamIdentifier.
 * - unverified: intact signature (`codesign --verify` passes) but the signer is NOT verified as Apple Developer ID: self-signed certificate, non-Apple chain or a leaf that is not Developer ID. `signer` and `team` are null on purpose (anyone can write the name inside the certificate): the UI must NOT show "Signed by …", only "Signature intact, signer not verified".
 * - adhoc: ad hoc signature (no identity, like the linker's on arm64): intact but does not say who produced it. `signer` and `team` null.
 * - unsigned: no signature; it is installed anyway and the UI flags it.
 * `signer` and `team` come from the signature's leaf certificate (already verified), not from the text of `codesign -d` (the Identifier is chosen by the signer).
 * A signed binary whose verification fails is not installed (AgentBlockCode `signature`). For curated agents with a team fixed in
 * Ladder (OpenCode, Kiro, Junie) only `signed` by the expected team is installed; any other outcome is `team`.
 */
export interface AgentSignature {
  state: 'signed' | 'unverified' | 'adhoc' | 'unsigned'
  signer: string | null
  team: string | null
}

/** A catalog agent: the curated ones first, then the rest of the registry in alphabetical order. */
export interface AgentCatalogEntry {
  /** Registry id ("gemini", "cursor", "github-copilot-cli"…); the agent in chat is `acp:<id>`. */
  id: string
  name: string
  description: string
  /** Version pinned by the registry (the one `agents.install` downloads). */
  registryVersion: string
  /** In the curated list (11 agents, in this order); false for the rest of the registry. */
  curated: boolean
  state: AgentCatalogState
  /** Why `unavailable` (already translated); null otherwise. */
  reason: string | null
  /** Already in "Your agents" (AgentStatus acp:<id>). */
  added: boolean
  /** The agent's page (site, otherwise repository), https only: "link to the procedure". Null if the registry does not give it. */
  docsUrl: string | null
  /** How it starts on this Mac, according to the registry (arm64): null if no usable distribution. */
  distribution: 'binary' | 'npx' | 'uvx' | null
  /**
   * Vendor page with the installation procedure (https). For curated agents it is fixed in Ladder, for the others it is the site
   * (otherwise the repository) declared by the registry; null if there is none. With `reasonCode` `no-checksum` it is the link to show.
   */
  installUrl: string | null
  /** If `reason` is one of the AgentBlockCode cases, which one; null otherwise. */
  reasonCode: AgentBlockCode | null
  /**
   * Only if `distribution` is binary and there is a verifiable checksum: everything the confirmation dialog needs.
   * - checksum: where it comes from; sha256: the full checksum in hex. The UI offers the confirmation (install/update) ONLY if
   *   `sha256` is not null AND `blocked` is null: an `agents.install` without a checksum does not exist. `sha256` is null for a GitHub release
   *   when it could not be read right now (`blocked: 'checksum-unavailable'`, entry `unavailable`) or when the release does not
   *   publish it (`blocked: 'no-checksum'`, entry `unavailable` with `reasonCode` `no-checksum` and `installUrl`, like Cursor). In `agents.detect` (which does not read releases) it can be null without being a block.
   * - host: where it is downloaded from, lowercase (it is what `agents.install` must send back unchanged). For github.com it is `github.com/<owner>/<repository>` (to show as such in the dialog); for the others only the host; size: bytes of the archive from HEAD/Content-Length with a timeout (null if unknown: it blocks nothing);
   * - blocked: whether Ladder would refuse this download (the install would fail with the same code): 'host', 'checksum-conflict', 'no-checksum' or 'checksum-unavailable'.
   * To show the version, name and size: `registryVersion`, `name`, `size`.
   */
  download: { checksum: AgentChecksumSource; sha256: string | null; host: string; size: number | null; blocked: AgentBlockCode | null } | null
  /**
   * Executable with the expected name found in the login shell's PATH (curated agents only): the name may belong to another program,
   * so `path` is a "found" and not a confirmation. `version` from `--version` only in `agents.catalog` (with a 4 second timeout); in `agents.detect` it is always null.
   */
  detected: { path: string; version: string | null } | null
  /**
   * Binary downloaded by Ladder; `updateAvailable`: the registry has a different version. No automatic update.
   * `signature`: codesign result at install time; null if unknown (installed before this check).
   */
  installed: { version: string; updateAvailable: boolean; signature: AgentSignature | null } | null
  login: AgentLogin
  /** Install in progress, if any. */
  install: AgentInstall | null
}

/**
 * Installation (or update) of a binary. `stage` reuses the ConnectionStage steps: downloading (the checksum is
 * verified at the end of the download), installing (extraction), verifying (the program is inside the agent's folder and not
 * quarantined), finishing (folder swap). `state` done/error/cancelled close the operation.
 */
export interface AgentInstall {
  id: string
  version: string
  state: 'running' | 'done' | 'error' | 'cancelled'
  stage: ConnectionStage | null
  /** From 0 to 1, only in `downloading`; null if the size is unknown. */
  progress: number | null
  bytes: number | null
  total: number | null
  /** Already translated error (wrong checksum, no checksum, unsafe archive…); null if none. */
  error: string | null
  /** If the error is one of the security blocks (AgentBlockCode), which one; null otherwise. */
  errorCode: AgentBlockCode | null
  /**
   * Binary signature, known from `verifying` onwards (once installed it stays here and in `AgentCatalogEntry.installed.signature`).
   * The user's confirmation comes before the download, so the signature is shown after the install: an `unsigned` binary is installed anyway.
   */
  signature: AgentSignature | null
}
/** Chat: the agent talks to Ladder. Terminal: the original CLI runs in a PTY. */
export type SessionMode = 'chat' | 'terminal'
export type PermissionLevel = 'plan' | 'ask' | 'edit' | 'full'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface Project {
  id: string
  name: string
  path: string
  branch: string | null
  isGit: boolean
  addedAt: number
  /** Profile chosen for this project, per agent. Absent = default profile. */
  profiles?: Partial<Record<ProfileAgent, string>>
}

/** Agents that have an account: Claude Code and Codex. */
export type ProfileAgent = 'claude-code' | 'codex'

/**
 * A named account ("Work", "Personal") for an agent, with its configuration folder
 * (`CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex). The default profile (`isDefault`) has no Ladder
 * folder: it uses the CLI's own (~/.claude, ~/.codex) and always exists, one per agent. Default id: `default:<agent>`.
 */
export interface Profile {
  id: string
  agent: ProfileAgent
  name: string
  /** Configuration folder managed by Ladder; null in the default profile. */
  configDir: string | null
  isDefault: boolean
  addedAt: number
}

/** Execution state: derived from the agent, not from the UI. No limit on active sessions: a turn always starts right away. */
export type RunState = 'idle' | 'starting' | 'running' | 'waiting' | 'error'

/** Attachment sent to the agent. For now images only, in base64. */
export interface Attachment {
  name: string
  mediaType: string
  data: string
}

export interface QueuedMessage {
  id: string
  text: string
  attachments?: Attachment[]
}

/** Where the title comes from: provisional (from the first message), generated by a small model, chosen by the user. */
export type TitleSource = 'provisional' | 'generated' | 'user'

export interface SessionSummary {
  id: string
  projectId: string
  title: string
  /** 'user' wins over any automatic generation; "Regenerate title" sets it back to 'generated'. */
  titleSource: TitleSource
  /** A title is being generated (automatic or requested): the UI can show an indicator. */
  titleGenerating?: boolean
  agent: AgentId
  /** Profile the session runs with (Claude Code and Codex only); absent = default. Fixed at creation. */
  profileId?: string | null
  model: string | null
  effort: Effort | null
  /** Effort actually in use when the session did not choose one, if the agent reports it (init). */
  effortEffective?: Effort | null
  permission: PermissionLevel
  /** Requested level that applies from the next turn (Codex mid-turn); null if none is pending. */
  permissionNext?: PermissionLevel | null
  createdAt: number
  updatedAt: number
  run: RunState
  /** Short label when the session is waiting for the user: "Approval", "Question". */
  waitingLabel: string | null
  /** Text of the current activity while working: "Running pnpm test". */
  activity: string | null
  unread: boolean
  /**
   * Notice about background sub-agents that finished since you last opened the session:
   * sidebar state and Dock badge. Reset by session.open / session.read.
   */
  agentsNotice?: { finished: number; failed: number; at: number } | null
  /** Last item read: the first unread is lastReadSeq + 1. */
  lastReadSeq: number
  archived: boolean
  queue: QueuedMessage[]
  context: {
    /** Tokens in the context right now (last call of the main loop), not the sum over the turn. */
    used: number
    window: number
    /** Token count at which automatic compaction triggers; null if disabled, absent if unknown. The indicator color follows this threshold. */
    compactAt?: number | null
  } | null
  mode: SessionMode
  /** Folder the session works in: the main checkout or its worktree. */
  cwd: string
  worktree: WorktreeInfo | null
  /** Terminal session: command started (claude, codex, …) and the terminal hosting it. */
  command: string | null
  terminalId: string | null
  /** The state comes from heuristics (output, bell), not from agent signals. */
  estimated: boolean
  /** Since when the session has been waiting for the user: sorts "Waiting" and ⌘⇧A by age. */
  waitingSince: number | null
  /** Oldest open request, to answer from "Waiting" without opening the session. */
  request: RequestItemData | null
  /** Open requests (usually one; more than one with parallel tools). */
  openRequests: number
  /** Last agent activity (end of turn, error): decides "Finished" and "While you were away". */
  activityAt: number
  /**
   * The agent accepts messages inside the running turn (Claude: message in the input
   * stream, inserted between one tool round and the next; Codex: turn/steer). ACP: false.
   */
  canSteer: boolean
  /** Branch the session works on: the worktree's or the main checkout's. */
  branch: string | null
  /** State of the branch's PR, if any (from gh). */
  pr: PrStatus | null
  /** Where the session came from: issue, PR or branch. */
  source: SessionSource | null
  /** Sub-agents of the last turn and those still alive: the agent map. */
  /**
   * Light sub-agent counts, in the summary. The full list no longer travels
   * here: it arrives with the session.subagents event (and with the subagent.list request).
   */
  subagentCounts?: { total: number; running: number; runningForeground: number; error: number }
  /** Session created by a handoff ("Switch to…"): from which session and agent. Absent or null = normal session. */
  handoffFrom?: { sessionId: string; agent: AgentId } | null
  /**
   * Child session launched by another session (advice, delegation, review). It does not appear in the sidebar session list:
   * it opens from the card or from the parent session's agent map. It is archived with the parent.
   * itemId: parent row that launched it (AdviceItem, or the 'tool' row of the delegation).
   */
  parent?: { sessionId: string; role: 'advisor' | 'delegate' | 'review'; itemId: string } | null
  /**
   * Executable plans. coordinator: the session where the plan was written (it has the card); task: the session where
   * a plan task runs. Absent or null = the session has nothing to do with a plan. A coordinator with several plans points to the latest.
   */
  plan?: { planId: string; role: 'coordinator' | 'task'; taskId: string | null } | null
  /**
   * The coordinator has a plan to approve or paused (waiting for you). `run` stays the real one (the session is not busy: you can
   * write, stop, use commands); `waitingLabel` ("Plan review", "Plan paused") and `waitingSince` say since when it waits.
   */
  planWaiting?: boolean
  /**
   * Who started the session outside the UI. cli: from the `ladder` CLI; agent: from another session with the
   * `ladder_start_session` MCP tool (sessionId and agent of the starter). Absent or null = from the UI (or from a plan).
   */
  origin?: { kind: 'cli' } | { kind: 'agent'; sessionId: string; agent: AgentId } | null
}

/** A sub-agent started by the session (Claude Code Task, Codex spawnAgent). */
export interface SubagentInfo {
  /** Stable id: Claude Code's tool_use or the Codex sub-agent thread. */
  id: string
  /** Sub-agent that started it; null if the session started it. */
  parentId: string | null
  /** Task in brief: "Explore the auth module". */
  title: string
  /** Agent type: "general-purpose", "Explore", "worker". */
  kind: string | null
  /** Actual or chosen model; null if unknown: the UI shows the session's as inherited. */
  model: string | null
  /** Effort requested for the sub-agent; null if inherited or unknown. */
  effort?: Effort | null
  /** Id of the 'tool' row in chat that launched it (for Claude it equals id; for Codex it is the collab item). */
  toolId?: string | null
  status: 'running' | 'done' | 'error' | 'stopped'
  startedAt: number
  endedAt: number | null
  /** What it is doing right now: the last tool or the agent's summary. */
  activity: string | null
  tokens: number | null
  toolUses: number | null
  /** Keeps going in the background while the session moves on. */
  background: boolean
}

/**
 * Heavy detail of a sub-agent, on request only (subagent.detail): in the
 * SessionSummary only the light SubagentInfo fields travel. If the board no
 * longer has the agent (previous turns, restart), the host rebuilds it from the 'tool' row.
 */
export interface SubagentDetail {
  info: SubagentInfo | null
  prompt: string | null
  /** Final report in markdown; null while the agent works or if there is none. */
  report: string | null
  /** Tools used, oldest first; at most the last 200. */
  tools: { name: string; title: string; status: 'running' | 'done' | 'error' | 'denied'; at: number }[]
}

export interface SessionSource {
  kind: 'github-issue' | 'github-pr' | 'linear' | 'branch'
  /** "#12", "LIN-42", branch name. */
  ref: string
  title: string
  url: string | null
}

export interface PrStatus {
  number: number
  title: string
  url: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  checks: 'none' | 'pending' | 'passing' | 'failing'
  /** conflicts: the branch does not merge into the base without conflicts. */
  mergeable: 'clean' | 'conflicts' | 'unknown'
  review: 'approved' | 'changes' | 'pending' | null
  base: string
  updatedAt: number
  /** When it was merged; null if not merged or the date is missing. Different from `updatedAt`, which a comment moves. */
  mergedAt?: number | null
}

export interface WorktreeInfo {
  path: string
  branch: string
  /** Commit the worktree started from. */
  base: string
}

export interface FileChange {
  path: string
  /** Path before the rename. */
  oldPath?: string
  added: number
  removed: number
  status: 'A' | 'M' | 'D' | 'R'
  binary?: boolean
}

export type ToolKind = 'command' | 'read' | 'edit' | 'search' | 'web' | 'agent' | 'plan' | 'other'

export interface RequestOption {
  id: string
  label: string
  kind: 'allow' | 'allow-always' | 'deny'
}

export interface Question {
  question: string
  header: string | null
  multiSelect: boolean
  options: { label: string; description: string | null }[]
}

interface ItemBase {
  id: string
  turnId: string
  /** Stable order within the session. */
  seq: number
  at: number
}

export type ChatItem =
  | (ItemBase & {
      kind: 'user'
      text: string
      attachments?: { name: string; mediaType: string }[]
      /** Inserted into the running turn instead of opening a new one. */
      steered?: boolean
    })
  | (ItemBase & { kind: 'assistant'; text: string; streaming: boolean })
  | (ItemBase & {
      kind: 'tool'
      tool: ToolKind
      /** Name of the agent's tool, for example Bash or Edit. */
      name: string
      /** Short readable text: "Running pnpm test", "Reading src/app.ts". */
      title: string
      /** Full command, path or pattern. */
      detail: string | null
      status: 'running' | 'done' | 'error' | 'denied'
      output: string | null
      endedAt: number | null
      /** Only for the 'agent' tool: the sub-agent's model and effort, to show them also after a restart. */
      agent?: { model: string | null; effort: Effort | null } | null
    })
  | (ItemBase & {
      kind: 'request'
      requestId: string
      requestType: 'permission' | 'question'
      toolName: string
      title: string
      command: string | null
      path: string | null
      /** All files touched when more than one (Codex patch); path is the first. */
      paths?: string[]
      reason: string | null
      options: RequestOption[]
      questions: Question[] | null
      state: 'open' | 'resolved' | 'expired'
      /** Text describing the answer given: "Approved", "Rejected: use pnpm". */
      resolution: string | null
      /** Proposed change for Edit and Write, as lines with - and +. */
      preview?: { text: string; lines: number; truncated: boolean } | null
      /** Where you answered: in the chat, from "Waiting" or from the notification. */
      via?: ResponseVia
      /** With via 'phone': name of the phone that answered, for "from Alex's phone". */
      viaDevice?: string
    })
  | (ItemBase & {
      kind: 'turn-end'
      status: 'completed' | 'interrupted' | 'error'
      durationMs: number
      counts: { commands: number; edits: number; reads: number; searches: number }
      /** Turn ended with no changes, commands, agents or questions: "it stopped without asking anything". Only with HostPrefs.stallHint. */
      stalled?: boolean
      files: FileChange[]
      error: string | null
      costUsd: number | null
      /** Git checkpoints at the start and end of the turn: used by the diff and by restore. */
      checkpoints?: { start: string; end: string } | null
    })
  | (ItemBase & { kind: 'notice'; tone: 'info' | 'error'; text: string })
  /** Command / run by the user: system row, not a user message. */
  | (ItemBase & { kind: 'command'; name: string; args: string; status: 'running' | 'done' | 'error' | 'interrupted'; error: string | null })
  /**
   * At the head of a turn opened by the agent without a user message (implicit turn):
   * 'background-agents' if it restarted after background sub-agents finished (finished = how many).
   */
  | (ItemBase & { kind: 'agent-start'; reason: 'background-agents' | 'other'; finished: number | null })
  /**
   * End of the last background sub-agent with the coordinator idle. state 'waiting':
   * the agent did not restart on its own within a few seconds, the UI shows "Continue", which sends
   * session.continue; 'resumed': it restarted on its own (implicit turn); 'continued': the user
   * pressed Continue or wrote; 'dismissed': superseded by another turn.
   */
  | (ItemBase & { kind: 'agents-finished'; finished: number; failed: number; state: 'waiting' | 'resumed' | 'continued' | 'dismissed' })
  /** Compacted context (from /compact or automatic). The text is composed by the UI. */
  | (ItemBase & { kind: 'compacted'; trigger: 'manual' | 'auto'; preTokens: number | null; postTokens: number | null })
  /** Handoff of the work to another agent. See HandoffItem. */
  | (ItemBase & HandoffItem)
  /** Card for /advisor (one agent) or /committee (several agents). See AdviceItem. */
  | (ItemBase & AdviceItem)
  /** Resume card for an interrupted delegation. See ResumeItem. */
  | (ItemBase & ResumeItem)
  /** Plan limit reached or reset. See LimitItem. */
  | (ItemBase & LimitItem)
  /**
   * Executable plan card, at the point of the coordinator's chat where the agent called propose_plan (or where
   * a template was used). The content does not travel here: the UI reads PlanState from the store (plan.updated event).
   */
  | (ItemBase & { kind: 'plan'; planId: string })

/** Interrupted delegation (app restart, stop, exit): resumed or dismissed. System row in the parent. */
export interface ResumeItem {
  kind: 'resume'
  /** 'tool' row of the delegate call in the parent. */
  toolItemId: string
  agent: AgentId
  childSessionId: string | null
  reason: string
  state: 'open' | 'resumed' | 'done' | 'dismissed' | 'error'
  error: string | null
}

/**
 * Plan limit. 'reached': the session's agent is at its limit (UsageWindow 'limited' or a limit error at end of
 * turn): proposes continuing with `target` (the project's autoSwitch, otherwise the first allowed and available agent of
 * another provider); with autoSwitch the handoff starts on its own and the row is born 'switched'. 'reset': in the
 * session handed over to, when the previous agent's limit resets, proposes going back.
 */
export interface LimitItem {
  kind: 'limit'
  phase: 'reached' | 'reset'
  /** Agent at its limit (or reset). */
  agent: AgentId
  /** Window name: "5-hour limit", "Weekly limit". */
  window: string
  /** Unix seconds; null if unknown. */
  resetsAt: number | null
  target: AgentId | null
  state: 'proposed' | 'switched' | 'returned' | 'dismissed' | 'error'
  /** Destination session after 'switched' or 'returned'. */
  peerSessionId: string | null
  automatic: boolean
  error: string | null
}

/**
 * Read-only advice from other agents on the session's work. System row (turnId 'system'), it does not open a
 * session turn and can be requested while the session is working. Each entry is a child session (parent.role
 * 'advisor') in Plan mode in the same folder; `text` is its last text at the end of its first turn.
 */
export interface AdviceItem {
  kind: 'advice'
  /** 'review' = automatic cross-review at the end of a turn with changes. */
  mode: 'advisor' | 'committee' | 'review'
  /** User question; '' = general opinion on the work and the current diff. */
  question: string
  entries: {
    agent: AgentId
    model: string | null
    /** Child session; null if it did not start. */
    sessionId: string | null
    state: 'running' | 'done' | 'error' | 'stopped'
    text: string | null
    error: string | null
  }[]
  /** The advice was sent to the session's agent with session.advice.forward. */
  forwarded: boolean
  /**
   * Only for mode 'review': verdict read from the first line of the advice ("VERDICT: ok|minor|serious"); null while missing
   * or if the reviewer does not write it. With 'serious' the advice goes to the coordinator on its own (forwarded true), at most once
   * per user message.
   */
  verdict?: 'ok' | 'minor' | 'serious' | null
}

/**
 * Ladder MCP server ("ladder"), exposed to every chat session (Claude, Codex, ACP with MCP over HTTP) like the agent's
 * browser server: HTTP on 127.0.0.1, token per session. Tools (mcp__ladder__*):
 * - list_agents(): agents that can be handed off to or delegated to in this project (available, allowed by [agents], with models),
 *   and the project's preferred delegates ([[agents.delegates]]).
 * - handoff({ agent, summary, note? }): the agent itself asks for the handoff, with the summary it already wrote (no summary
 *   turn). Same rules as session.handoff; agent not allowed, same or unavailable → readable error as the
 *   tool result. With permission 'plan' or 'ask' the user must confirm (a 'request' row like the others).
 *   The handoff starts at the end of the session's turn (HandoffItem 'out' row with reason 'agent', state 'pending' until the
 *   turn ends); the tool answers right away asking the agent to stop.
 * - delegate({ agent, prompt, model?, effort?, read_only?, worktree? }): delegates to an agent of another provider inside the turn.
 *   Creates a child session (parent.role 'delegate', itemId = 'tool' row of the call), same folder, permission never higher
 *   than the parent's ('plan' with read_only), and waits for the end of its first turn: the tool result is the child's
 *   report_result if present, otherwise its last text. In the parent's agent map the child appears as a
 *   sub-agent (SubagentInfo with kind = agent name, model, status, tokens if known). Parent stop → child
 *   stop. Guards: max depth 2 (a delegated child can delegate once), at most 4 delegations per turn, no
 *   delegation back to the parent's agent in the same chain with the same task. `worktree: true` (only
 *   with write permission) creates a new worktree for the child from the parent's HEAD, only at that moment; the result
 *   states the branch. Without it, the child works in the parent's folder (which waits for the delegation to end).
 * - report_result({ status, summary, files? }): a child session (delegate) or one reached by a handoff returns its outcome.
 *   For a delegation it becomes the result of delegate. For a session reached by a handoff it updates the 'out' row of the
 *   origin session (HandoffItem.result) and sends a light notification to the origin.
 */
export interface AgentResult {
  status: 'done' | 'blocked' | 'failed'
  /** Markdown written by the agent. */
  summary: string
  files?: string[]
  at: number
}

/**
 * "Switch to…": separator of a handoff between agents.
 * - 'out', in the origin session: opens the turn in which the current agent writes the summary (in place of the 'user' row).
 *   state 'summarizing' while the turn works; 'done' when the destination session has received the summary; 'error' or
 *   'interrupted' if the turn does not end well or the summary is empty (no destination session).
 * - 'in', in the destination session: opens the turn that delivers the summary to the other agent (in place of the 'user' row).
 *   Born already 'done', with summary, files and checkpoint.
 */
export interface HandoffItem {
  kind: 'handoff'
  /**
   * 'implement' = "Implement with…" to another agent: no summary turn, `summary` is the plan
   * (with comments) and the 'out' row is born already 'done'. 'agent' = requested by the agent with the handoff tool,
   * summary written by it. Absent = 'handoff' (handoff with summary).
   */
  /** 'limit' = plan limit reached: summary composed by Ladder (conversation and files), not by the agent. */
  reason?: 'handoff' | 'implement' | 'agent' | 'limit'
  direction: 'out' | 'in'
  /** Agent on the other side: the receiver for 'out', the sender for 'in'. */
  agent: AgentId
  /** Session on the other side; null for 'out' until the destination session exists (or if the handoff failed). */
  peerSessionId: string | null
  /** 'pending': handoff requested by the agent with the handoff tool, starts at the end of the turn. */
  state: 'pending' | 'summarizing' | 'done' | 'error' | 'interrupted'
  /** Outcome returned with report_result by the destination session (only on the 'out' row). */
  result?: AgentResult | null
  /** Note written by the user in the "Switch to…" dialog; null if absent. */
  note: string | null
  /** Summary of goal, decisions and state written by the origin agent (markdown); null until available. */
  summary: string | null
  /** Git checkpoint taken at the handoff (sha at the end of the summary turn); null outside git or before the end. */
  checkpoint: string | null
  /** Files changed by the origin session since its first checkpoint, at the time of the handoff. */
  files: FileChange[]
  error: string | null
  /**
   * 'out' row in 'interrupted' or 'error' that can be resumed (session.handoff.resume): the saved summary, if
   * any, is delivered without asking for it again; otherwise it is requested. Commands are never repeated: the summary turn is text only.
   */
  resumable?: boolean
}

/**
 * Command / declared by the session's agent. Ladder's own commands
 * (/model, /effort, /new) do not go through here: the UI defines and handles them.
 * - claude-code: supportedCommands() and commands_changed (builtin, .claude/commands, skill).
 * - codex: fixed compact and review, plus the skills from skills/list.
 * - acp: available_commands_update.
 */
export interface SlashCommand {
  /** Without "/". */
  name: string
  description: string
  /** Hint for the arguments; null if the command takes none. */
  hint: string | null
  source: 'builtin' | 'custom' | 'skill'
  aliases?: string[]
}

export type RequestResponse = { optionId: string; message?: string } | { answers: Record<string, string> }
/** 'phone': answer that came from a remote client; the Mac's chat can show it as "from phone". */
export type ResponseVia = 'chat' | 'inbox' | 'notification' | 'phone'
export type RequestItemData = Extract<ChatItem, { kind: 'request' }>

/** One window of the plan's limits: how much you used and when it resets. */
export interface UsageWindow {
  key: string
  minutes: number
  /** Limit reserved for a model family, for example Opus. */
  model: string | null
  percent: number | null
  /** Unix seconds. */
  resetsAt: number | null
  state: 'ok' | 'warning' | 'limited'
  /** Ready-made name when the window is not a duration, for example a model or extra usage. */
  label?: string
  /** Text under the bar in place of the reset, for example "€12.40 of €50". */
  detail?: string
  /** Where the window's consumption comes from, in percentage points of the limit: "Claude Code 34", "Chat 2". */
  breakdown?: { label: string; percent: number }[]
}

export interface AgentStatus {
  agent: AgentId
  name: string
  kind: 'native' | 'acp'
  available: boolean
  version: string | null
  /** Account in use, for example "Claude Ultra" or "ChatGPT Plus". */
  account: string | null
  /** Profile this state belongs to (Claude Code and Codex); absent = default. Each profile has its own account, limits and models. */
  profileId?: string
  /** Account email, when the agent exposes it: shown at the bottom of the sidebar. */
  email?: string | null
  /**
   * `efforts`: levels the model accepts; empty if it has none, absent if the agent does not say.
   * `isDefault`: the model that starts if the session does not choose one (at most one per agent;
   * alias rows like "default" do not appear). Source: the agent's config (Claude settings,
   * Codex config.toml), then the default declared by the agent (resolvedModel, isDefault, currentValue).
   * `defaultEffort`: level used if the session does not choose one; null or absent if unknown.
   */
  models: { id: string; label: string; efforts?: Effort[]; isDefault?: boolean; defaultEffort?: Effort | null }[]
  error: string | null
  /** Limit windows, updated by every session. */
  usage?: UsageWindow[]
  /** When the limits were last read, in milliseconds. */
  usageAt?: number | null
  /** Readable usage limits, when the agent exposes them: "14% of the 5 h window · 11% weekly". */
  limits?: string | null
  /** Path of the CLI in use. */
  path?: string | null
  /** ACP agent icon (data URL); for the native ones the interface chooses it. */
  icon?: string | null
}

export type InspectorTab = 'changes' | 'files' | 'history' | 'merge'
export type EditorId = 'cursor' | 'vscode' | 'zed' | 'xcode'
/** Which external editors are installed (answer of `ladder:editors`, which used to have only cursor and vscode). */
export type EditorAvailability = Record<EditorId, boolean>

/**
 * Defaults for a new session. Every absent or null field inherits from the level below.
 * Resolution order (in the renderer): project (ProjectUiState.defaults), then
 * the TOML [agents] default for that agent only, then global (AppPrefs.defaults),
 * then the last agent used and the agent's defaults. A value that is no longer valid
 * (agent absent or not allowed, model not in AgentStatus.models, effort not
 * supported, permission above the project's maximum) is ignored or reduced.
 */
export interface SessionDefaults {
  agent?: AgentId | null
  /** Model per agent: a model only makes sense with its own agent. */
  models?: Partial<Record<AgentId, string>>
  efforts?: Partial<Record<AgentId, Effort>>
  permission?: PermissionLevel | null
}

/**
 * Session profile: a saved combination to start a session with one click. It is not the account profile
 * (`Profile`): that says which subscription the agent runs with, this one which settings are used.
 * Saved in the app preferences (`AppPrefs.presets`), valid in all projects.
 */
export interface SessionPreset {
  id: string
  /** Short name: "Quick review", "Long feature". Unique, case-insensitive. */
  name: string
  /** What it is for, in one or two sentences. Later the coordinator agent will be able to use it to choose whom to delegate to. */
  note?: string
  agent: AgentId
  /** Account (`Profile`) to start with; absent = the project's. Ignored if it no longer exists or does not belong to the agent. */
  profileId?: string | null
  /** Model and effort apply only if the agent still has them; otherwise the default applies. */
  model?: string | null
  effort?: Effort | null
  permission: PermissionLevel
  /** Works in a new worktree. */
  worktree: boolean
  /** Initial draft text: appears in the composer, does not start on its own. */
  prompt?: string
}

/** Key that sends in the composers: Enter (⇧Enter adds a newline) or ⌘Enter (Enter adds a newline). */
export type SendKey = 'enter' | 'mod-enter'

export interface ProjectUiState {
  tabs: string[]
  activeTab: string | null
  /** Per-session reading anchor: item at the top of the view and offset in pixels. */
  scroll: Record<string, { itemId: string; offset: number }>
  /** Right inspector (Changes, Files, History) and bottom terminal panel. */
  inspector?: { open: boolean; tab: InspectorTab }
  terminal?: { open: boolean; height: number; active: string | null; side?: 'bottom' | 'right'; width?: number }
  /** Preferred external editor for the project; absent = AppPrefs.editor. */
  editor?: EditorId
  /** Last time you looked at the project with the window active: used by "While you were away". */
  seenAt?: number
  /** Files opened as tabs, in opening order. */
  fileTabs?: { root: string; path: string }[]
  /** Chat groups you created, in the order they appear in the sidebar. */
  groups?: { id: string; name: string; collapsed?: boolean }[]
  /** Group of each grouped session. */
  groupOf?: Record<string, string>
  /** Last agent used in chat in the project: the new chat proposes it. */
  lastAgent?: AgentId
  /** false turns off, in this project, branches, commits and PRs written by the model (applies together with AppPrefs.generatedText). Absent = on. */
  generatedText?: boolean
  /** Personal defaults for new sessions in this project (not committed). */
  defaults?: SessionDefaults
  /**
   * Session profile (`SessionPreset.id`) proposed by this project's new chat; ignored if it no longer exists.
   * The project default applies the values but does not insert the initial prompt: that goes into the draft only when choosing the profile (selector or ⌘K).
   */
  defaultPreset?: string
  /**
   * Sessions side by side in the project view: 2 to 3 columns, in left to right order, and the active one
   * (the column that receives shortcuts). Absent: a single column. Ids of sessions that no longer exist are ignored on read.
   */
  split?: { sessions: string[]; active: string }
  /** Last choice of the new chat in this project: where the session works and, with a worktree, which branch it starts from (absent = the current one). */
  newChat?: { worktree: boolean; baseBranch?: string | null }

  // ── Built-in browser ──
  /** Browser tabs open in the project, in the order they appear: `id` is the tab's identity, `url` the last address (reopened there on restart). */
  browserTabs?: { id: string; url: string; title?: string }[]
  /** Browser column to the right of the chats: open or not, active page (saved tab or an agent's; gone = the first), chosen width in px (absent = 40%). */
  browserColumn?: { open: boolean; active: string | null; width?: number }
  // ── End of built-in browser ──

  // ── Agent browser ──
  /** Browser for the agent in this project: true/false overrides AppPrefs.agentBrowser; absent = the global one applies. Applies from the next restart of each session's agent (turned off: immediately). */
  agentBrowser?: boolean
  // ── End agent browser ──

  // ── Split view ──
  /** Proportions of the side-by-side columns, one per column in `split.sessions` (same order). Absent or of a different length: equal parts. */
  columnWidths?: number[]
  // ── End split view ──
}

/** Sidebar section that collects projects, created by you. */
export interface ProjectGroup {
  id: string
  name: string
  collapsed: boolean
  /** Projects in the section, in the order they appear. */
  projectIds: string[]
}

/**
 * Project groups, global (not per project). Every existing project appears exactly once:
 * in a section or in `ungrouped`. The host keeps the state consistent: a new project goes to the end of `ungrouped`,
 * a removed one disappears everywhere, so the UI never has to clean up orphan references.
 */
export interface ProjectGroupsState {
  /** Sections in the order they appear. */
  groups: ProjectGroup[]
  /** Projects outside every section, in the order they appear. */
  ungrouped: string[]
}

// ── Keyboard shortcuts ───────────────────────────────────────────────────

/**
 * Shortcut state, global. The host keeps keybindings.json in the app's data folder (VS Code format:
 * array of `{ key, command }`, `-command` removes the default one; comments and trailing commas are allowed) and the chosen preset.
 * To apply it, `applyShortcutConfig({ preset, overrides })` from shared/shortcuts is enough.
 */
export interface ShortcutsState {
  preset: ShortcutPreset
  /** Valid entries of the file, in the order they appear: these are applied on top of the preset. */
  overrides: Keybinding[]
  /** Ignored entries (unknown command, invalid shortcut) or unreadable file, already translated. The entries stay in the file. */
  warnings: string[]
  /** Absolute path of keybindings.json (may not exist yet). */
  file: string
  /**
   * The file is not valid JSON (the message is also among the warnings): `overrides` is the last state read correctly
   * and the file is left alone until you fix or restore it.
   */
  invalid: boolean
}

// ── Files, diff and history ──────────────────────────────────────────────

export type GitStatusCode = 'M' | 'A' | 'D' | '?' | 'U'

export interface FileTree {
  root: string
  isGit: boolean
  /** Relative paths: tracked plus untracked, not ignored. */
  files: string[]
  status: Record<string, GitStatusCode>
  truncated: boolean
}

export interface FileContent {
  path: string
  size: number
  binary: boolean
  tooLarge: boolean
  text: string | null
  /** Modification time on disk: on save it tells whether someone wrote the file in the meantime. */
  mtimeMs: number
  /** For binary files, type, size and preview URL (see FileMedia). */
  media?: FileMedia | null
}

export type FileWriteResult = { ok: true; mtimeMs: number } | { ok: false; text: string; mtimeMs: number }

// ── Preview of images, PDFs and media ────────────────────────────────────
// The bytes do not go through the MessagePort: the UI loads them from a URL `ladder-file://<id>/<path>[?rev=<rev>]` (img, video, audio, iframe),
// served by main only for known roots (project or session worktree). `<id>` is the opaque id the host gives with FileMedia.url;
// `rev` is HEAD or a full git sha (checkpoint, commit): it serves that revision's version instead of the file on disk.
// See shared/file-type.ts (fileUrl to build the URLs, isKnownRev) and main/file-protocol.ts.

export type { FileKind }

/** Description of a non-text file, for the viewer and the diff. */
export interface FileMedia {
  /** image: png, jpg, gif, webp, ico, avif, bmp; svg: show only with <img>; other: outside the whitelist, no preview. */
  kind: FileKind
  /** Real type (from the first bytes), `application/octet-stream` for 'other'. */
  mime: string
  size: number
  /** Only for raster images read from the header (not avif, not svg): otherwise null and the UI reads naturalWidth from the <img>. */
  width: number | null
  height: number | null
  /** Modification time of the file on disk; null for a git revision. */
  mtimeMs: number | null
  /** ladder-file URL ready for <img>/<video>/<audio>/<iframe>; null for 'other' (it can only be shown in Finder). */
  url: string | null
}
// ── End of preview ───────────────────────────────────────────────────────

/** Scope of the Changes panel. */
export type DiffScope =
  | { kind: 'turn'; sessionId: string; turnId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'uncommitted' }
  | { kind: 'commit'; sha: string }
  | { kind: 'range'; from: string; to: string; label: string }

export interface DiffResult {
  root: string
  from: string
  to: string
  files: FileChange[]
  /** The "after" side is the current state of the files: it changes while you work. */
  live: boolean
}

export interface FilePatch {
  path: string
  oldPath: string | null
  /** Unified git diff, with 3 lines of context. */
  patch: string
  oldText: string | null
  newText: string | null
  binary: boolean
  tooLarge: boolean
}

export interface HistoryEntry {
  id: string
  kind: 'turn' | 'commit' | 'restore'
  at: number
  title: string
  /** Session title or commit author. */
  detail: string | null
  sessionId: string | null
  turnId: string | null
  /** State that can be returned to with "Restore". */
  sha: string
  /** Changes at this point. */
  diff: { from: string; to: string } | null
  files: number | null
}

// ── Terminals and project configuration ──────────────────────────────────

export interface TerminalInfo {
  id: string
  projectId: string
  /** Session it belongs to: the terminal session itself, or the one an action was started from. */
  sessionId: string | null
  /**
   * shell: bottom panel; run: start or setup action; agent: CLI of a terminal session;
   * service: long-running worktree command (`[[worktree.services]]`), started by Ladder, with `title` = the service name.
   * It stops on its own (with everything it started) when the session is archived or the worktree is removed; after a restart
   * of Ladder it comes back as `stopped` and `terminal.restart` relaunches it. It does not keep the session alive for auto-archiving (it is always on) and does not count as an agent at work; other running terminals do.
   */
  kind: 'shell' | 'run' | 'agent' | 'service'
  title: string
  cwd: string
  command: string | null
  /** stopped: restored after a Ladder restart, the process is gone. */
  state: 'running' | 'exited' | 'stopped'
  exitCode: number | null
  createdAt: number
  /** LADDER_PORT passed to the process. For a service it is the free port assigned, from the worktree's block starting at base + 1 (null if it does not want one). */
  port: number | null
}

/** A long-running command to start together with the worktree, for example the dev server. */
export interface WorktreeService {
  /** Readable name: it is the terminal's title. Unique in the project; the same name in the personal file replaces the project's. */
  name: string
  /** Run by a login shell in the worktree folder. With `port` it can use $LADDER_PORT. Empty in the personal file = service removed. */
  command: string
  /** `port` in the TOML, default true: assigns the service a free LADDER_PORT from the worktree's block, from base + 1 (the base stays with setup, shell and [[run]]), different across worktrees and services. */
  port: boolean
  /**
   * Which file it comes from. project: only `.ladder/settings.toml`; personal: only `settings.local.toml`; both: defined in the project and
   * redefined (or disabled) in the personal file, which wins. With `both` the fields above are the personal ones, unless `disabled`.
   */
  source: 'project' | 'personal' | 'both'
  /**
   * true: the personal file has the same name with an empty `command`, so the project's service is disabled. It stays in the list
   * (with the project's command and port) but the host does not start it. To re-enable it, just remove the empty entry from `personalServices`.
   */
  disabled: boolean
  /** The command in the project file, present only with `source: 'both'`: it is the one that would take effect again if the service were restored. */
  projectCommand?: string
}

export interface RunAction {
  name: string
  command: string
  default: boolean
  concurrent: boolean
}

/** A preferred delegate of the project. */
export interface AgentDelegate {
  /** Short name: "reviewer", "researcher". */
  name: string
  agent: AgentId
  model: string | null
  effort: Effort | null
  /** Maximum permission of the delegate (never higher than the delegating session anyway). Default 'plan'. */
  permission: PermissionLevel
  /** What it is for, in words: "Reviews and second opinions". */
  note: string
}

export interface ProjectSettings {
  /**
   * setup: script run when the worktree is created, in a "setup" terminal of the session (LADDER_PORT set).
   * setupWait (`setup_wait`, default true): the first message starts when the script is done; false: it starts right away, the script runs in parallel.
   * archive: cleanup script, run when the session with the worktree is archived and before Ladder removes the worktree (also with archiveMerged). copy: extra paths to copy
   * compared with `.worktreeinclude` (see `project.worktreeFiles`).
   * ports: how many consecutive ports (from LADDER_PORT, the base) a worktree has; the base stays with setup, shell and [[run]], services with `port` use the others in order
   * (from base + 1, so `ports - 1` services with a port): with `ports` = 1 and services with an active port, `errors` reports it and those services do not start (at least 2 are needed). The slot of a removed worktree is freed and reused.
   * services (`[[worktree.services]]`): long-running commands that the host starts in one `service` terminal per service, when the
   * worktree is created after the setup script (with setupWait false the script runs in parallel with the session, but the services still start once setup is done;
   * if setup exits with an error they do not start, and the session receives a note). They stop before the cleanup script (`archive`).
   * The two TOML files merge by service name: `services` is the already merged list (project, then the personal-only ones), with the
   * disabled services included (`disabled`), which the host does not start. In the same file a repeated name: the last one wins.
   * personalServices: the current content of `[[worktree.services]]` in the personal file, as is (including entries with an empty `command`,
   * which disable the project's service of the same name). It is the list that `WorktreeSettingsPatch.services` replaces entirely: the UI
   * edits it (add/edit/remove/disable = empty entry/re-enable = remove the entry) and sends it back in full.
   * Invalid entries in the personal file (missing name or command, non-boolean port, extra keys) do not appear in `personalServices` and are
   * reported in `errors`; saving `services` with such entries to the file is REJECTED with an error saying which entry and why (so they are not silently deleted).
   */
  worktree: {
    setup: string | null
    setupWait: boolean
    copy: string[]
    ports: number
    archive: string | null
    services: WorktreeService[]
    personalServices: { name: string; command: string; port: boolean }[]
  }
  run: RunAction[]
  prompts: Record<string, string>
  /** [agents]: allowed agents (empty = all), proposed agent, maximum permission level. */
  agents: {
    allowed: string[]
    default: string | null
    permissionsMax: PermissionLevel | null
    /**
     * `[[agents.delegates]]`: the project's preferred delegates, given to the coordinator as context (list_agents and system
     * prompt); it decides when and to whom to delegate. name unique; agent allowed; permission capped by permissionsMax.
     * The two TOML files merge by name like services (personal wins); invalid entries in `errors`.
     */
    delegates: AgentDelegate[]
    /** Agent to switch to on its own when the session's agent reaches the plan limit; null = proposal only. */
    autoSwitch: AgentId | null
    /** Agent that reviews the diff at the end of a turn with changes (read-only, different provider); null = off. */
    crossReview: AgentId | null
  }
  /** Files read, relative to the project root. */
  sources: string[]
  errors: string[]
}

/** Only the fields present change. `setup` and `archive` null or empty = no script. */
export interface WorktreeSettingsPatch {
  setup?: string | null
  archive?: string | null
  setupWait?: boolean
  copy?: string[]
  /**
   * REPLACES the whole `[[worktree.services]]` list of the personal file: the UI must send the complete personal list
   * (starting from `worktree.personalServices`), otherwise the omitted entries are lost. `port` absent = true. To disable a project
   * service: same name and empty `command`; to re-enable it, omit the entry. Empty name: the save is rejected (error);
   * repeated name: the last entry wins, in the position of the first.
   */
  services?: { name: string; command: string; port?: boolean }[]
}

/**
 * What is copied from the main checkout into a new worktree. `.worktreeinclude` in the project root has
 * .gitignore syntax (as in Claude Code) and lists the files to copy; only those ignored by git count
 * (tracked ones are already there). Without the file `.env*` applies. `files` are paths relative to the root, `node_modules` excluded.
 */
export interface WorktreeFiles {
  source: 'file' | 'default'
  patterns: string[]
  files: string[]
}

/** The host's SQLite store. */
export interface DataInfo {
  /** Ladder's data folder (database, settings, shortcuts). */
  dir: string
  dbPath: string
  dbBytes: number
  /** Copies in the data `backups` folder, most recent first. */
  backups: { path: string; bytes: number; at: number }[]
}

// ── Review with another agent ────────────────────────────────────────────

export interface ReviewNote {
  path: string
  line: number
  body: string
}

export interface ReviewState {
  id: string
  sessionId: string
  agent: AgentId
  agentName: string
  /** Scope reviewed, to link comments to the right diff. */
  scope: DiffScope
  state: 'running' | 'done' | 'error' | 'cancelled'
  summary: string | null
  comments: ReviewNote[]
  error: string | null
  startedAt: number
}

// ── Search, issues and merge ─────────────────────────────────────────────

export interface SearchHit {
  sessionId: string
  itemId: string
  /** Text around the match. */
  snippet: string
  kind: 'message' | 'reply' | 'command' | 'file'
  at: number
}

/** Item to create a session from: GitHub issue or PR, Linear issue, branch. */
export interface IssueItem {
  source: SessionSource['kind']
  /** Issue or PR number, Linear identifier or branch name. */
  ref: string
  title: string
  body: string | null
  url: string | null
  /** Branch to use: the PR's, the one suggested by Linear, the chosen branch. */
  branch: string | null
  state: string | null
  updatedAt: number | null
}

export interface IssueList {
  items: IssueItem[]
  /** Why the list is empty or partial: gh missing, no GitHub remote, Linear key absent. */
  problem: string | null
}

export interface MergeCheck {
  name: string
  state: 'pending' | 'passing' | 'failing' | 'skipped'
  url: string | null
}

export interface ReviewComment {
  author: string
  path: string | null
  line: number | null
  body: string
  url: string | null
  at: number
}

export interface MergeInfo {
  root: string
  branch: string | null
  /** Target branch: the PR's or the repository default. */
  base: string | null
  isDefaultBranch: boolean
  /** Modified, uncommitted files. */
  dirty: number
  /** Commits of the branch that the base does not have. */
  ahead: number
  behind: number
  /** Commits not yet published to the remote; null if the branch has no upstream. */
  unpushed: number | null
  hasUpstream: boolean
  /** Files in conflict if you merge the base, computed without touching the folder. */
  conflicts: string[]
  gh: 'ok' | 'missing' | 'unauthenticated' | 'no-remote' | 'error'
  ghError: string | null
  pr: PrStatus | null
  checks: MergeCheck[]
  comments: ReviewComment[]
  // ── Sync and publish state ──
  /** Upstream commits to pull (the ↓ in the header, like GitStatus.behind); 0 without upstream. */
  behindUpstream: number
  /** Lines added/removed by uncommitted changes (like GitStatus.added/removed). */
  added: number
  removed: number
  /** The repository has at least one git remote (without one, no Push or Publish). */
  hasRemote: boolean
  /** Upstream of the branch, for example "origin/feat" (like GitStatus.upstream); null if unpublished or detached HEAD. */
  upstream: string | null
  /** Head commit of the PR (GitHub `headRefOid`, full sha) as the host read it just now; null without a PR. It is what the user sees: `pr.merge` wants it back in `expectedHeadOid`. */
  prHeadOid?: string | null
  /** GitHub `mergeStateStatus` (CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, HAS_HOOKS, DRAFT, UNKNOWN…); null without a PR. */
  mergeState: string | null
  /** A session is working in the folder: Push, Merge and Archive wait. */
  agentBusy: boolean
  /** Why the PR cannot be merged now (empty = mergeable or no open PR). */
  blocks: MergeBlock[]
  /** Next step and whether it is enabled: computed in a single place on the host, same logic as the header chip. */
  nextAction: NextAction
  // ── end of sync and publish state ──
}

// ── Connections: GitHub, Claude Code and Codex ───────────────────────────────

/** Services Ladder can connect on its own: browser login, without going through the Terminal. */
export type ConnectionId = 'github' | 'claude-code' | 'codex'

/**
 * - missing: the tool (gh, Codex CLI) is not there; `connection.login` downloads it and then logs in.
 * - unauthenticated: the tool is there but not connected to an account.
 * - connected: connected; `user`, `plan` and `email` say who.
 * - error: the state could not be read (`error` says why).
 */
export type ConnectionState = 'missing' | 'unauthenticated' | 'connected' | 'error'

/** Stage of a connection in progress, in the order they occur. */
export type ConnectionStage = 'downloading' | 'verifying' | 'installing' | 'waiting-browser' | 'finishing'

/** A login (with the tool download, if any) in progress. Present in ConnectionStatus while it lasts. */
export interface ConnectionLogin {
  stage: ConnectionStage
  /** From 0 to 1, only in `downloading`; null when the size is unknown. */
  progress: number | null
  /** Bytes downloaded and total, in `downloading`: the UI shows them ("120 MB of 350 MB"). */
  bytes: number | null
  total: number | null
  /** Page opened in the browser for the login (in `waiting-browser`): "Reopen" and "Copy link" if it did not open. */
  url: string | null
  /** One-time code to type into the page: GitHub only (`gh auth login --web`). */
  code: string | null
}

export interface ConnectionStatus {
  id: ConnectionId
  /** Profile this state belongs to (claude-code and codex only); absent = default. */
  profileId?: string
  state: ConnectionState
  /** Where the tool comes from: installed by the user (`system`), included in Ladder (`bundled`, Claude Code only) or downloaded by Ladder (`downloaded`). */
  source: 'system' | 'bundled' | 'downloaded' | null
  version: string | null
  /** GitHub username; null for Claude Code and Codex. */
  user: string | null
  /** Subscription plan: "Max", "Pro", "Plus"; null for GitHub or if the account does not say. */
  plan: string | null
  email: string | null
  /** Login or download in progress; null otherwise. */
  login: ConnectionLogin | null
  /** Error of the last attempt (failed login, download with a wrong checksum, cancelled…), already translated. */
  error: string | null
}

/** Draft key: the session id, or `new:<projectId>` for the new chat. */
export type DraftKey = string

export type HostCommand =
  | { type: 'hello' }
  | { type: 'project.add'; path: string }
  | { type: 'project.remove'; projectId: string }
  | {
      type: 'session.create'
      projectId: string
      agent: AgentId
      text: string
      model: string | null
      effort: Effort | null
      permission: PermissionLevel
      /** Profile (account) to start with; absent = the project's, then the default. */
      profileId?: string | null
      attachments?: Attachment[]
      /** Terminal session: command to start in place of the chat. */
      mode?: SessionMode
      command?: string
      /** Works in a new worktree instead of the main checkout. */
      worktree?: boolean
      /** With the project's setup script: true waits for it to finish before the first message, false starts right away. Absent = ProjectSettings.worktree.setupWait. */
      setupWait?: boolean
      /** Worktree branch: new (from HEAD) or an existing one to check out (PR, chosen branch). */
      branch?: { name: string; existing: boolean; pr?: number } | null
      /** Only with `worktree` and without `branch`: local branch the worktree starts from (default: the main checkout's current one). Unknown: error. */
      baseBranch?: string | null
      /** Only with `worktree` and without `branch`: chosen name for the new branch, used as is (no prefix added). Empty or absent: generated name. Invalid or already existing: error. */
      newBranch?: string | null
      source?: SessionSource | null
      title?: string
    }
  /** Stopped terminal session (after a restart or an exit): restarts the CLI, resuming the conversation if it can. */
  | { type: 'session.resume'; sessionId: string }
  /**
   * With the session at work: busy 'queue' (default) queues for the end of the turn,
   * 'steer' inserts into the turn if canSteer, otherwise queues. When idle busy does not matter.
   */
  /** "Continue" after agents-finished: sends the coordinator the fixed resume text (in the host's language) as a user message. */
  | { type: 'session.continue'; sessionId: string; itemId: string }
  | { type: 'session.send'; sessionId: string; text: string; attachments?: Attachment[]; busy?: 'queue' | 'steer' }
  /** Current list of the session's / commands; data: SlashCommand[] (empty if not yet known). */
  | { type: 'session.commands'; sessionId: string }
  /**
   * Runs an agent command. The host adds a 'command' row (never 'user')
   * and routes it: Claude and ACP as the prompt "/name args", Codex to thread/compact/start
   * or review/start (empty args: uncommittedChanges; otherwise custom instructions).
   * Rejected with an error if the session is working or the command is unknown.
   */
  | { type: 'session.command'; sessionId: string; name: string; args: string }
  /**
   * "Switch to…": hands the session's work (chat only, idle, different agent from its own) to `agent`.
   * 1. In the session opens a turn with the HandoffItem 'out' row (state 'summarizing') and asks the current agent for the
   *    summary with the `handoff` prompt (project [prompts]).
   * 2. At the end of the turn: summary = last assistant text; checkpoint = the end-of-turn one; files = session
   *    changes since its first checkpoint.
   * 3. Destination session: if the session was born from a handoff (handoffFrom) and the origin already has `agent`, is not
   *    archived and is idle, it goes back there; otherwise a new one is created in the same project and folder
   *    (same worktree, no new worktree), with handoffFrom, same permission level (capped by [agents]),
   *    `model`/`effort` given or the defaults, project profile. There a turn starts that opens with the 'in' row and sends
   *    the agent the `handoff_receive` prompt (summary, note, files, checkpoint, branch).
   * 4. The 'out' row goes to 'done' with peerSessionId.
   * Must be sent with rid: it answers right after the summary turn starts (data: null), not when the handoff is finished.
   * Translated error, without touching the session, if: terminal session, working or archived; `agent` same as the
   * session's, unknown, unavailable or not allowed by the project ([agents] allowed).
   */
  | { type: 'session.handoff'; sessionId: string; agent: AgentId; model?: string | null; effort?: Effort | null; note?: string | null }
  /**
   * /advisor and /committee: asks for read-only advice from one (advisor) or several agents (committee, 2-4, all
   * different). Adds an AdviceItem row and, for each agent, a child session (parent.role 'advisor', permission
   * 'plan', same folder, no worktree) to which it sends the `advisor` prompt ([prompts]): question, session title and
   * branch, the latest conversation exchanges (cut, as data), the invitation to read `git diff` and the files without
   * changing them. The session's own agent and agents not yet used are allowed; not allowed by the project → error.
   * Also valid while the session is working. Must be sent with rid; data: id of the AdviceItem row.
   */
  | { type: 'session.advise'; sessionId: string; agents: { agent: AgentId; model?: string | null; effort?: Effort | null }[]; question: string }
  /** Stops the card's entries still 'running' (interrupts the child sessions): they become 'stopped'. */
  | { type: 'session.advice.stop'; sessionId: string; itemId: string }
  /**
   * Sends the card's 'done' advice to the session's agent as a user message (`advice_forward` prompt,
   * advice as data), with the same rules as session.send (queued if working). forwarded becomes true.
   */
  | { type: 'session.advice.forward'; sessionId: string; itemId: string; note?: string | null }
  /**
   * Stops a handoff in 'pending' (cancelled before the turn ends) or 'summarizing' (interrupts the summary
   * turn): the 'out' row becomes 'interrupted' with resumable true.
   */
  | { type: 'session.handoff.stop'; sessionId: string; itemId: string }
  /**
   * Resumes a resumable 'out' row. An `agent` different from the row's = reassign (same rules as
   * session.handoff). With the summary already saved it delivers right away; otherwise it reopens the summary turn. Must be sent with rid.
   */
  | { type: 'session.handoff.resume'; sessionId: string; itemId: string; agent?: AgentId; model?: string | null; effort?: Effort | null }
  /**
   * Resumes an interrupted delegation (restart, stop): the parent's tool row has a ResumeItem next to it. Restarts the child's
   * turn with a resume message and, at the end of the turn, sends the result to the coordinator as a user message
   * (session.send rules). `dismiss` closes the card without doing anything.
   */
  | { type: 'session.delegation.resume'; sessionId: string; itemId: string; action: 'resume' | 'dismiss' }
  /**
   * Answers a LimitItem. 'switch' hands off to `agent` (or the proposed one) with reason 'limit'; 'return' (in the
   * session reached after the reset) goes back to the previous agent with a normal handoff; 'dismiss' closes the card.
   */
  | { type: 'session.limit.respond'; sessionId: string; itemId: string; action: 'switch' | 'return' | 'dismiss'; agent?: AgentId }
  /**
   * Personal project switches, written in .ladder/settings.local.toml ([agents] auto_switch and
   * cross_review). null turns off. Answers with the updated ProjectSettings.
   */
  | { type: 'project.agents.set'; projectId: string; patch: { autoSwitch?: AgentId | null; crossReview?: AgentId | null } }
  /**
   * "Implement with…": hands over a plan (markdown) with line comments.
   * - `agent` same as the session's: if permission is 'plan' it moves to `permission` (default 'edit', capped
   *   by [agents]) like session.permission.set, then sends the `implement` prompt (plan and comments as data) in the session,
   *   with the session.send rules.
   * - other agent: like session.handoff but without a summary turn: HandoffItem 'out' row with reason 'implement' already
   *   'done', linked session (same arrival and return rules) that starts with the 'in' row reason 'implement' and the
   *   `implement` prompt; permission `permission` (default 'edit') capped by [agents].
   * Must be sent with rid; data: id of the implementing session. Errors as session.handoff (except "same agent").
   */
  | {
      type: 'session.implement'
      sessionId: string
      plan: string
      /** 1-based plan line and comment text. */
      comments: { line: number; text: string }[]
      agent: AgentId
      model?: string | null
      effort?: Effort | null
      permission?: PermissionLevel
    }
  /** Manual rename: the title becomes 'user' and no automatic generation overwrites it. */
  | { type: 'session.rename'; sessionId: string; title: string }
  /**
   * Regenerates the title with a small model, even if it had been renamed by hand (explicit action:
   * the source goes back to 'generated'). Answers when it finishes; data: the new title. Translated error if
   * the agent does not support it, there is no conversation yet, a title is already in progress or the model does not answer.
   * The new title also arrives with session.upsert.
   */
  | { type: 'session.title.regenerate'; sessionId: string }
  | { type: 'session.unread'; sessionId: string }
  /** Project files, relative paths: tracked and untracked, not ignored. */
  | { type: 'project.files'; projectId: string }
  | { type: 'session.queue.set'; sessionId: string; queue: QueuedMessage[] }
  /** data: SubagentDetail. id is SubagentInfo.id or the id of the 'tool' row. */
  | { type: 'subagent.detail'; sessionId: string; id: string }
  /** data: SubagentInfo[] of the session (on open or after a reconnection). */
  | { type: 'subagent.list'; sessionId: string }
  /**
   * Queued message to deliver now. 'steer': enters the running turn without
   * interrupting it (only if canSteer; otherwise error). With the session idle, both
   * modes start the message like a normal send. 'now': interrupts the turn and
   * starts this message right away, ahead of the rest of the queue. The message leaves the
   * queue; the 'user' row is born when it reaches the agent (with steered: true if inserted).
   */
  | { type: 'session.queue.deliver'; sessionId: string; id: string; how: 'steer' | 'now' }
  | { type: 'session.interrupt'; sessionId: string }
  /** `viaDevice`: phone name, set by the remote gateway together with `via: 'phone'` (what the phone sends is ignored). */
  | { type: 'session.respond'; sessionId: string; requestId: string; response: RequestResponse; via?: ResponseVia; viaDevice?: string }
  /**
   * Must be sent with rid (request): data = { permission, appliesFrom: 'now' | 'next-turn' }.
   * The host updates the row only if the agent accepts; if it refuses it answers with an error and the
   * level stays as before. With 'now' the open permission requests that the new
   * level allows are approved automatically (full: all except questions; edit: the edit
   * tools); 'next-turn' when the agent cannot change it mid-turn (Codex).
   */
  | { type: 'session.permission.set'; sessionId: string; permission: PermissionLevel }
  | { type: 'session.model.set'; sessionId: string; model: string }
  | { type: 'session.effort.set'; sessionId: string; effort: Effort }
  | { type: 'session.open'; sessionId: string }
  | { type: 'session.read'; sessionId: string }
  | { type: 'session.archive'; sessionId: string }
  /**
   * Closes the session's agent process: the next message resumes the same conversation with a new process,
   * which rereads settings and MCP servers. With a turn or sub-agents at work the restart waits for them to finish.
   */
  | { type: 'session.restartAgent'; sessionId: string }
  | { type: 'draft.set'; key: DraftKey; text: string }
  | { type: 'ui.set'; projectId: string; state: ProjectUiState }
  // ── Agent browser ──
  /** Stop the agent's browser: halts the current action, rejects later calls and revokes the tools until `resume` or a new user turn. Answers with the state. */
  | { type: 'browser.agent.stop'; sessionId: string }
  /** Re-enables the tools after a stop. Answers with the state. */
  | { type: 'browser.agent.resume'; sessionId: string }
  /** State of the agent's browser: of one session, or of all those that have one (when a window opens). Answers with AgentBrowserState[]. */
  | { type: 'browser.agent.state'; sessionId?: string }
  // ── End agent browser ──
  // Project groups in the sidebar. Every command answers ProjectGroupsState (the same one that arrives in the
  // `projectGroups.changed` event, to all windows). Unknown id or project: error, no change.
  /** New section at the bottom; the name is trimmed of spaces, empty = error. Answers the state (the id is the last section). */
  | { type: 'projectGroups.create'; name: string; projectIds?: string[] }
  | { type: 'projectGroups.rename'; groupId: string; name: string }
  /** Deletes the section: its projects go back to the end of `ungrouped`, in their order. */
  | { type: 'projectGroups.delete'; groupId: string }
  | { type: 'projectGroups.collapse'; groupId: string; collapsed: boolean }
  /** New order of the sections: `groupIds` must list them all; omitted ones stay at the end, unknown ids are discarded. */
  | { type: 'projectGroups.reorder'; groupIds: string[] }
  /** Moves a project into a section (`groupId`) or out of every section (null), at position `index` (default: the end). Also used to reorder. */
  | { type: 'projectGroups.move'; projectId: string; groupId: string | null; index?: number }
  // Shortcuts. All answer ShortcutsState; the `shortcuts.changed` event also arrives on every change.
  /** Current state (rereads the file). */
  | { type: 'shortcuts.get' }
  /**
   * Saves the preset and customizations: writes `overrides` to keybindings.json atomically. The entries the host
   * had ignored (unknown or invalid) stay in the file, ahead of the new ones. Invalid entries in `overrides`
   * or a file with a syntax error: error, no change (the preset too).
   */
  | { type: 'shortcuts.save'; preset: ShortcutPreset; overrides: Keybinding[] }
  /** Removes all customizations (the file becomes `[]`; the old content goes to keybindings.json.bak). The preset does not change. */
  | { type: 'shortcuts.reset' }
  /** Opens keybindings.json in the system app for .json files (creates it empty if missing). Answers null. */
  | { type: 'shortcuts.openFile' }
  // Files, diff and history. `root` is the folder of a project or of a session (worktree).
  | { type: 'fs.tree'; root: string }
  | { type: 'fs.read'; root: string; path: string }
  /** `baseMtime` null: writes anyway. Otherwise, if the file changed, it does not write and sends back the text on disk. */
  | { type: 'fs.write'; root: string; path: string; text: string; baseMtime: number | null }
  | { type: 'fs.watch'; root: string; on: boolean }
  // ── Media preview ──
  /** Describes a non-text file of the root, or its version at revision `rev` (HEAD or full git sha). Answers FileMedia. */
  | { type: 'fs.media'; root: string; path: string; rev?: string | null }
  /** Shows the file in Finder: only inside the root. Answers null. */
  | { type: 'fs.reveal'; root: string; path: string }
  // ── End of media preview ──
  | { type: 'diff.files'; root: string; scope: DiffScope }
  | { type: 'diff.file'; root: string; from: string; to: string; path: string; oldPath?: string | null }
  /** Brings the files back to the state of `to`. Returns the checkpoint to undo. */
  | { type: 'git.restore'; root: string; to: string; paths?: string[]; label: string }
  | { type: 'history.list'; root: string; sessionId?: string | null }
  // Terminals.
  | { type: 'terminal.create'; projectId: string; sessionId?: string | null; cwd?: string }
  | { type: 'terminal.attach'; id: string; cols: number; rows: number }
  | { type: 'terminal.input'; id: string; data: string }
  | { type: 'terminal.resize'; id: string; cols: number; rows: number }
  | { type: 'terminal.close'; id: string }
  | { type: 'terminal.restart'; id: string }
  /** Clears the host's copy of the screen (screen and scrollback, the cursor line stays): writes nothing to the shell. Nonexistent terminal: ignored. */
  | { type: 'terminal.clear'; id: string }
  /** Last lines of the terminal as plain text, for @terminal. */
  | { type: 'terminal.output'; id: string; lines?: number }
  // Project configuration (.ladder/settings.toml) and start actions.
  | { type: 'project.settings'; projectId: string }
  | { type: 'run.start'; projectId: string; sessionId?: string | null; name: string }
  /**
   * Saves the project's setup, cleanup, wait and copies in `.ladder/settings.local.toml` (personal, outside git; the file
   * is rewritten, so its comments are lost). Wins over the project file field by field. Answers ProjectSettings.
   */
  | { type: 'project.worktree.set'; projectId: string; patch: WorktreeSettingsPatch }
  /** Preview of what a new worktree would copy. Answers WorktreeFiles. */
  | { type: 'project.worktreeFiles'; projectId: string }
  // Data. There is a single database, in the app's data folder.
  /** Answers DataInfo. */
  | { type: 'data.info' }
  /**
   * Consistent copy of the database (VACUUM INTO, even with sessions at work). Without `to`: new file `ladder-YYYYMMDD-HHMMSS.db`
   * in `backups` in the data folder; with `to` (absolute path chosen with `ladder:pick-save-path`) it writes there and replaces
   * an existing file. Answers { path, bytes }. There is no restore.
   */
  | { type: 'data.backup'; to?: string }
  /** Opens the data folder in Finder (done by main). Answers null. */
  | { type: 'data.openFolder' }
  // Search in conversations (⌘K), issues and PRs for new sessions, merge panel and button prompts.
  | { type: 'search'; query: string }
  | { type: 'issues.list'; projectId: string; source: 'github-issue' | 'github-pr' | 'branch' }
  | { type: 'merge.info'; root: string; fetch?: boolean }
  /** Prompt text behind a button (create_pr, fix, conflicts, review, issue), with the variables already substituted. */
  | { type: 'prompt.render'; projectId: string; name: string; vars: Record<string, string> }
  // ACP agents: registry catalog, adding and removing.
  /**
   * Adds an agent to the "Your agents" catalog. For a detected CLI: `agents.add` with `source: 'registry'` and
   * the id; the host uses the path found (distribution `path`), otherwise the downloaded binary, otherwise npx/uvx.
   * Answers AgentStatus.
   */
  | { type: 'agents.add'; spec: AcpAgentSpec }
  /**
   * Full catalog: answers AgentCatalogEntry[] with the curated ones on top, in the order Gemini CLI, Cursor,
   * GitHub Copilot, OpenCode, Amp, goose, Cline, Qwen Code, Kiro CLI, Junie, Factory Droid, then the rest of the registry
   * by name. Includes detection, state and login: it runs the login shell once per CLI, so the UI
   * requests it when Settings → Agents opens and on first run, not on every render. If the registry does not answer: error.
   */
  | { type: 'agents.catalog' }
  /**
   * Looks in the login shell's PATH for the curated agents' CLIs (without starting them or writing anything) and answers
   * AgentCatalogEntry[] only for those found. Lighter than `agents.catalog`: for first run ("we found…").
   */
  | { type: 'agents.detect' }
  /**
   * Downloads and installs an agent's binary into `<data>/bin/<id>` (also to update it). Requires the user's
   * explicit confirmation: `confirmed` must be true and `version`, `sha256` and `host` those the UI showed in the dialog
   * (AgentCatalogEntry.registryVersion, download.sha256, download.host): ALL three are mandatory and the host always compares them
   * with the ones it would use now (the checksum from the registry or the release, freshly reread); if one differs it rejects and the UI
   * rereads the catalog. A `sha256` that is not 64 hex digits or an empty `host` is rejected. It also rejects if there is no
   * verifiable checksum, if a binary has arguments that a runtime executes as code (`-XX:`, `-javaagent`, `-agentlib`, `-Djava.`, `--add-opens`, `@file`…: the entry is `unavailable`), if the archive's host is not the expected one (`host`), if the same version was already downloaded with
   * a different checksum (`checksum-conflict`, rejected like the other blocks: the promise is rejected, the code arrives with the `agent.install` event, there is no `running` answer).
   * A second request for the same version during the download receives the state of that download (a single download) only if `sha256`
   * and `host` match those of the download in progress; if they differ it rejects with `checksum-changed` (its confirmation is not silently
   * ignored) WITHOUT an `agent.install` event: the state of the job in progress does not change (an error event for the same id would show it
   * as failed while it is downloading), so here the code does not reach the UI, only the rejection text; the UI rereads the catalog.
   * Reading the checksum of a GitHub release takes at most 15 seconds (then error "can't read the checksum right now").
   * If writing the recorded checksum fails after the agent is registered, the install stays successful (`done`). For another version of the same agent it is an error ("another installation is in progress").
   * Answers AgentInstall (state running) and continues in the
   * background: each step arrives as an `agent.install` event (errorCode for the security blocks, signature after the
   * verification). When the install ends the agent is added (agent.status). The binary is prepared in a temporary
   * folder and moved only after checksum, extraction and codesign; Ladder runs nothing before that. The version's checksum
   * is recorded (to notice a registry that changes it) only after a successful install.
   * Update: the new folder carries a `.ladder-version` marker (0644, written by Ladder) with the version and fingerprint of the recorded
   * entry; if the app closes halfway through the swap, on restart the folder kept is the one whose fingerprint matches the entry in the
   * database, otherwise the previous one returns. With `signature` the program inside an `.app` must be in Contents/MacOS, Helpers,
   * Frameworks (not runtime or jbr: they contain the JDK), be a Mach-O and satisfy the signer's requirement on its own (the package signature is not enough).
   */
  | { type: 'agents.install'; id: string; version: string; confirmed: true; sha256: string; host: string }
  /** Cancels an installation in progress: the final folder does not change. Answers null. */
  | { type: 'agents.install.cancel'; id: string }
  /**
   * List of "Other agents" in Subscription (OtherAgentConnection[]). Answers right away with what is known (programs
   * searched in the login shell's PATH, versions, last state) and for installed agents with `auth` unknown or probed more than
   * 10 minutes ago it starts a probe in the background (at most 2 at a time): each outcome arrives as an `agent.connection` event
   * (first with `probing: true`, then with the result). The probe starts the agent's program, runs `initialize` and `session/new` in
   * a neutral folder (the home) without sending prompts, with `NO_BROWSER=true` in the environment (the agent does not open the browser) and without
   * ANTHROPIC_*, CLAUDE* variables and API keys; then it stops it. It never reads credential files. No download or install.
   */
  | { type: 'agents.others' }
  /** Repeats an agent's probe and answers the updated OtherAgentConnection (also for an id without a row: error). Emits `agent.connection` and, if the probe gives ready/required, `agent.login`. */
  | { type: 'agents.others.refresh'; id: string }
  /**
   * Sign-in through the agent's CLI, in a Ladder terminal (with a TTY: the Gemini, Copilot, Cursor logins are interactive).
   * Like project actions (`run.start`): a `kind: 'run'` terminal of the project (`projectId`, otherwise the first open project; error if there is none),
   * titled "Sign in to <agent>", project folder, launched with the login shell; with `loginCommand` null it opens the bare CLI.
   * Answers TerminalInfo (the UI opens it by its id); a second `login` while one is running answers the same terminal.
   * When the process exits Ladder repeats the agent's probe and emits `agent.connection` (also on an exit with an error or closed by the user).
   * Error if the agent is not installed or is npx/uvx. The CLI opens the browser by itself: Ladder sees no credentials.
   */
  | { type: 'agents.others.login'; id: string; projectId?: string }
  /**
   * Sign-out through the CLI, the same way as `agents.others.login` (terminal, then a new probe and `agent.connection`), only if
   * `logoutCommand` is not null; otherwise error and the UI shows `logoutHelp`. Answers TerminalInfo.
   */
  | { type: 'agents.others.logout'; id: string; projectId?: string }
  /**
   * Sign-in to an ACP agent with one of its methods (AgentLogin.methods, `agent` type only): calls the ACP protocol's `authenticate`
   * and then opens a probe session to check the outcome. Ladder neither sees nor stores credentials:
   * the agent handles them (it often opens the browser). `projectId` gives the working folder (otherwise the home). It can
   * take up to 5 minutes. Answers the updated AgentLogin (ready if sign-in succeeded, required otherwise) and
   * emits `agent.login`. A `terminal` or `unsupported` method is rejected. Error if the agent is not added or the method does not exist.
   * If the agent dies or does not start the error arrives right away. A second request with the same `methodId` while sign-in is
   * in progress receives the same answer (a single process); with another method it is an error.
   */
  | { type: 'agents.authenticate'; id: string; methodId: string; projectId?: string }
  /**
   * Stops the sign-in in progress for that agent ("Stop waiting"): kills the agent's process and frees the id right away, so
   * a new `agents.authenticate` starts without "already in progress". The pending `agents.authenticate` request answers with the
   * AgentLogin as it was (no error and no event). Answers null; with no sign-in in progress it does nothing.
   */
  | { type: 'agents.authenticate.cancel'; id: string }
  | { type: 'agents.remove'; id: string }
  /** Rereads the plan's usage limits, without opening a session or consuming quota. */
  | { type: 'agents.usage'; agent: AgentId; profileId?: string }
  /**
   * Agent defaults for a project, read from the agent's config with the project
   * settings (Claude: .claude/settings*.json; Codex: config.toml and profile). data:
   * { model: string | null; effort: Effort | null; known: boolean } with model = an id from AgentStatus.models.
   * known false: the user configured something Ladder cannot resolve (no badge).
   * AgentStatus.models[].isDefault stays the user-level default.
   */
  | { type: 'agents.defaults'; agent: AgentId; projectId: string; profileId?: string }
  /**
   * Profiles. `profile.create` creates the configuration folder and answers the Profile; names are unique per
   * agent. `profile.rename` answers the Profile. `profile.remove` does not touch the default and rejects if an active
   * session uses it; idle sessions move to the default; the configuration folder is not deleted (it holds the credentials).
   * `project.profile` chooses a project's profile for an agent (profileId null = default): applies to new sessions,
   * existing ones keep theirs. Every change arrives as `profile.upsert`, `profile.removed` and `project.upsert`.
   */
  | { type: 'profile.create'; agent: ProfileAgent; name: string }
  | { type: 'profile.rename'; profileId: string; name: string }
  | { type: 'profile.remove'; profileId: string }
  | { type: 'project.profile'; projectId: string; agent: ProfileAgent; profileId: string | null }
  /**
   * Connections (GitHub, Claude Code, Codex). `connection.list` answers ConnectionStatus[] without starting anything.
   * `connection.refresh` rereads the state of one (answers ConnectionStatus). `connection.login` answers right away with the
   * state (login set) and continues in the background: each step arrives as a `connection.update` event; if the
   * tool is missing it downloads it (download with checksum), then opens the browser. `switchAccount`: signs out of the current
   * account first ("Switch account"): the logout happens before the new login, so if the user cancels the login they stay disconnected
   * (the UI says so in the "Switch account" confirmation). `connection.cancel` interrupts a download or login and leaves no errors. `connection.logout` signs out and
   * answers the state; two logouts in parallel share the same operation. If `claude auth status` does not answer, the state is `error`.
   * At the end of a successful login the host also rereads `agent.status` (account, models, limits) and the GitHub views
   * refresh on their own with a new `issues.list` and `merge.info` request.
   * `profileId` (claude-code and codex only) targets the profile; absent = default. `connection.list` answers one
   * per profile.
   */
  | { type: 'connection.list' }
  | { type: 'connection.refresh'; id: ConnectionId; profileId?: string }
  | { type: 'connection.login'; id: ConnectionId; switchAccount?: boolean; profileId?: string }
  | { type: 'connection.cancel'; id: ConnectionId; profileId?: string }
  | { type: 'connection.logout'; id: ConnectionId; profileId?: string }
  /** Read-only review of a session's changes, requested from another agent. Comes back as comments. */
  | { type: 'review.start'; sessionId: string; agent: AgentId; scope: DiffScope }
  | { type: 'review.cancel'; reviewId: string }
  // ── Text written by the small model (only on explicit request) ──
  /**
   * Proposes the commit message from the session folder's diff and the conversation. Answers GeneratedCommit.
   * `source` absent: the staged files if there are any, otherwise the whole working tree. Commits nothing.
   * Errors (translated text): generation off, agent without a small model, no changes, timeout (60 s).
   */
  | { type: 'text.commit'; sessionId: string; source?: 'staged' | 'working' }
  /**
   * Proposes the PR title and description from the branch's commits and diff against the base, and from the conversation.
   * Answers GeneratedPr. Does not create the PR. Errors as for text.commit, plus "no commits relative to the base".
   */
  | { type: 'text.pr'; sessionId: string }
  /** Cancels the commit/PR generation in progress for the session and frees it right away (the pending request fails with "cancelled"). Answers null. */
  | { type: 'text.cancel'; sessionId: string }
  // ── Commit ──
  /**
   * Commit made by Ladder in the session folder, with `git commit` (repo hooks included, no --no-verify,
   * no trailer, author from the git config). Message = `subject`, blank line, `body`: it is not rewritten.
   * If something is staged only that is committed; otherwise `paths` ('all' or a list of paths) is staged
   * with `git add -A` (respects .gitignore). Answers GitCommitResult and sends `fs.changed` (the panel refreshes).
   * Errors (translated text): empty subject, multi-line or over 200 characters; NUL bytes; "Nothing to commit."; hooks or git
   * failed (with their output).
   */
  | { type: 'git.commit'; sessionId: string; subject: string; body?: string; paths?: string[] | 'all' }
  /**
   * Prepares opening the PR: the host writes the title and description to private temporary files (0700 folder, 0600 files,
   * random names, deleted when the session closes, on a new preparation or on app exit) and answers
   * PrPrepared with the full `create_pr` prompt, which gives the agent only the PATHS: the title and description are never
   * pasted into a command. Errors (translated text): empty title, multi-line or over MAX_PR_TITLE characters;
   * description over MAX_PR_BODY; NUL bytes. Sends nothing to the session: the UI does that with `session.send`.
   */
  | { type: 'pr.prepare'; sessionId: string; projectId: string; branch: string; base: string; title: string; body: string }
  // ── Git status ──
  /**
   * Light git state of the session folder (the worktree if there is one) for the header. Answers GitStatus, or null if the
   * folder is not a git repository. Does not call gh: for the merge panel there is still `merge.info`.
   */
  | { type: 'git.status'; sessionId: string }
  /**
   * Subscribes (on) or unsubscribes (off) the UI to `git.status` updates of the session folder. Subscriptions are per
   * connection (window) and per session: a second `on` from the same window does nothing, one window's `off` does not remove
   * another's subscription, and closing a window removes all its subscriptions. While there is a subscriber the host watches the folder, rereads the state
   * on every change and runs a background `git fetch` (on open and every ~5 minutes, never while a turn is working there).
   * Answers null; an archived session or a removed project remove the subscriptions on their own.
   */
  | { type: 'git.watch'; sessionId: string; on: boolean }
  // ── end of git status ──
  // ── Branch map ──
  /**
   * Map of the project's branches: one row per session (worktree or not) with distance from main, merge state and last commit.
   * Answers BranchMap. Git reads only, on the main checkout (no gh, no writes), cached by sha: calling it often is cheap.
   * An unknown project is an error; a non-git project (or one whose folder is gone) answers an empty map with `base` null.
   */
  | { type: 'project.branchMap'; projectId: string }
  /**
   * Subscribes (on) or unsubscribes (off) the window to the project's `project.branchMap` events. Per connection and counted (two `on`
   * need two `off`); closing the window removes all its subscriptions. With no subscribers the host rereads nothing. Answers null.
   */
  | { type: 'project.branchMap.watch'; projectId: string; on: boolean }
  // ── end of branch map ──
  // ── Phones (from the window only: they are not in the remote channel's allowlist) ──
  /** State of the remote channel, devices included. Answers RemoteStatus. */
  | { type: 'remote.status' }
  /**
   * Creates the pairing QR: only one active code at a time (a new one replaces the previous), single use, 5 minutes
   * (REMOTE_PAIRING_TTL_MS), in memory only. Answers RemotePairStart. Translated error if "Access from your phone" is off.
   * When a phone pairs the `remote.paired` event arrives (the QR window can close) and `remote.status`.
   */
  | { type: 'remote.pair.start' }
  /** Cancels the active QR (the code stops being valid right away). Answers null. */
  | { type: 'remote.pair.cancel' }
  /**
   * Sets (or removes, with null) the password asked at pairing, in addition to the QR. From REMOTE_PASSWORD_MIN to REMOTE_PASSWORD_MAX
   * characters, translated error otherwise. Stored as a hash (scrypt) and checked only at pairing: devices already
   * paired are not touched. A QR already shown stays valid but, if the password was set afterwards, it asks for it anyway.
   * Answers null.
   */
  | { type: 'remote.password.set'; password: string | null }
  /**
   * Revokes a device: closes its connections right away (the phone receives RemoteAuthResult with 'device-revoked') and with the
   * same pairing it cannot reconnect; to come back it must pair again with a new QR. Answers null.
   */
  | { type: 'remote.device.revoke'; deviceId: string }
  /** Renames a device (1–80 characters). Answers null. */
  | { type: 'remote.device.rename'; deviceId: string; name: string }
  /**
   * Regenerates the Mac's key: new X25519 identity and new relay key (so a new id on the relay), cancels the QR,
   * revokes ALL devices and closes all connections. Phones paired before can no longer connect.
   * The relay reconnects with the new key. Answers null.
   */
  | { type: 'remote.key.regenerate' }
  /** Log of remote actions, most recent first. `before`: exclusive id to start from; `limit` default 50, maximum 200. Answers RemoteLogPage. */
  | { type: 'remote.log.list'; before?: number; limit?: number }
  // ── end of phones ──
  // ── Main checkout branch ──
  /** Local branches of the project (with the current one, the uncommitted files and the session working in the main checkout, if any). Answers ProjectBranches; a non-git project answers an empty list. */
  | { type: 'project.branches'; projectId: string }
  /**
   * Changes the main checkout's branch (`git switch --no-guess <branch>`, never a file checkout). Rejects, with a translated message, if:
   * a project session working in the main checkout (not in a worktree) has a turn or sub-agents running; the branch does not exist
   * locally; it is already checked out in a worktree; HEAD is in the middle of an operation git does not let you interrupt; git cannot carry the changes over.
   * `dirty` decides what to do with uncommitted changes (untracked too): 'carry' (default) tries the normal switch, which carries them along if git allows it;
   * 'stash' first runs `git stash push -u -m "ladder: before switching to <branch>"`, never a silent stash. If the switch fails after the stash, the stash is restored.
   * Answers BranchSwitchResult and sends `fs.changed` and `project.upsert`, as for a change made elsewhere.
   */
  | { type: 'project.branch.switch'; projectId: string; branch: string; dirty?: 'carry' | 'stash' }
  /** Creates a branch from the current commit and checks it out (`git switch -c`): uncommitted changes stay where they are. Same protections as `project.branch.switch`; the name is validated as for push and must not already exist. */
  | { type: 'project.branch.create'; projectId: string; name: string }
  // ── end of main checkout branch ──
  // ── Push and merge ──
  /**
   * Light push preview (local git only, no network): what would be sent, to show in the confirmation. Answers
   * GitPushPreview. `remote` is needed only when the branch has no upstream and the repo has several remotes (see `problem`).
   * Destination: the push ALWAYS goes to a branch with the same name as the local one (`target`, for example "origin/feat"), never to a
   * branch with a different name. If the upstream points to another branch (`git switch -c feat origin/main`) or to another remote from
   * `branch.<b>.pushRemote`/`remote.pushDefault`, the upstream is NOT the destination: the preview says `willPublish: true` and
   * `upstreamElsewhere` reports the current upstream (which becomes `target` after the push). Remote chosen: requested `remote`, then
   * `branch.<b>.pushRemote`, `remote.pushDefault`, the upstream's remote, the only remote.
   * Errors (translated text): detached HEAD; folder not a git repo; `remote` that is not among the repo's or differs from the
   * upstream's; session without a folder (project removed).
   */
  | { type: 'git.push.preview'; sessionId: string; remote?: string }
  /**
   * Push done by Ladder with git, ONLY on the user's explicit action (the UI always asks for confirmation with the branch and the number of commits
   * from the preview): never at the agent's request. Branch with upstream: sends to the upstream's branch; without upstream or with
   * `publish: true`: `git push -u <remote> <branch>`. Never force. Answers GitPushResult, sends `fs.changed` and rereads the state
   * (`git.status` event). One operation at a time per repo; rejected (translated error) if the agent of that folder is
   * working. A rejected push changes nothing (not even the upstream config).
   * Translated errors: not fast-forward, missing or rejected credentials, unreachable remote, pre-push hook or remote that reject
   * (with the output, last 4000 characters), detached HEAD, no remote or several remotes without upstream, nothing to send, 3 minute timeout.
   * `expectedHead`: the full sha of HEAD shown in the preview (`GitPushPreview.head`); if HEAD differs the push is rejected
   * ("The branch changed after the preview: reopen the confirmation") and nothing starts. The UI always passes it.
   */
  | { type: 'git.push'; sessionId: string; publish?: boolean; remote?: string; expectedHead?: string }
  /**
   * Merge of the session branch's PR with `gh pr merge`, ONLY on the user's explicit action (confirmation with the chosen method).
   * Checks first, without calling merge if they fail: gh connected; PR open, not a draft, from the session's branch, without
   * conflicts, without MergeBlock blocks (CI running or failed, review required, branch not up to date). Never --admin or --auto;
   * `--match-head-commit` pins the checked commit. `deleteBranch` does NOT pass --delete-branch to gh: if true it deletes, after the successful
   * merge, only the PR's REMOTE branch (never the local one; skipped if the PR comes from a fork). Answers PrMergeResult
   * and updates PR/state (events `fs.changed`, `git.status`, `session.summary`).
   * Rejected (translated error): a PR from a fork (`isCrossRepository`) and a PR whose head does not match the branch's local upstream
   * (commits not yet published or a different branch). `expectedHeadOid`: the PR head sha the user saw in the dialog
   * (`MergeInfo.prHeadOid`); if the reread PR has a different oid the merge is rejected ("the PR changed: reopen the confirmation"); gh always
   * gets `--match-head-commit` with the verified oid. The UI always passes it.
   * If gh does not answer within 90 s the error says to recheck the PR's state (it may have been merged) and the state is reread.
   */
  | { type: 'pr.merge'; sessionId: string; number: number; method: PrMergeMethod; deleteBranch?: boolean; expectedHeadOid?: string }
  /**
   * "Archive" after the merge: closes the session and, if it is in a worktree no other session uses, removes it (like
   * automatic archiving on a merged PR: cleanup script included, the branch stays). Only if the PR is merged or the branch
   * is already in the base; never with uncommitted changes or commits that exist only here (translated error, nothing is touched).
   * Answers GitArchiveResult.
   */
  | { type: 'git.archive'; sessionId: string }
  // ── end of push and merge ──
  // ── end of commit ──
  // ── end of small-model text ──

  // ── Executable plans ──
  /** State of a plan. Answers PlanState; errors if it does not exist. */
  | { type: 'plan.get'; planId: string }
  /**
   * Edit from the card, only with status 'review': the whole plan is replaced, validated with validatePlan and the project rules.
   * `revision` is the one the UI saw: if the agent changed the plan in the meantime, a translated error ("The plan changed in the meantime…")
   * and nothing changes. Answers PlanState (revision + 1). Validation errors arrive translated, one per line.
   */
  | { type: 'plan.edit'; planId: string; revision: number; plan: Plan }
  /**
   * Approves and runs. `workspace`: where the tasks write, 'worktree' (a new plan worktree, the default with git) or 'main'
   * (main checkout). Revalidates with the current rules; `revision` as above. Answers PlanState with status 'running'.
   */
  | { type: 'plan.approve'; planId: string; revision: number; workspace: 'main' | 'worktree' }
  /** Rejects in review: status 'stopped'. With a non-empty `message`, sends it to the coordinator as a user message (for example "redo it without the review"). */
  | { type: 'plan.reject'; planId: string; message?: string }
  /**
   * Choice from the pause card (PlanPause.choices). continue: resumes after a stop point. retry: redoes the stopped
   * task (same session, new attempt, with a message summarizing what happened). reassign: like retry but with
   * `reassign` (agent, model, effort; validated against the rules) in a new session that also receives the partial work;
   * `keepWork` false restarts from the task-start checkpoint (the partial work stays saved as a patch). skip: skips the task
   * (it counts as 'skipped' for the following ones). stop: stops the plan. `taskId` absent = the one in PlanPause.
   */
  | { type: 'plan.choose'; planId: string; choice: PlanChoice; taskId?: string; reassign?: { agent: AgentId; model: string | null; effort: Effort | null; keepWork: boolean } }
  /** Confirms or rejects the agent's pending change (PlanState.pendingUpdate). The answer goes back to the agent on its next turn. */
  | { type: 'plan.confirmUpdate'; planId: string; accept: boolean }
  /** Stops the plan at any time: interrupts the turns of running tasks (does not archive their sessions). */
  | { type: 'plan.stop'; planId: string }
  /** Saved plan templates (global). Answers PlanTemplate[]. */
  | { type: 'plan.templates' }
  /** Saves the plan as a named template. Answers PlanTemplate. */
  | { type: 'plan.saveTemplate'; planId: string; name: string }
  | { type: 'plan.deleteTemplate'; templateId: string }
  /**
   * Uses a template in the session (chat, idle): creates a plan in 'review' with the given goal and adds the card to the chat.
   * Agents that are not allowed or exceed the project maximum: translated error. Answers PlanState.
   */
  | { type: 'plan.useTemplate'; sessionId: string; templateId: string; goal: string }
  // ── CLI and MCP tools for sessions ──
  /**
   * Waits for the session to finish its work: turn closed and queue empty, or stopped on a reply from you (approval,
   * question, plan to review), or `timeoutMs` (default 10 minutes, maximum 60). If the session is already idle it answers
   * right away with the outcome of the last turn. Answers SessionWaitResult.
   */
  | { type: 'session.wait'; sessionId: string; timeoutMs?: number }
  /**
   * Read-only for the CLI socket (`ladder attach`): the chat lines, only to the caller. Unlike
   * session.open it sends nothing to the windows and changes no state. Answers TranscriptMark[]: for each line only the
   * mark of how much it holds (`markOf` in cli/follow-mark.ts), not the content, which would be huge for a long session.
   */
  | { type: 'session.transcript'; sessionId: string }
  /** State of the `ladder` command in the terminal. Answers CliStatus. */
  | { type: 'cli.status' }
  /** Installs the `ladder` command (a symlink to the script inside the app). Answers CliStatus; translated error if it cannot be written. */
  | { type: 'cli.install' }
  /** Removes the link installed by Ladder (never a file that is not our link). Answers CliStatus. */
  | { type: 'cli.uninstall' }

export type HostEvent =
  | {
      type: 'snapshot'
      projects: Project[]
      sessions: SessionSummary[]
      drafts: Record<DraftKey, string>
      ui: Record<string, ProjectUiState>
      /** Project groups; absent in fixtures (= no sections). */
      projectGroups?: ProjectGroupsState
      agents: AgentStatus[]
      /** Claude Code and Codex profiles, defaults included; absent in fixtures (= defaults only). */
      profiles?: Profile[]
      /** State of the connections at startup; absent in fixtures. */
      connections?: ConnectionStatus[]
      terminals: TerminalInfo[]
      /** Shortcuts at startup; absent in fixtures (= defaults). */
      shortcuts?: ShortcutsState
      /** Plans of non-archived sessions (including 'superseded' ones: their card is still in the chat); absent = none. */
      plans?: PlanState[]
    }
  | { type: 'project.upsert'; project: Project }
  | { type: 'project.removed'; projectId: string }
  /** Something changed in the project groups (also for an added or removed project): full state. */
  | { type: 'projectGroups.changed'; state: ProjectGroupsState }
  /** Sessions idle for `autoArchiveDays` days were archived (their `session.upsert` events arrive too). */
  | { type: 'sessions.autoArchived'; sessionIds: string[] }
  /** Shortcuts changed (file edited by hand, save, restore): full state. */
  | { type: 'shortcuts.changed'; state: ShortcutsState }
  | { type: 'session.upsert'; session: SessionSummary }
  /** A plan was created or changed (state, tasks, pause). Replaces the previous state with the same id. */
  | { type: 'plan.updated'; plan: PlanState }
  | { type: 'session.items'; sessionId: string; items: ChatItem[]; replace: boolean }
  /** Full list of the session's sub-agents, debounced; replaces the previous one. */
  | { type: 'session.subagents'; sessionId: string; subagents: SubagentInfo[] }
  /** The list of / commands changed (at session start or with commands_changed). */
  | { type: 'session.commands'; sessionId: string; commands: SlashCommand[] }
  | { type: 'agent.status'; status: AgentStatus }
  | { type: 'profile.upsert'; profile: Profile }
  | { type: 'profile.removed'; profileId: string }
  | { type: 'agent.removed'; agent: AgentId }
  /** A binary install advances or ends (`agents.install`): full state, the last event has state done, error or cancelled. */
  | { type: 'agent.install'; install: AgentInstall }
  /** The login state of an ACP agent changed (after `agents.authenticate` or a session): `id` is the registry one. */
  | { type: 'agent.login'; id: string; login: AgentLogin }
  /** An "Other agents" row changed (start and end of a probe, end of a sign-in or sign-out): full row, replaces the previous one with the same `id`. */
  | { type: 'agent.connection'; agent: OtherAgentConnection }
  | { type: 'review.update'; review: ReviewState }
  | { type: 'terminal.upsert'; terminal: TerminalInfo }
  | { type: 'terminal.removed'; id: string }
  | { type: 'terminal.data'; id: string; data: string }
  /** The terminal was cleared (`terminal.clear`): every renderer empties its own xterm for `id`. */
  | { type: 'terminal.cleared'; id: string }
  /** The project's terminal printed a local address (dev server): the UI can offer or open the Browser tab. Once per project and address. */
  | { type: 'browser.devserver'; projectId: string; terminalId: string; url: string }
  // ── Agent browser ──
  /** State of a session's agent browser: whole, on every change. `state.closed` = the session no longer has the browser. */
  | { type: 'browser.agent'; state: AgentBrowserState }
  // ── End agent browser ──
  /** Something changed in the folder: tree, git state and the "current" diff must be reread. */
  | { type: 'fs.changed'; root: string }
  // ── Git status ──
  /** Git state of a folder changed (changes, commits, fetch, branch switch): whole, only if different from the last one sent. */
  | { type: 'git.status'; status: GitStatus }
  // ── end of git status ──
  // ── Branch map ──
  /** Branch map changed: whole, only if different from the last one sent, for projects with a subscribed window (`project.branchMap.watch`). */
  | { type: 'project.branchMap'; projectId: string; map: BranchMap }
  // ── Phones ──
  /** The remote channel changed (active or not, devices, connections, QR, password, "Allow Full"): whole state. */
  | { type: 'remote.status'; status: RemoteStatus }
  /** A phone has just paired (to close the QR dialog and show "Connected"). */
  | { type: 'remote.paired'; device: RemoteDeviceInfo }
  /** New entry in the remote action log. */
  | { type: 'remote.log'; entry: RemoteLogEntry }
  // ── end of phones ──
  // ── end of branch map ──
  /** A connection changed: the download or login advances, or has finished (also with an error). */
  | { type: 'connection.update'; status: ConnectionStatus }

/** Messages on the renderer ↔ host channel. Commands with `rid` receive an answer with the same id. */
export type ToHost = { rid?: string; command: HostCommand }
export type FromHost =
  | { kind: 'event'; event: HostEvent }
  | { kind: 'result'; rid: string; ok: true; data?: unknown }
  | { kind: 'result'; rid: string; ok: false; error: string }

// ── Remote channel (phone) ───────────────────────────────────────────────────
//
// A remote client speaks the same protocol with the host as the window does (commands with rid, results, events), but:
// - only the RemoteCommand commands: the others are rejected by the remote gateway, before Host.handle;
// - it receives only RemoteEvent events, and session.items / session.subagents only for the sessions it follows (`session.watch`);
// - the chat arrives in pages with `session.page`, never whole.
// Transport: Noise_NK_25519_ChaChaPoly_SHA256 (shared/remote/noise.ts), one Noise message per binary frame.
// The plaintext of each Noise message after the handshake is a frame (see REMOTE_FRAME_*): a long JSON is split across several frames.

/**
 * Remote channel version: goes in the handshake payloads; a different version closes the connection.
 * 2: after the handshake the connection is NOT authenticated and the first message must be `pair` or `auth` (see the phones section above).
 */
export const REMOTE_PROTOCOL_VERSION = 2

/** Noise prologue: binds the handshake to Ladder and to the channel version. */
export const REMOTE_NOISE_PROLOGUE = 'ladder-remote-v1'

/** Payload of the first handshake message (client → Mac), UTF-8 JSON. */
export interface RemoteClientHello {
  v: number
  /** Readable device name, for the diagnostic log only: it arrives before authentication, so it is not an identity (that is `pair`/`auth`). */
  device: string
  /** App language on the phone; does not change the host's language. */
  locale?: Locale
}

/** Payload of the handshake reply (Mac → client), UTF-8 JSON. */
export interface RemoteServerHello {
  v: number
  /** Mac name (computer name, cleaned up). */
  mac: string
  /** Ladder version on the Mac. */
  app: string
}

/** Window commands also allowed to the remote client. It is an allowlist: a new command does not reach the phone unless added here. */
export type RemoteAllowedType =
  | 'hello'
  | 'session.read'
  | 'session.send'
  | 'session.interrupt'
  | 'session.respond'
  | 'session.queue.set'
  | 'session.queue.deliver'
  | 'session.permission.set'
  | 'session.commands'
  | 'session.command'
  | 'subagent.list'

/**
 * Remote client commands. Compared with the window:
 * - `hello` answers RemoteSnapshot (not the full snapshot), only as a result: the `snapshot` event is not sent;
 * - `session.send` and `session.create` accept up to REMOTE_MAX_ATTACHMENTS images (validated by the Mac); `session.respond` is always `via: 'phone'` (forced by the gateway);
 * - `session.command` runs a session / command: `name` must be in that session's current `session.commands` list, `args` is text of at most 2000 characters; in the action log: "Command /name" (never the arguments);
 * - `session.permission.set` stays limited by the project maximum, as for the window;
 * - `session.queue.set` counts only id and text (queued attachments stay the ones saved on the Mac);
 * - `session.queue.deliver` also delivers the attachments that had been queued on the Mac: the phone does not see them, but they go out;
 * - the gateway rate-limits requests (about 20 per second, bursts of 40): beyond that, the request comes back with an error.
 */
export type RemoteCommand =
  | Extract<HostCommand, { type: RemoteAllowedType }>
  /**
   * A chat page, from the end backwards. Answers RemotePage.
   * `before`: exclusive seq to start from (absent = from the end); `limit` default 60, maximum 200 items.
   */
  | { type: 'session.page'; sessionId: string; before?: number; limit?: number }
  /**
   * Follows (on) or stops following (off) a session: with on the session.items events (also replace: true,
   * for example after /compact) and session.subagents of that session arrive. At most 8 followed sessions per connection:
   * beyond that, the least recent stops being followed. Subscriptions disappear with the connection.
   * A `session.items` with replace: true (also the one the Mac sends when you open the chat) reaches the phone reduced
   * to the last page, like `session.page` without parameters, always with replace: true: the whole chat never travels.
   */
  | { type: 'session.watch'; sessionId: string; on: boolean }
  /**
   * Saves (or removes, with token null) this device's push notification token (Expo).
   * Answers null. The Mac keeps it on the device's row, never in the log; `platform` updates the device's.
   * `token` at most 512 characters.
   */
  | { type: 'device.push.set'; token: string | null; platform: RemotePlatform }
  /**
   * Push notification preferences of this device (owned by the phone; the Mac keeps them on the device's
   * row and applies them before sending). Answers null. The phone sends them on every connection after authentication:
   * the command is idempotent and the Mac does not send them back. Validation: `events` with all four boolean keys,
   * `quiet.from`/`to` "HH:MM" (24 hours), `quiet.tz` a valid IANA time zone (e.g. "Europe/Rome"), at most 64 characters.
   * Defaults (until the phone sends anything): all events on, no quiet hours.
   */
  | { type: 'device.notify.set'; prefs: RemoteNotifyPrefs }
  /**
   * The app is in the foreground (true) or not (false). In memory only, per connection: it disappears with the connection.
   * With at least one of the device's connections in the foreground the Mac does not send the push (the app shows the event live).
   * The phone sends it on every AppState change, right after authentication and, while in the foreground, every ~20 seconds (heartbeat):
   * the Mac uses the device's latest state, but `true` counts only if it was reported in the last 30 seconds or the connection
   * had command traffic in the last 30 seconds: a silent connection does not suppress pushes. Answers null.
   */
  | { type: 'device.state'; foreground: boolean }
  /**
   * Archived sessions of a project (Project screen), read-only, most recent first by `updatedAt`. Answers SessionSummary[].
   * `before`: exclusive `updatedAt` to continue from (the last one received); `limit` default 30, maximum 100. Fewer than `limit` results = done.
   * They are not in the snapshot. Unknown project: error.
   */
  | { type: 'project.sessions.archived'; projectId: string; before?: number; limit?: number }
  /**
   * New chat session from the phone. Answers SessionSummary (the same as the window); the session also arrives
   * with `session.upsert` (usually before the result), and can be followed right away with `session.watch` (then `session.page` for
   * the items already written: session.items events are sent only for followed sessions).
   * Strict validation (translated error, no session created if anything is wrong):
   * - only the RemoteSessionCreate keys are allowed; `attachments` (images, see below; `[]` counts as none), `command`,
   *   `worktree`, `branch`, `baseBranch`, `newBranch`, `setupWait`, `source`, `title` or a `mode` other than 'chat' = request rejected;
   * - `projectId` existing; `agent` known, available and allowed by the project (`agents.allowed`);
   * - `text` non-empty (after trim), at most 200000 characters;
   * - `model`: an AgentStatus.models id of that agent (of the profile, if `profileId` is given) or null = the agent's default;
   *   `effort`: level accepted by the chosen model (or the default one) or null = default; agents without effort: null;
   * - `permission`: one of the four levels. 'full' with "Allow Full access from phone" off = REJECTED (like `session.permission.set`,
   *   no silent reduction to edit: the phone already shows Full disabled). Above the project's `permissionsMax` it is REDUCED
   *   to the cap (as for the window);
   * - `profileId` (optional) existing and belonging to the chosen agent.
   * - `attachments` (also of `session.send`): at most REMOTE_MAX_ATTACHMENTS images, `mediaType` in REMOTE_ATTACHMENT_TYPES,
   *   canonical base64 `data`, at most REMOTE_MAX_ATTACHMENT_BYTES decoded each and REMOTE_MAX_ATTACHMENTS_TOTAL overall, magic number
   *   consistent with the type; `name` reduced to a basename (120 characters, no control characters; empty = image.jpg/png/webp). Translated error if anything is wrong.
   *   With at least one image `text` can be empty. They count toward the per-device limit (burst of 6, then 10 per minute). Log: "Message with N images".
   * The session starts in the project's main checkout (no worktree from the phone) and in chat (never a terminal).
   * In the action log (`create`): "New session: <agent> in <project>", without the text.
   */
  | RemoteSessionCreate
  /**
   * Search for a project's files for the phone's `@` mentions. Answers string[]: paths relative to the project
   * root (respects .gitignore like the window), at most min(`limit`, REMOTE_FILE_SEARCH_MAX), `limit` default 20.
   * `query` at most 200 characters; empty = the shallowest files. The filter runs on the Mac: the phone never downloads the whole list,
   * which is why `project.files` (the full list) is NOT allowed from the phone. Per-device limit (burst of 10, then 4 per second).
   */
  | { type: 'project.files.search'; projectId: string; query: string; limit?: number }
  /**
   * Rereads the plan's usage limits (same parameters as the window command). Answers AgentStatus without `email` or `path`
   * (RemoteAgentStatus). At most one real read every 60 seconds per agent+profile per connection: before that, it answers with the last
   * value read (host cache) without touching the provider. The value also arrives with `agent.status`.
   */
  | { type: 'agents.usage'; agent: AgentId; profileId?: string }

/** `session.create` command from the phone; see RemoteCommand. */
export interface RemoteSessionCreate {
  type: 'session.create'
  projectId: string
  agent: AgentId
  text: string
  model: string | null
  effort: Effort | null
  permission: PermissionLevel
  profileId?: string | null
  /** Only 'chat' (or absent). */
  mode?: 'chat'
  /** Images (at most REMOTE_MAX_ATTACHMENTS), validated like those of `session.send`. */
  attachments?: Attachment[]
}

/** AgentStatus as the phone sees it: without the account email or the CLI path. */
export type RemoteAgentStatus = Omit<AgentStatus, 'email' | 'path'>

/** Profile (account) without the configuration folder. `Project.profiles` says which one each project uses. */
export type RemoteProfile = Pick<Profile, 'id' | 'agent' | 'name' | 'isDefault'>

/**
 * How a new session starts in a project, already resolved by the Mac with the same rules as the new chat
 * (project, then the TOML [agents] default, then global defaults, then the last agent, then Claude Code or the first available).
 * - `allowed`: agents allowed by the project; empty = all the available ones;
 * - `agent`: proposed agent (null if none is usable); `lastAgent`: last used in chat in the project (may no longer be allowed);
 * - `launch`: for each available and allowed agent, the model and effort chosen by Ladder (project, then global) to send to
 *   `session.create`; null = no level chooses: null is sent and the session follows the agent's default (on the Mac it shows as Default).
 *   To show it the phone uses the `isDefault` model of AgentStatus.models (of the project's account, `Project.profiles`). Values valid for the account
 *   assigned to the project for that agent;
 * - `permission`: proposed permission, already reduced to the project's cap and to 'edit' if "Allow Full access from phone" is off.
 */
export interface RemoteProjectDefaults {
  allowed: AgentId[]
  agent: AgentId | null
  lastAgent: AgentId | null
  launch: Partial<Record<AgentId, { model: string | null; effort: Effort | null }>>
  permission: PermissionLevel
}

/** Events that can become a push: the same as AttentionEvent except `resolved`. */
export type PushKind = 'request' | 'turn' | 'error' | 'agents'

/**
 * Push preferences of a device (`device.notify.set`).
 * - `events`: which events to notify;
 * - `quiet`: quiet hours, evaluated in the phone's `tz` time zone; also valid across midnight (from > to);
 *   from === to = empty range; null = no range;
 * - `quietAllowsRequests`: with true, requests and questions go through even in quiet hours (default false:
 *   nothing arrives during quiet hours).
 */
export interface RemoteNotifyPrefs {
  events: Record<PushKind, boolean>
  quiet: { from: string; to: string; tz: string } | null
  quietAllowsRequests?: boolean
}

/**
 * `data` of the push (Expo `data`, so also in `response.notification.request.content.data` on tap). Deliberately
 * without titles or text: Expo, Apple and Google see only "Ladder" and a generic sentence; the phone gets the details
 * from the encrypted channel (`hello`, `session.page`). On tap: open session `sessionId` on Mac `mac` and, if `itemId` is present, the request.
 * `mac`: `pushMacId(RemotePairingPayload.key)` (shared/remote/pairing.ts): sha256 of the Mac's key, 16 base64url characters. The phone
 * computes it from its pairing and compares; it is not the relay id (whoever sees the push cannot enter the room) and it holds on every transport.
 */
export interface RemotePushData {
  v: 1
  kind: PushKind
  sessionId: string
  /** Id of the request (kind 'request'), of the turn or of the error; null if none. */
  itemId: string | null
  mac: string
}

/** Push title: always "Ladder". The text (`body`) is generic and in the app's language on the phone (RemoteClientHello.locale). */
export const REMOTE_PUSH_TITLE = 'Ladder'
/** Android channel for pushes (created by the app: high importance). */
export const REMOTE_PUSH_CHANNEL = 'sessions'

export interface RemotePage {
  sessionId: string
  /** In increasing seq order. */
  items: ChatItem[]
  /** There are items older than the first one returned. */
  hasMore: boolean
}

/** Snapshot for the remote client: only what the Home (sidebar) and the sessions need. */
export interface RemoteSnapshot {
  type: 'snapshot'
  projects: Project[]
  /** Non-archived sessions, as in the window's snapshot. */
  sessions: SessionSummary[]
  /** From ProjectUiState only the session groups and `seenAt` ("While you were away"). */
  ui: Record<string, Pick<ProjectUiState, 'groups' | 'groupOf' | 'seenAt'>>
  projectGroups?: ProjectGroupsState
  /** Agents and models, for the session rows and the permission. Without `email` or `path`; `usage`/`usageAt`/`limits`/`account` (plan) are present. */
  agents: RemoteAgentStatus[]
  /** Accounts (subscriptions) of Claude Code and Codex: name and agent, to list the subscriptions (`AgentStatus.profileId` links them to the state). Never the configuration folder. */
  profiles: RemoteProfile[]
  /**
   * Defaults of the new session per project (key: project id). Read at hello and updated by the `remote.defaults`
   * event when the global defaults, the agents' models, the project list or the project's UI change
   * (last agent, project defaults); changes to the `.ladder/settings*.toml` files show up at the next hello.
   */
  defaults: Record<string, RemoteProjectDefaults>
  /**
   * Permission cap per project (`permissions_max` of the project settings, personal files included): null = no cap.
   * The phone disables the levels above the cap; the host clamps them anyway. Read at hello: if it changes on the Mac it shows at the next hello.
   */
  permissionsMax: Record<string, PermissionLevel | null>
  /** Mac preferences that the phone mirrors (read at hello). */
  prefs: RemotePrefs
}

/**
 * Mac preferences visible to the phone.
 * - `busySend`: what the send key does while the session is working ('steer' inserts into the turn, 'queue' queues): it is AppPrefs.busySend, like `session.send` with `busy`;
 * - `allowFull`: "Allow Full access from phone". False: the phone shows the Full level disabled ("turned off on your Mac"); `session.permission.set` with full comes back with an error.
 */
export interface RemotePrefs {
  busySend: 'steer' | 'queue'
  allowFull: boolean
}

/** Events forwarded to the remote client; all the others stay on the Mac. */
export type RemoteEvent =
  | RemoteSnapshot
  /** The Mac's preferences changed (for example "Allow Full access from phone"): they replace `RemoteSnapshot.prefs`. */
  | { type: 'remote.prefs'; prefs: RemotePrefs }
  /** Replaces `RemoteSnapshot.defaults` and `permissionsMax` (they change together: defaults, caps, models). */
  /** The accounts (profiles) change: same events as the window, but without the configuration folder. */
  | { type: 'profile.upsert'; profile: RemoteProfile }
  | { type: 'profile.removed'; profileId: string }
  | { type: 'remote.defaults'; defaults: Record<string, RemoteProjectDefaults>; permissionsMax: Record<string, PermissionLevel | null> }
  | Extract<
      HostEvent,
      {
        type:
          | 'session.upsert'
          | 'session.items'
          | 'session.subagents'
          | 'sessions.autoArchived'
          | 'project.upsert'
          | 'project.removed'
          | 'projectGroups.changed'
          | 'agent.status'
      }
    >

/** After authentication. A connection's first message is instead a RemoteFirstMessage. */
export type ToRemoteHost = { rid?: string; command: RemoteCommand }
export type FromRemoteHost =
  | { kind: 'event'; event: RemoteEvent }
  | { kind: 'result'; rid: string; ok: true; data?: unknown }
  | { kind: 'result'; rid: string; ok: false; error: string }
  /** Answer to the first message (`pair`/`auth`); with ok: false the Mac closes right away. It can also arrive later, to warn of a revocation. */
  | RemoteAuthResult

/**
 * Remote channel frame: plaintext of a Noise message after the handshake. The first byte is
 * REMOTE_FRAME_MORE if the JSON continues in the next frame, REMOTE_FRAME_END if it ends here; the rest is UTF-8.
 * A Noise message carries at most 65535 bytes (65519 of text with the tag), so a long JSON is split.
 * MORE frames are always full (65519 bytes): a shorter one closes the connection.
 * The client closes the connection if a reassembled JSON exceeds REMOTE_MAX_MESSAGE bytes; the host, which receives only small
 * commands: before authentication at REMOTE_MAX_COMMAND, after at REMOTE_MAX_ATTACH_COMMAND (for messages with images;
 * a message over REMOTE_MAX_COMMAND that carries no attachments on `session.send`/`session.create` closes the connection).
 */
export const REMOTE_FRAME_END = 0
export const REMOTE_FRAME_MORE = 1
export const REMOTE_MAX_MESSAGE = 16 * 1024 * 1024
/** Maximum size of a client message to the host (commands, not snapshots). */
export const REMOTE_MAX_COMMAND = 1024 * 1024
/** Maximum size of an AUTHENTICATED client's message (only `session.send`/`session.create` with images can exceed REMOTE_MAX_COMMAND). */
export const REMOTE_MAX_ATTACH_COMMAND = 3 * 1024 * 1024
/** Images per message, decoded bytes per image and in total, allowed types. */
export const REMOTE_MAX_ATTACHMENTS = 3
export const REMOTE_MAX_ATTACHMENT_BYTES = 1024 * 1024
export const REMOTE_MAX_ATTACHMENTS_TOTAL = 2 * 1024 * 1024
export const REMOTE_ATTACHMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
/** Maximum results of `project.files.search`. */
export const REMOTE_FILE_SEARCH_MAX = 50

// ── end of remote channel ──

// ── Relay ──
// The relay (app/relay, on Cloudflare) forwards encrypted bytes between Mac and phone; the format of its messages is in shared/remote/relay-protocol.ts.

/** Ladder's default relay, used when HostPrefs.remote.relayUrl is null. Placeholder: the real address is confirmed before release. */
export const REMOTE_DEFAULT_RELAY_URL = 'wss://relay.ladder.app'

/**
 * Why the Mac is not reachable, as far as the relay knows (it reaches the phone with the Mac's state).
 * 'rekeyed': the Mac regenerated its key ("Regenerate key") and will never come back at this id: the phone must pair again.
 */
export type RemoteOfflineReason = 'offline' | 'asleep' | 'quit' | 'rekeyed' | 'unknown'

/** Mac state as seen by the phone through the relay. `since` = last time the relay saw the Mac (ms), null if never. */
export type RemoteMacStatus = { online: true } | { online: false; since: number | null; reason: RemoteOfflineReason }

// ── end of relay ──

// ── Phone pairing, device list, revocation, password, key regeneration, log ──
//
// Noise NK authenticates only the Mac. The phone identifies itself AFTER the handshake with its own Ed25519 key (in the phone's
// secure storage, created at pairing): until it has done so the connection is NOT authenticated and the gateway accepts a single
// message, a RemoteFirstMessage (`pair` the first time, `auth` afterwards). Everything else (hello, commands) is rejected
// and closes the connection. There are ten seconds from opening to authenticate.
//
// The `sig` signature covers `ladder-device-v1|<pair|auth>|<handshake hash in base64url>` (channelBinding in shared/remote/pairing.ts):
// the Noise handshake hash is the same on both sides (RemoteSession.handshakeHash) and differs on every connection, so a signature
// cannot be reused on another connection.
//
// Phone flow:
//  1. Scans the QR (`ladder://pair#…`) and reads it with decodePairingUrl. Before connecting it shows the Mac's name (`mac`),
//     key fingerprint (keyFingerprint) and relay: the user confirms. If `pw` is set, asks for the password.
//  2. Opens the channel (relay `relay`+`id`, or `ws` in development), does the Noise NK handshake with `key`.
//  3. Sends a signed RemotePairRequest. Answer RemoteAuthResult { ok: true, deviceId }: saves deviceId (and the Mac key) and
//     from here on uses `hello` and the commands.
//  4. On later connections: handshake, then RemoteAuthRequest { deviceId, sig }.
// A RemoteAuthResult with ok: false closes the connection: the phone shows `error` (already translated into the Mac's language) and,
// for 'device-revoked' / 'unknown-device', forgets the pairing. With a regenerated Mac key the handshake itself
// fails (the known key is no longer the Mac's): the phone must offer to pair again.

/** Version of the QR format (`v` field of the payload). */
export const REMOTE_PAIRING_VERSION = 1
/** QR lifetime: after this time the code is no longer valid. */
export const REMOTE_PAIRING_TTL_MS = 5 * 60 * 1000
/** Failed attempts (signature, password) on the same code before the code is burned. */
export const REMOTE_MAX_PAIR_ATTEMPTS = 5
/** Length of the Mac's password, in characters. */
export const REMOTE_PASSWORD_MIN = 4
export const REMOTE_PASSWORD_MAX = 128

export type RemotePlatform = 'ios' | 'android'

/**
 * QR content: JSON → base64url after `ladder://pair#` (in the fragment: it never goes to a server). Encoding and reading:
 * encodePairingUrl / decodePairingUrl in shared/remote/pairing.ts. Reachability: `relay` + `id`, or `ws`, or both.
 */
export interface RemotePairingPayload {
  /** REMOTE_PAIRING_VERSION. */
  v: number
  /** Mac name (the same as in RemoteServerHello). */
  mac: string
  /** The Mac's X25519 public key, base64url, 32 bytes: it is the static key of the Noise NK handshake. */
  key: string
  /** Relay address (wss://…) and the Mac's id on that relay (RelayTransport({ relayUrl, macId })). */
  relay?: string
  id?: string
  /** Development only: the Mac's local WebSocket (ws://127.0.0.1:port) to pair from the simulator without a relay. */
  ws?: string
  /** One-time code, 32 random bytes base64url. Valid once, for 5 minutes; never to be logged. */
  token: string
  /** Expiry of the code, ms since epoch (the Mac's clock). */
  exp: number
  /** The Mac has a password: the phone must ask for it and send it in `password`. */
  pw: boolean
}

/** Kind of device signature: it goes into the signed text, so an `auth` signature is not valid as `pair`. */
export type RemoteAuthKind = 'pair' | 'auth'

/** First pairing. `device.publicKey`: the phone's Ed25519, base64url, 32 bytes. `name` at most 80 characters (e.g. "Alex's iPhone"). `sig`: base64url. */
export interface RemotePairRequest {
  type: 'pair'
  token: string
  device: { publicKey: string; name: string; platform: RemotePlatform }
  /** Required if the Mac has a password (`RemotePairingPayload.pw`). Checked only here, never in `auth`. */
  password?: string
  sig: string
}

/** Connection of an already paired device. */
export interface RemoteAuthRequest {
  type: 'auth'
  deviceId: string
  sig: string
}

/** The only message allowed on an unauthenticated connection. */
export type RemoteFirstMessage = RemotePairRequest | RemoteAuthRequest

/**
 * Why authentication failed (after every error the Mac closes the connection):
 * - bad-token: unknown or inactive code (the QR was replaced or cancelled); token-expired: expired; token-used: already used or burned;
 * - password-required / wrong-password: missing or wrong; too-many-attempts: too many errors on the code (the code is burned) or too many errors in a row from the same origin;
 * - device-revoked: revoked by the Mac (also by "regenerate key"): the pairing is no longer valid; unknown-device: the Mac does not know this id (for example after a restore);
 * - bad-signature: invalid signature; remote-disabled: "Access from your phone" is off on the Mac; invalid-request: wrong message shape.
 */
export type RemoteAuthErrorCode =
  | 'bad-token'
  | 'token-expired'
  | 'token-used'
  | 'password-required'
  | 'wrong-password'
  | 'too-many-attempts'
  | 'device-revoked'
  | 'unknown-device'
  | 'bad-signature'
  | 'remote-disabled'
  | 'invalid-request'

/**
 * Authentication result. With ok: true: `deviceId` (to save on the phone), `name` (the registered name) and `allowFull`
 * (false = "Allow Full access from phone" is off: the phone does not offer the Full level). With ok: false: `error` is already translated.
 */
export type RemoteAuthResult =
  | { kind: 'auth'; ok: true; deviceId: string; name: string; allowFull: boolean }
  | { kind: 'auth'; ok: false; code: RemoteAuthErrorCode; error: string }

/** A paired device, as the window sees it (revoked ones are not there). */
export interface RemoteDeviceInfo {
  id: string
  name: string
  platform: RemotePlatform
  /** Primo abbinamento, ms. */
  createdAt: number
  /** Last successful connection or last close, ms; null if it never connected after pairing. If `connected`, it is now. */
  lastSeenAt: number | null
  /** Has at least one authenticated connection right now. */
  connected: boolean
  /** The phone registered a push token (it receives notifications with the app closed). The host always sets it; optional only for the UI fixtures. */
  pushEnabled?: boolean
}

/**
 * State of the remote channel for Settings → Devices and for the indicator in the top bar (`connectedCount > 0`).
 * Arrives as the result of `remote.status` and as a `remote.status` event on every change.
 */
export interface RemoteStatus {
  /** The channel is active: "Access from your phone" on (AppPrefs.remote.enabled) or, in development, LADDER_REMOTE_PORT / LADDER_RELAY_URL. Off: no QR. */
  enabled: boolean
  /** Relay in use; null if the channel is off or only the local development WebSocket is used. */
  relayUrl: string | null
  /** The Mac's id on the relay (changes with "regenerate key"). */
  relayId: string | null
  macName: string
  /** Fingerprint of the Mac's key ("7F3A 91C2 · E04B 5D18"), the same one the phone shows before connecting; null if the key was never created. */
  fingerprint: string | null
  hasPassword: boolean
  /** "Allow Full access from phone" (AppPrefs.remote.allowFull). */
  allowFull: boolean
  /** Paired devices (not revoked), most recent first. */
  devices: RemoteDeviceInfo[]
  /** How many devices are connected now (for the indicator). */
  connectedCount: number
  /** Active QR: expiry in ms; null if no QR is active. A new `remote.status` arrives on expiry. */
  pairing: { expiresAt: number } | null
}

/** Answer of `remote.pair.start`. */
export interface RemotePairStart {
  /** `ladder://pair#…`: the text to put in the QR. It contains the one-time code: do not log it. */
  url: string
  payload: RemotePairingPayload
  /** Fingerprint of the Mac's key, to show next to the QR. */
  fingerprint: string
  expiresAt: number
}

/** Actions from the phone that end up in the log (visible on the Mac). */
export type RemoteLogAction = 'respond' | 'send' | 'queue' | 'interrupt' | 'permission' | 'create'

/**
 * An entry of the remote action log. `detail` is a short summary, already translated into the Mac's language at the time
 * of the action, never the text of a message: "Approved: Run command", "Message (42 chars)", "Permission → Full", "Stopped".
 */
export interface RemoteLogEntry {
  id: number
  deviceId: string
  /** Device name (even if it was revoked afterwards). */
  deviceName: string
  /** ms. */
  at: number
  action: RemoteLogAction
  sessionId: string | null
  detail: string
}

export interface RemoteLogPage {
  /** Most recent first. */
  entries: RemoteLogEntry[]
  hasMore: boolean
}

// ── end of phone pairing ──

// ── Host ↔ main process: notifications, Dock badge and preferences ───────────

/** Events that can become a macOS notification. Decided by main, which knows what you are looking at. */
export type AttentionEvent =
  | { kind: 'request'; sessionId: string; projectId: string; itemId: string | null; title: string; body: string }
  | { kind: 'resolved'; sessionId: string; itemId: string | null }
  | { kind: 'turn'; sessionId: string; projectId: string; projectName: string; itemId: string | null; durationMs: number; title: string }
  | { kind: 'error'; sessionId: string; projectId: string; itemId: string | null; title: string; body: string }
  /**
   * Background sub-agents finished while the session is idle: 'done' when none is left
   * running (finished = how many finished since the last notice), 'failed' right away for every error.
   */
  | { kind: 'agents'; sessionId: string; projectId: string; projectName: string; itemId: string | null; outcome: 'done' | 'failed'; finished: number; failed: number; title: string; body: string }

/** `open-url`: the host has no browser; main opens the https address (login page) in the default browser. */
export type HostToMain =
  | { type: 'attention'; event: AttentionEvent }
  | { type: 'badge'; count: number }
  | { type: 'open-url'; url: string }
  /** Shortcuts in use: main applies them to the menu accelerators and rebuilds the menu. */
  | { type: 'shortcuts'; preset: ShortcutPreset; overrides: Keybinding[] }
  /** Opens keybindings.json (main knows the path) in the system app. */
  | { type: 'open-keybindings' }
  /**
   * Sessions that are working (turn in progress, not waiting for you) and phones connected to the remote channel, on every change of either:
   * main keeps the Mac awake if AppPrefs.keepAwake (and there is work or a phone) and shows the state in the menu bar. `phones` absent = 0.
   */
  | { type: 'activity'; running: number; phones?: number }
  /** Answer to `power` with state 'quit': the relay was notified (or there was none), main can close the host. */
  | { type: 'power-ack'; state: 'quit' }
  /** Opens a folder or a file in Finder / the system app: main does it only inside the app's data folder. */
  | { type: 'open-path'; path: string }
  // ── Agent browser ──
  /** Operation on the agent's browser: main runs it and answers with `browser-agent-result` (same `rid`). */
  | { type: 'browser-agent'; rid: string; op: BrowserAgentOp }
  // ── End agent browser ──
  // ── Media files ──
  /** Roots main can serve files from (ladder-file://<id>/…): full list on every change, whatever is missing stops working. */
  | { type: 'file-roots'; roots: { id: string; root: string }[] }
  /** Shows a file of root `id` in Finder: main rechecks that it is inside the root. */
  | { type: 'reveal-file'; id: string; path: string }
  // ── End media files ──

export interface HostPrefs {
  /** Language of notices, errors, notifications and default prompts. */
  locale?: Locale
  /** Titles generated by a small model after the first turn. Default true. */
  generatedTitles?: boolean
  /** Branch name, commit message and PR text written by the model; global, applies to all projects. Default true. */
  generatedText?: boolean
  /** Autonomy instruction in the system prompt of sessions in Edit and Full access. Default true. Applies from the start (or resume) of the session. */
  autonomyHint?: boolean
  /** Flags turns that stopped for no reason (turn-end.stalled). Default false until the heuristic is proven. */
  stallHint?: boolean
  /** Folder for new worktrees (`<folder>/<project>/<name>`); null = the default one. Does not move existing worktrees. */
  worktreesDir?: string | null
  /** Branch prefix for new worktrees. Default 'ladder/'. See cleanBranchPrefix in shared/worktree-prefs. */
  branchPrefix?: string
  /** Archive sessions idle for this many days; null = never. */
  autoArchiveDays?: number | null
  // ── Agent browser ──
  /** Browser for the agent, global (see AppPrefs.agentBrowser). Default false. */
  agentBrowser?: boolean
  // ── End agent browser ──
  /**
   * Remote channel for the phone through the relay. Absent = off.
   * `relayUrl`: relay address (wss://…); null = the default one (REMOTE_DEFAULT_RELAY_URL). Whoever hosts their own relay puts theirs.
   * `allowFull` = "Allow Full access from phone": if false the phone cannot switch a session to Full (absent = true).
   */
  remote?: { enabled: boolean; relayUrl: string | null; allowFull?: boolean }
  /** What send does while a session is working (AppPrefs.busySend): the phone repeats it in its send key (RemotePrefs). Absent = unchanged. */
  busySend?: 'steer' | 'queue'
  /** Global defaults for new sessions (AppPrefs.defaults), to resolve the ones shown to the phone. */
  defaults?: SessionDefaults
}

/** Event to send to phones; no texts (the push is generic). */
export interface PushEvent {
  kind: PushKind
  sessionId: string
  itemId: string | null
}

export type MainToHost =
  | { type: 'connect' }
  | { type: 'prefs'; prefs: HostPrefs }
  /** Mac state for the remote channel (phones see "sleeping" / "Ladder closed"). With 'quit' the host answers `power-ack`. */
  | { type: 'power'; state: 'asleep' | 'awake' | 'quit' }
  /** Main decided that an event should be notified to phones (nobody is watching the session on the Mac, Mac idle). The per-device filter is done by the host. */
  | { type: 'push'; event: PushEvent }
  // ── Agent browser ──
  | { type: 'browser-agent-result'; rid: string; result: BrowserAgentResult }
  /** The agent's view is gone (the user closed the tab or the window): the host revokes the session's tools. */
  | { type: 'browser-agent-closed'; sessionId: string }
  // ── End agent browser ──

/** App preferences saved by main in settings.json, together with the theme. */
export interface AppPrefs {
  notifications: boolean
  /** Sound only for approvals and questions. */
  sound: boolean
  /** "Do not disturb" until this instant: no notifications; "Waiting" and the badge stay. */
  dndUntil: number | null
  /** Interface language: English by default, Italian optional. */
  locale: Locale
  /** Global defaults for new sessions. */
  defaults: SessionDefaults
  /** Saved session profiles, in the order they are shown. */
  presets: SessionPreset[]
  /** Applies in all composers. Default 'enter'. */
  sendKey: SendKey
  /**
   * What the send key does while the session is working: 'steer' inserts into the turn,
   * (where the agent allows it, otherwise queues), 'queue' queues. Default 'steer'.
   * The other action stays on the send key with ⌥ (Alt) added and on the queue commands.
   */
  busySend: 'steer' | 'queue'
  /** Generates session titles with a small model after the first turn (Claude, Codex). Default true; "Regenerate title" works regardless. */
  generatedTitles: boolean
  /**
   * Master switch for the branch name, commit message and PR text.
   * Default true. Per project: ProjectUiState.generatedText. Titles stay governed by generatedTitles.
   */
  generatedText: boolean
  /** Font of the chat messages (user and model); the rest of the app stays in Mona Sans. Default 'system-sans' (used to be 'system-mono', migrated once by main). */
  chatFont: ChatFont
  /**
   * Width of the chat text, per column (container query), not per window:
   * 'comfortable' ~820px (default), 'wide' ~1100px, 'full' the whole column (used to be in ch). Wide
   * blocks (code, diffs, tables, output) go up to ~1100px or the column.
   */
  chatWidth: 'comfortable' | 'wide' | 'full'
  /** See HostPrefs.autonomyHint and stallHint. */
  autonomyHint: boolean
  stallHint: boolean
  /**
   * Name the app greets the user with. String trimmed to at most 80 characters; null = not set (empty or only spaces).
   * Stays only in settings.json on this Mac: it does not go to the host, agents or services.
   */
  userName: string | null
  // ── Agent browser ──
  /**
   * Browser for the agent (browser_* tools in an isolated browser, shown in a tab). Default false: it gives the agent
   * network and DOM access, so it is turned on by hand. Per project: ProjectUiState.agentBrowser. Optional only for fixtures.
   */
  agentBrowser?: boolean
  // ── End agent browser ──

  // ── Readability, editor, worktrees ──
  /** Text size of the chat messages, relative to the chosen font (chatFont). Default 'default'. */
  chatTextSize: TextSize
  /** Text size in the file editor, in px (10–24). Default 12. */
  editorTextSize: number
  /** Code font in the file editor (and in code blocks, if the UI wants it). Default 'system-mono'. */
  editorFont: CodeFont
  /** Row height of the sidebar. Default 'comfortable'. */
  sidebarDensity: 'comfortable' | 'compact'
  /** External editor for "Open in editor"; ProjectUiState.editor overrides it for a project. If it is not installed it falls back to the first installed one (Cursor, VS Code, Zed, Xcode). Default 'cursor'. */
  editor: EditorId
  /** Folder for new worktrees (absolute; a leading `~` is accepted); null = default (~/Developer/.ladder/worktrees or ~/.ladder/worktrees). Non-absolute values become null. */
  worktreesDir: string | null
  /** Branch prefix for new worktrees, for example 'ladder/' (default) or 'nico/'. Empty = no prefix. Values invalid for git go back to the default. */
  branchPrefix: string

  // ── Data and system ──
  /** Archive sessions idle (no turn, requests or queue) for this many days; null = never (default). 1–365. See the `sessions.autoArchived` event. */
  autoArchiveDays: number | null
  /** Opens Ladder at login (app.setLoginItemSettings). Only takes effect in the installed app; in development it stays false. Default false. */
  openAtLogin: boolean
  /** Keeps the Mac awake (powerSaveBlocker 'prevent-app-suspension': the screen may turn off) while at least one session is working. Default false. */
  keepAwake: boolean
  /** Remote channel for the phone (see HostPrefs.remote). Absent = off. With the channel on, Ladder stays in the menu bar when windows are closed. */
  remote?: { enabled: boolean; relayUrl: string | null; allowFull: boolean }
  /** Notification sound when `sound` is on: 'default' or the name of a macOS system sound. Default 'default'. */
  soundName: RequestSound
}

export type TextSize = 'small' | 'default' | 'large' | 'xlarge'
/** system-mono: SF Mono / Cascadia Mono / Consolas; monaspace-neon is bundled with the app. */
export type CodeFont = 'system-mono' | 'monaspace-neon'
export type RequestSound = 'default' | 'Glass' | 'Ping' | 'Pop' | 'Hero' | 'Submarine' | 'Funk' | 'Tink'

/** system-mono: SF Mono / Cascadia Mono / Consolas; system-sans: SF Pro / Segoe UI. */
export type ChatFont = 'system-mono' | 'system-sans' | 'mona-sans' | 'monaspace-neon'

/** What the window is looking at: main does not notify a request from the session in front of you. */
export interface WindowView {
  projectId: string | null
  sessionId: string | null
  /** All sessions visible in the window (side-by-side columns included); sessionId is the active one. */
  visibleSessionIds?: string[]
}

// ── Built-in browser ─────────────────────────────────────────────────────
// One main WebContentsView per tab, with partition `persist:project-<id>`: cookies and sessions separate
// from the user's and between projects. The UI only communicates the rectangle and the commands; main manages the view.

/** View rectangle in CSS pixels of the window (renderer coordinates, origin at top left). */
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserLoadError {
  /** Chromium network code (e.g. -102 connection refused); 0 for our own errors (blocked scheme, dead page). */
  code: number
  description: string
  url: string
}

/** State of a browser tab; main sends it whole on every change (event `ladder:browser-event`). */
export interface BrowserState {
  tabId: string
  projectId: string
  /** Current address (also during loading); empty string before the first navigation. */
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Error of the last main-frame load; null as soon as a new navigation starts. */
  error: BrowserLoadError | null
  /**
   * Non-blocking notice: a mailto: or other non-web scheme link was blocked by the main frame. The page stays
   * the previous one (it is not an `error`). Already translated; reset when a new navigation starts. Absent = null.
   */
  notice?: string | null
  // ── Agent browser ──
  /** Present only on the agent's browser tab (tabId `agent:<sessionId>`): isolated, in-memory partition. Absent = the user's tab. */
  agent?: { sessionId: string } | null
  // ── End agent browser ──
}

/** App shortcut pressed while the browser page has focus (event `ladder:browser-shortcut`): the renderer handles it as a keydown. */
export interface BrowserShortcut {
  key: string
  code: string
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
}

export type BrowserAction = 'back' | 'forward' | 'reload' | 'hard-reload' | 'stop' | 'focus' | 'devtools'

/** Outcome of navigate: `error` is a translatable text to show (empty address or scheme not allowed). */
export type BrowserNavigateResult = { ok: true; url: string } | { ok: false; error: string }
// ── End of built-in browser ──────────────────────────────────────────────

// ── Browser tools for the agent ──────────────────────────────────────────
// The agent's browser is a Browser tab of the user, marked "agent" (BrowserState.agent), with an isolated in-memory partition
// (`project-<id>-agent-<sessionId>`, without `persist:`): no cookies or storage of the user, all deleted at the end of the session.
// The tools are an MCP server of the host (HTTP on 127.0.0.1, token per session) registered in the adapters only if
// AppPrefs.agentBrowser / ProjectUiState.agentBrowser is on. Main owns the view and drives it on the host's request.
//
// Flusso UI:
//  1. The agent calls a tool → main creates the (hidden) view and the host emits `browser.agent` with `tabId`.
//  2. The UI, seeing a new `state.tabId`, opens the Browser tab with that id (window.ladder.browser.open(tabId, projectId) returns
//     the already created view; for an `agent:` id that does not exist main answers null) and shows it: the agent works in view.
//     If the tab is not visible, screenshots and clicks work worse (hidden view): it is better to bring it to the front.
//  3. `action` is the action in progress (one at a time), `last` the last finished one. Every call also arrives in chat as a tool
//     card (`mcp__ladder-browser__browser_*`), and confirmations as normal approval requests (RequestItem, toolName `browser_*`).
//  4. Stop: `browser.agent.stop` (button in the tab or in the chat). Closing the agent's tab counts as a final stop.
//     For the UI: `stopped` = show "Agent browser stopped" with a Resume button (`browser.agent.resume`).

/** The tools the agent sees. */
export type AgentBrowserTool = 'browser_navigate' | 'browser_read_page' | 'browser_screenshot' | 'browser_click' | 'browser_type' | 'browser_console'

export interface AgentBrowserAction {
  tool: AgentBrowserTool
  /** What it acts on, ready to show: the address, or `e12 · "Save"`; null for read/screenshot/console. The typed text is not included. */
  target: string | null
  at: number
}

export interface AgentBrowserState {
  sessionId: string
  projectId: string
  /** Id of the agent's Browser tab (`agent:<sessionId>`), to pass to window.ladder.browser.*; null until the view has been created or after it is closed. */
  tabId: string | null
  /** Tools active for this session. false: switch off (the state is not emitted if there was never a browser). */
  enabled: boolean
  /**
   * Stopped: the tools reject every call. Applies to the user's explicit stop and to closing the tab, until `browser.agent.resume`
   * (also after closing: the state stays, `tabId` is null and the tab is recreated at the agent's first action). The UI offers it from the command palette
   * and from the "+" menu of the tab bar. Interrupting the turn does not set `stopped`: it stops the current action and the next turn restarts on its own.
   */
  stopped: boolean
  /** The agent's browser is gone (session closed or switch off): the UI closes the tab. */
  closed: boolean
  /** Action in progress (also waiting for your confirmation); null if none. */
  action: (AgentBrowserAction & { waitingForYou: boolean }) | null
  /** Last finished action: `ok` false with the already translated reason in `error`. */
  last: (AgentBrowserAction & { ok: boolean; error?: string | null }) | null
  /** Domains other than localhost that you authorized in this session (reset on close). */
  allowedHosts: string[]
}

/**
 * Host → main channel (HostToMain `browser-agent`). Main always answers with plain data (strings, numbers): no page content
 * is ever interpreted as a command. `sessionId` identifies the view; main rechecks every address itself.
 */
export type BrowserAgentOp =
  /** Creates the view if missing. `projectId` for the partition. */
  | { op: 'open'; sessionId: string; projectId: string }
  | { op: 'navigate'; sessionId: string; url: string }
  | { op: 'read'; sessionId: string; maxChars: number; maxElements: number }
  | { op: 'screenshot'; sessionId: string }
  | { op: 'click'; sessionId: string; ref: string }
  | { op: 'type'; sessionId: string; ref: string; text: string }
  | { op: 'console'; sessionId: string; limit: number }
  /**
   * What the tab can open besides localhost. With `host: null` it starts from scratch: empties the allowed domains and sets `any` (true only for Full access).
   * With `host` it ADDS that domain without emptying anything (nor `any`): the caller first sends `host: null` and then an addition for every allowed domain
   * (approved for the session, plus the one approved once). `any` only applies in the message with `host: null`.
   */
  | { op: 'allow'; sessionId: string; host: string | null; any?: boolean }
  /** Stops the load and the action in progress. With `freeze` (user stop, default) main rejects every operation until `resume`; without it, only a timeout. */
  | { op: 'stop'; sessionId: string; freeze?: boolean }
  | { op: 'resume'; sessionId: string }
  /** Destroys the view and empties the partition. */
  | { op: 'close'; sessionId: string }

export interface AgentPageElement {
  /** Stable reference for click/type (`e12`): valid as long as the document is the same. */
  ref: string
  role: string
  name: string
  type?: string
  value?: string
  href?: string
  disabled?: boolean
  checked?: boolean
}

export type BrowserAgentResult =
  | { ok: true; url?: string; title?: string; text?: string; elements?: AgentPageElement[]; truncated?: boolean; image?: { mediaType: string; data: string }; /** Already translated warning (e.g. uniform screenshot). */ note?: string; messages?: { level: string; text: string }[]; tabId?: string }
  /** `error` is already translated; `code` distinguishes the case for the host: `blocked` = address not allowed, `stopped`, `closed`, `timeout`, `stale-ref`, `failed`. */
  | { ok: false; code: 'blocked' | 'stopped' | 'closed' | 'timeout' | 'stale-ref' | 'failed'; error: string; host?: string }
// ── End of browser tools for the agent ───────────────────────────────────

// ── Text written by a model ──────────────────────────────────────────────────

/** How much of the diff did not reach the model (character limit): files cut or skipped and characters not sent. */
export interface GeneratedTextCut {
  files: number
  chars: number
}

/** Answer of `text.commit`. Empty `body` = subject only. The text is always a proposal to edit. */
export interface GeneratedCommit {
  subject: string
  body: string
  /** Which diff was described. */
  source: 'staged' | 'working'
  /** Files changed in the described diff. */
  files: number
  truncated: GeneratedTextCut | null
}

// ── Commit ──
/** Longest commit subject accepted by the host (`git.commit`); the UI uses the same limit. */
export const MAX_COMMIT_SUBJECT = 200
/** Longest PR title and description accepted by `pr.prepare`. */
export const MAX_PR_TITLE = 256
export const MAX_PR_BODY = 65_000

/** Answer of `pr.prepare`: the prompt to send to the session and the files written. */
export interface PrPrepared {
  prompt: string
  titlePath: string
  bodyPath: string
}

/** Answer of `git.commit`: short hash of the new commit and subject (trimmed of surrounding spaces). */
export interface GitCommitResult {
  hash: string
  subject: string
}
// ── end of commit ──

// ── Git status ──
/**
 * Git state of a folder for the session header. Same source as the common fields of `MergeInfo`
 * (`dirty`, `unpushed` = `ahead` if `hasUpstream`, `hasUpstream`).
 */
export interface GitStatus {
  /** Working folder (the worktree if the session has one): key to match the `git.status` event. */
  root: string
  /** Current branch; null with detached HEAD. */
  branch: string | null
  /** Upstream of the branch, for example "origin/main"; null if unpublished (or detached HEAD). */
  upstream: string | null
  hasUpstream: boolean
  /** Commits to send (HEAD has, the upstream does not): the ↑ arrow. 0 if there is no upstream (read `hasUpstream`). */
  ahead: number
  /** Commits to pull (the upstream has, HEAD does not): the ↓ arrow, updated by the background fetch. */
  behind: number
  /** Files with uncommitted changes (staged, working folder and untracked not ignored). */
  dirty: number
  /** Lines added/removed by uncommitted changes (staged + working folder vs HEAD; new files count in full). 0 if dirty is 0. */
  added: number
  removed: number
  isWorktree: boolean
}
// ── end of git status ──

// ── Branch map ──
/** Why a map row has no numbers: the dependent fields are null. */
export type BranchMapProblem =
  /** The session has no branch (detached HEAD on the main checkout). */
  | 'detached'
  /** The branch no longer exists (deleted, or repository without commits). */
  | 'branch_missing'
  /** The main branch does not exist (repository without commits, base deleted). */
  | 'no_base'
  /** The branch and the main branch have unrelated histories: no merge-base. */
  | 'no_merge_base'

/**
 * A session on the map. All times are ms; the UI normalizes the X axis. The "in words" state is computed by the UI from `run`,
 * `archived` and `merged` as for the sidebar (running = running/starting, waiting for you = waiting, merged = merged, idle = the rest).
 */
export interface BranchMapEntry {
  sessionId: string
  title: string
  agent: AgentId
  run: RunState
  archived: boolean
  /** Last activity of the session: orders the map (most recent first) and decides "the last 6 active". */
  activityAt: number
  /** State of the branch's PR if already cached (no gh call to build the map); null if unknown or without a PR. */
  prState: PrStatus['state'] | null
  /** false: the session works on the main checkout. The host sends only those on the main branch (`isBase`), the last 20: they serve "you are on main". */
  isWorktree: boolean
  /** The worktree folder no longer exists (the branch may still be there: the numbers are the branch's). */
  worktreeMissing: boolean
  /** null with detached HEAD. */
  branch: string | null
  /** The branch is the main branch itself (session on the main checkout): no curve, no counts. */
  isBase: boolean
  problem: BranchMapProblem | null
  /** Fork point from main (`git merge-base`): full sha and commit date. Null with `problem`. */
  mergeBase: string | null
  mergeBaseAt: number | null
  /** Commits of the branch not in the main branch (↑) and of the main branch not in the branch (↓). From `merged` on they matter little: with squash ↑ stays > 0. */
  ahead: number | null
  behind: number | null
  /**
   * Merged: 'git' = the branch is already entirely in the main branch AND there is proof it had its own commits: a merge commit of the main
   * branch that cites it as parent, or (fast-forward) its branch on origin, which arrived after its creation, is inside the main
   * branch. A branch merely "advanced" along main (pull, reset) is NOT merged. 'pr' = the branch's PR is merged (squash and rebase
   * included), was already cached and the branch has no commits after it (PR object not fetched: not merged). Archived merged
   * sessions are remembered after a restart (`merged_via`/`merged_at` columns). When in doubt null: better a missed "merged" than a false one.
   */
  merged: 'git' | 'pr' | null
  /** When: merge commit on the main branch if there is one (git), the PR's `mergedAt` (pr), date of the branch's last commit as a fallback. Null if not merged. */
  mergedAt: number | null
  /** Last commit of the branch. */
  lastCommit: { subject: string; at: number } | null
  /** Lines added/removed by the branch's commits relative to the merge-base (not uncommitted changes). */
  added: number | null
  removed: number | null
  /** Files with uncommitted changes, only if the git tracker has already read the folder; otherwise null. */
  dirty: number | null
  /**
   * Row of the main checkout on a branch that is NOT the main branch (for example `development` with `main` as base): only one
   * per project, read from git (it appears even without sessions). `sessionId` is the most recent non-archived session of the main
   * checkout, or `main-checkout:<projectId>` if there is none (then it does not open); `isWorktree` is false and `branch` the checked-out branch.
   * `dirty` is the uncommitted files of the main checkout. With detached HEAD the row is absent.
   */
  mainCheckout?: true
}

export interface BranchMap {
  projectId: string
  /**
   * Main branch, read without network (origin/HEAD, then main or master; if the Merge panel already resolved it with gh, that one applies).
   * A PR toward another branch changes the Merge panel's base but not the map's. Null if the project is not git or the folder is missing.
   */
  base: string | null
  /** Date of the last commit of the main branch (end of the main line); null if unreadable. */
  baseAt: number | null
  /** Full sha of the last commit of the main branch (the same ref as `baseAt`); null if unreadable. */
  baseSha: string | null
  /** At most 50 worktree rows (active or merged), the most recent, plus the last 20 sessions on the main branch; the others are not there (`hidden`). */
  entries: BranchMapEntry[]
  /** Rows that would have a place on the map (active or merged worktrees) but are not there because of the 50 limit; an underestimate. */
  hidden: number
  /** Read failed: the map is empty and the UI can say so (already translated text). Absent or null if it went well. */
  error?: string | null
}
// ── end of branch map ──

// ── Main checkout branch ──
/** A local branch of the project, for the branch menu and for choosing a worktree's starting point. */
export interface LocalBranch {
  name: string
  /** Date (ms) and title of the last commit. */
  at: number
  subject: string
  /** It is the branch checked out in the main checkout. */
  current: boolean
  /** Folder of the worktree that checked it out (not the main checkout): git forbids checking it out elsewhere too. Null if free. */
  worktree: string | null
}

/** Answer of `project.branches`. */
export interface ProjectBranches {
  projectId: string
  /** Branch of the main checkout; null with detached HEAD. */
  current: string | null
  /** Local branches, most recent last commit first. */
  branches: LocalBranch[]
  /** Files with uncommitted changes in the main checkout (untracked too). */
  dirty: number
  /** Main checkout session (not in a worktree) with a turn or sub-agents at work: while it exists, the branch change is rejected. */
  busy: { sessionId: string; title: string } | null
  /** Folder where this project's worktrees end up (with `~` in place of the home folder), to show in the new chat. */
  worktreesFolder: string
}

/** Answer of `project.branch.switch` and `project.branch.create`. */
export interface BranchSwitchResult {
  branch: string
  /** Message of the stash created before the switch (`git stash push -u`); null if there was none. */
  stash: string | null
}
// ── end of main checkout branch ──

// ── Push and merge ──
export type PrMergeMethod = 'merge' | 'squash' | 'rebase'

/** Preview from `git.push.preview`. */
export interface GitPushPreview {
  branch: string
  /** Remote the push would go to; null if missing (see `problem`). */
  remote: string | null
  /** Remotes of the repository (`git remote`): to let the user choose when `problem` is 'choose-remote'. */
  remotes: string[]
  /** Current upstream, for example "origin/feat"; null if the branch is unpublished (or the upstream is gone). */
  upstream: string | null
  /** Exact push destination, for example "origin/feat" (`<remote>/<local branch>`); null if the remote is missing (see `problem`). */
  target: string | null
  /** The current upstream points elsewhere (another branch name or another remote): it is NOT the destination and after the push becomes `target`. Otherwise null. */
  upstreamElsewhere: string | null
  /** Full sha of HEAD at preview time: the UI sends it back in `git.push.expectedHead`. '' if the branch has no commits. */
  head: string
  /** The push sets the upstream to `target` (`-u`): unpublished branch, or one with the upstream elsewhere. */
  willPublish: boolean
  /** Up to 50 commits that would be sent, most recent first. */
  commits: { hash: string; subject: string }[]
  /** Total number of commits to send (may exceed commits.length). */
  total: number
  /** Upstream commits the branch does not have (as of the last fetch): if > 0 and total > 0 the push would be rejected. */
  behind: number
  /** The push would be rejected because it is not a fast-forward (behind > 0 and total > 0): the upstream must be integrated first. */
  wouldBeRejected: boolean
  /** no-remote: the repo has no remote. choose-remote: several remotes and no upstream, `remote` is needed. */
  problem: 'no-remote' | 'choose-remote' | null
}

/** Answer of `git.push`. */
export interface GitPushResult {
  branch: string
  remote: string
  /** Commits sent (counted before the push against the upstream or, when publishing, against what the remote does not have). */
  pushed: number
  /** Upstream after the push, for example "origin/feat". */
  upstream: string
  /** The branch was published by this push (it had no upstream before). */
  published: boolean
}

/** Answer of `pr.merge`. */
export interface PrMergeResult {
  number: number
  method: PrMergeMethod
  /** PR reread after the merge (normally state 'merged'); null if gh did not return it. */
  pr: PrStatus | null
  /** Remote branch deleted (only if requested with `deleteBranch`). */
  branchDeleted: boolean
  /** Why the remote branch was not deleted, if requested and failed (the merge succeeded anyway). */
  branchDeleteError: string | null
}

/** Answer of `git.archive`. */
export interface GitArchiveResult {
  /** The session was archived. */
  archived: true
  worktreeRemoved: boolean
  /** Why the worktree stayed: 'none' (the session has no worktree), 'shared' (another session uses it), 'dirty' (uncommitted files), 'failed' (git refused). The branch always stays. */
  worktreeKept: 'none' | 'shared' | 'dirty' | 'failed' | null
  /** 'failed': why git did not remove it (stderr cleaned and shortened); otherwise absent or null. */
  worktreeError?: string | null
}

/** What prevents merging the PR, in priority order (the first is the reason shown in the Merge tooltip). */
export type MergeBlockKind = 'draft' | 'conflicts' | 'ci_failing' | 'ci_pending' | 'changes_requested' | 'review_required' | 'behind' | 'blocked'

export interface MergeBlock {
  kind: MergeBlockKind
  /** conflicts: conflicting files; ci_failing / ci_pending: number of checks. */
  count?: number
}

/** Next step of the panel: Commit → Push/Publish → Create PR → Merge → Archive. */
export type NextActionKind = 'commit' | 'push' | 'publish' | 'create_pr' | 'merge' | 'archive' | 'none'

/**
 * Why the step is disabled (`blocked`) or the explanation of 'none'/'create_pr':
 * detached (detached HEAD), default_branch (no PR on the default branch), no_remote, no_commits (nothing relative to the base),
 * github_missing / github_unauthenticated / no_github_remote / github_error (gh not ready), pr_closed (the previous PR is closed:
 * another one is opened), behind_upstream (the upstream has commits the branch does not: the push would be rejected), agent_busy (the agent
 * is working), dirty / unpushed (Archive with changes or unpushed commits), or the first MergeBlockKind.
 */
export type NextActionReason =
  | 'detached' | 'default_branch' | 'no_remote' | 'no_commits' | 'github_missing' | 'github_unauthenticated' | 'no_github_remote' | 'github_error'
  | 'pr_closed' | 'behind_upstream' | 'agent_busy' | 'dirty' | 'unpushed'
  | MergeBlockKind

export interface NextAction {
  kind: NextActionKind
  /** The main button is disabled (with `reason` in the tooltip). 'none' is always blocked. */
  blocked: boolean
  reason: NextActionReason | null
}
// ── end of push and merge ──

/** Answer of `text.pr`. `body` already includes the link to the issue ("Closes …" line) if there is one. */
export interface GeneratedPr {
  title: string
  body: string
  /** Linked issue: from the session's source or mentioned in the first message; null if none. */
  issue: { ref: string; url: string | null } | null
  /** Base branch of the comparison. */
  base: string
  files: number
  truncated: GeneratedTextCut | null
}
// ── end of text written by a model ──

// ── CLI ──

/**
 * Outcome of session.wait. completed / error / interrupted: as in the last turn. needs-user: stopped on a reply from you
 * (`waitingLabel` says which). timeout: still working when time ran out. idle: no turn run yet.
 */
export interface SessionWaitResult {
  sessionId: string
  status: 'completed' | 'error' | 'interrupted' | 'needs-user' | 'timeout' | 'idle'
  /** Last assistant text in the most recent turn; null if there is none. */
  text: string | null
  error: string | null
  waitingLabel: string | null
  /** Seq of the last chat item at the time of the answer. */
  seq: number
}

/** A chat line as `ladder attach` sees it at the start: id and how much it holds (see session.transcript). */
export interface TranscriptMark {
  id: string
  mark: number
}

export interface CliStatus {
  /** The `ladder` link installed by Ladder exists and points to this app's script. */
  installed: boolean
  /** Where the link is (or would go), for example ~/.local/bin/ladder. */
  path: string
  /** The link's folder is in the login shell's PATH; if not, the UI explains how to add it. */
  inPath: boolean
  /** Local socket on which the host listens for the CLI; null if it is not listening. */
  socket: string | null
}

