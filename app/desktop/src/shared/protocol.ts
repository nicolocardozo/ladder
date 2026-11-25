import type { FileKind } from './file-type'
import type { Locale } from './i18n'
import type { Keybinding, ShortcutPreset } from './shortcuts'
// Tipi condivisi tra host delle sessioni, processo main e renderer.
// L'host è la fonte di verità: il renderer riceve progetti, sessioni ed elementi della chat già pronti.

/** Agenti in chat: i due nativi e quelli ACP, con l'id della loro voce (`acp:gemini`). */
export type AgentId = 'claude-code' | 'codex' | `acp:${string}`

/** Voce di un agente ACP: basta un comando. Dal registro ufficiale o scritta a mano. */
export interface AcpAgentSpec {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  source: 'registry' | 'custom'
  /**
   * Come parte l'agente: `npx`/`uvx` (pacchetto del registro), `binary` (scaricato da Ladder in `<dati>/bin/<id>`,
   * `command` è il percorso assoluto), `path` (CLI già installata, `command` è il suo percorso). Assente: voce scritta a mano.
   */
  distribution?: 'npx' | 'uvx' | 'binary' | 'path'
  version?: string | null
  description?: string | null
  /** Icona dal registro, scaricata all'aggiunta e salvata come data URL (SVG). */
  icon?: string | null
}

// ── Catalogo agenti ACP, rilevamento e installazione (LAD-56) ────────────────

/**
 * Stato di un agente del catalogo su questo Mac:
 * - detected: trovato; un eseguibile con il nome atteso è nel PATH della shell di login (Ladder non verifica che sia proprio quell'agente), oppure l'ha già scaricato Ladder.
 * - downloadable: non c'è ancora ma Ladder la può avere: binario con checksum verificabile (`agents.install`),
 *   oppure pacchetto npx/uvx (si avvia con `agents.add`, il pacchetto si scarica al primo avvio).
 * - unavailable: non si può avere da Ladder; `reason` dice perché (nessuna build per questo Mac, nessun checksum, npx/uvx assente).
 */
export type AgentCatalogState = 'detected' | 'downloadable' | 'unavailable'

/** Metodo di accesso dichiarato dall'agente in `initialize` (authMethods di ACP). */
export interface AgentAuthMethod {
  id: string
  name: string
  description: string | null
  /**
   * - agent: l'accesso lo fa l'agente (Ladder lo chiede via `authenticate`); è anche il caso di un metodo senza `type` (predefinito di ACP).
   * - terminal: serve un terminale interattivo (non ancora supportato).
   * - unsupported: ogni altro tipo dichiarato dall'agente (es. `env_var`): Ladder non sa farlo, quindi la UI NON mostra un
   *   pulsante "Sign in" per questi, al massimo il nome come informazione. `agents.authenticate` li rifiuta.
   * (Il campo si chiama `type`, non `kind`.)
   */
  type: 'agent' | 'terminal' | 'unsupported'
}

/**
 * Login di un agente ACP, solo da ciò che il protocollo ha detto in una sessione reale:
 * - unknown: Ladder non ha ancora avviato l'agente: non si sa. Non è "non collegato".
 * - ready: l'agente ha aperto una sessione senza chiedere l'accesso (anche se non dichiara metodi: `methods` può essere vuoto).
 * - required: l'agente ha risposto auth_required; `methods` dice come accedere.
 * `methods` resta quello dell'ultimo `initialize`. `checkedAt` in millisecondi, null se unknown.
 */
export interface AgentLogin {
  state: 'unknown' | 'ready' | 'required'
  methods: AgentAuthMethod[]
  checkedAt: number | null
}

/**
 * LAD-79: stato di accesso di un altro agente (Gemini CLI, Copilot, Cursor, OpenCode e simili; non Claude, Codex e GitHub).
 * - connected: l'agente ha aperto una sessione di prova (ACP `session/new`) senza chiedere l'accesso.
 * - needs-login: l'agente ha risposto auth_required.
 * - unknown: non si sa: mai provato, CLI assente, non si prova (npx/uvx) o la prova è fallita (timeout, programma che non parla ACP).
 */
export type OtherAgentAuth = 'connected' | 'needs-login' | 'unknown'

/**
 * Riga di "Altri agenti" nelle Subscription: un agente ACP curato (rilevato o no) o aggiunto dall'utente, escluse le righe
 * di Claude, Codex e GitHub. `id` è l'id del registro, lo stesso di AgentCatalogEntry e di `agent.login`.
 * L'elenco contiene sempre gli agenti curati (anche non installati, `installed: false`) e quelli aggiunti.
 */
export interface OtherAgentConnection {
  id: string
  name: string
  /** Icona come data URI (solo se l'agente è aggiunto e il registro l'ha data), altrimenti null. */
  icon: string | null
  /** Già in "I tuoi agenti" (AgentStatus acp:<id>). Gli agenti non aggiunti si aggiungono da Agents come oggi. */
  added: boolean
  /**
   * program: c'è un programma locale (CLI nel PATH della shell di login o binario scaricato da Ladder) che Ladder può lanciare;
   * npx / uvx: l'agente aggiunto parte da npx o uvx, senza CLI locale. Questi NON si provano mai (una prova scaricherebbe il pacchetto):
   * `installed` è false, `auth` unknown, nessun comando di accesso.
   */
  runner: 'program' | 'npx' | 'uvx'
  /** Il programma c'è (runner program e file presente). Non conferma che sia davvero quell'agente: vedi AgentCatalogEntry.detected. */
  installed: boolean
  /** Percorso del programma; null se non installato. Solo da mostrare (non serve per lanciare nulla). */
  path: string | null
  /** Da `--version` (4 secondi di tempo); null se ignota. */
  version: string | null
  auth: OtherAgentAuth
  /**
   * Account collegato. ACP non ha un campo standard per l'account e Ladder non legge mai i file delle CLI: oggi è sempre null,
   * il campo c'è perché la UI lo mostri se un agente lo dirà (nessuna UI deve contare su di esso).
   */
  account: string | null
  /** Quando l'ultima prova (o l'ultimo `agent.login` da una sessione) ha dato `auth`, in millisecondi; null se mai. */
  checkedAt: number | null
  /** Una prova è in corso: `auth` e `checkedAt` sono quelli di prima. */
  probing: boolean
  /**
   * Comando per accedere, da mostrare e da lanciare con `agents.others.login` (es. `copilot login`, `cursor-agent login`, `gemini`).
   * null = Ladder non conosce un comando di accesso certo per questa CLI: la UI mostra «Apri terminale» (`agents.others.login`
   * apre allora la CLI da sola, `openCommand`, e l'utente accede da lì). Anche null se l'agente non è installato.
   */
  loginCommand: string | null
  /** La CLI da sola (es. `gemini`), che `agents.others.login` apre se `loginCommand` è null. null se non installato o se il programma è solo un adattatore ACP (es. `amp-acp`): non c'è una CLI da aprire e l'accesso si fa dall'app o dalla CLI dell'agente. */
  openCommand: string | null
  /** Comando per uscire (es. `cursor-agent logout`), solo dove la CLI ne ha uno; si lancia con `agents.others.logout`. */
  logoutCommand: string | null
  /** Se `logoutCommand` è null: testo (inglese/italiano già tradotto) che spiega come scollegarsi, oppure null se non c'è niente di noto. */
  logoutHelp: string | null
  /** Terminale con un accesso o un'uscita in corso (da aprire nella UI); null se non ce n'è. */
  terminalId: string | null
}

/**
 * Da dove arriva il checksum che Ladder verifica prima di avviare un binario scaricato:
 * - registry: `sha256` nella voce del registro.
 * - github-release: archivio di una release GitHub; il checksum è il `digest` della release (letto all'installazione).
 * - missing: nessun checksum verificabile; Ladder NON scarica (si installa dal sito del vendor, `installUrl`).
 * Anche per `github-release` il checksum può risultare non disponibile alla lettura: vedi `AgentCatalogEntry.download`.
 */
export type AgentChecksumSource = 'registry' | 'github-release' | 'missing'

/**
 * Perché Ladder non scarica o non installa un binario (codice stabile per la UI, il testo è già tradotto):
 * - no-checksum: nessun checksum verificabile (il registro non lo dà e la release GitHub non pubblica il `digest` dell'asset); non si scarica (si installa dal sito del vendor, `installUrl`).
 * - checksum-unavailable: la release GitHub è raggiungibile in teoria ma ORA non si è riusciti a leggere il checksum (rete, limite di richieste). Stato transitorio: la voce è `unavailable` con "riprova più tardi" e NESSUNA conferma si offre; un nuovo `agents.catalog` (dopo qualche minuto) riprova.
 * - host: l'archivio sta su un indirizzo che Ladder non si aspetta per questo agente (non https, dominio non quello del vendor, redirect altrove).
 * - checksum-conflict: la stessa versione è già stata scaricata da Ladder con un checksum diverso da quello che il registro dà ora. `agents.install` RIFIUTA (la promessa è rifiutata con il solo testo dell'errore, prima di rispondere: il codice NON è nel rifiuto) e il codice arriva con l'evento `agent.install` di errore (`errorCode`), che parte prima del rifiuto.
 * - too-large: archivio o contenuto estratto oltre i limiti (archivio 600 MiB, estratto 2 GiB, 50.000 voci).
 * - signature: il binario è firmato ma la firma non regge (`codesign --verify --deep --strict`), oppure (curati scaricabili) il registro punta a un programma diverso da quello che Ladder si aspetta per l'agente (`cmd` fissato in Ladder, ad esempio il `java` del JDK dentro un'app): testo "points this agent to a different program", dall'installazione e in `download.blocked`/`reasonCode` del catalogo. Testo della firma: "is signed, but its signature does not verify".
 * - team: agente curato con team fissato in Ladder (OpenCode, Kiro, Junie) il cui binario arriva non firmato, firmato ad hoc o firmato da un altro sviluppatore (il controllo lo fa codesign sul certificato). Testo: "not signed by the developer Ladder expects". Distinto da `signature` (firma rotta).
 * - checksum-changed: il checksum, l'indirizzo o la richiesta di conferma (checksum e indirizzo di una seconda richiesta diversi da quelli del download già in corso) non coincidono con quelli che l'utente ha visto nel dialog. `agents.install` RIFIUTA (promessa rifiutata, con il solo testo, prima di rispondere) e l'evento `agent.install` di errore porta questo `errorCode`: la UI riapre la conferma con i dati riletti dal catalogo (da rileggere), non ripete lo stesso tentativo.
 * - quarantine: macOS ha messo il download in quarantena e non partirebbe (Ladder non toglie l'attributo).
 */
export type AgentBlockCode = 'no-checksum' | 'checksum-unavailable' | 'host' | 'checksum-conflict' | 'too-large' | 'signature' | 'team' | 'checksum-changed' | 'quarantine'

/**
 * Firma del codice di un binario installato, letta da `codesign` dopo l'estrazione e prima dello spostamento:
 * - signed: firma integra E certificato verificato come Apple Developer ID (catena fino alla radice Apple, foglia Developer ID Application) o firma Apple di sistema; `signer` è l'Authority della foglia (es. "Developer ID Application: Nome (TEAM)") e `team` il TeamIdentifier.
 * - unverified: firma integra (`codesign --verify` passa) ma il firmatario NON è verificato come Apple Developer ID: certificato autofirmato, catena non Apple o foglia che non è Developer ID. `signer` e `team` sono null di proposito (il nome dentro il certificato lo può scrivere chiunque): la UI NON deve mostrare "Signed by …", solo "Signature intact, signer not verified".
 * - adhoc: firma ad hoc (senza identità, come quella del linker su arm64): integra ma non dice chi l'ha prodotto. `signer` e `team` null.
 * - unsigned: nessuna firma; si installa lo stesso e la UI lo segnala.
 * `signer` e `team` vengono dal certificato foglia della firma (già verificato), non dal testo di `codesign -d` (l'Identifier lo sceglie chi firma).
 * Un binario firmato la cui verifica fallisce non si installa (AgentBlockCode `signature`). Per gli agenti curati con team fissato in
 * Ladder (OpenCode, Kiro, Junie) solo `signed` dal team atteso si installa; ogni altro esito è `team`.
 */
export interface AgentSignature {
  state: 'signed' | 'unverified' | 'adhoc' | 'unsigned'
  signer: string | null
  team: string | null
}

/** Un agente del catalogo: i curati in cima, poi il resto del registro in ordine alfabetico. */
export interface AgentCatalogEntry {
  /** Id del registro ("gemini", "cursor", "github-copilot-cli"…); l'agente in chat è `acp:<id>`. */
  id: string
  name: string
  description: string
  /** Versione fissata dal registro (quella che `agents.install` scarica). */
  registryVersion: string
  /** Nell'elenco curato (11 agenti, in quest'ordine); false per il resto del registro. */
  curated: boolean
  state: AgentCatalogState
  /** Perché `unavailable` (già tradotto); null altrimenti. */
  reason: string | null
  /** Già in "I tuoi agenti" (AgentStatus acp:<id>). */
  added: boolean
  /** Pagina dell'agente (sito, altrimenti repository), solo https: "link alla procedura". Null se il registro non la dà. */
  docsUrl: string | null
  /** Come parte su questo Mac, secondo il registro (arm64): null se nessuna distribuzione utilizzabile. */
  distribution: 'binary' | 'npx' | 'uvx' | null
  /**
   * Pagina del vendor con la procedura di installazione (https). Per i curati è fissata in Ladder, per gli altri è il sito
   * (altrimenti il repository) dichiarato dal registro; null se non ce n'è. Con `reasonCode` `no-checksum` è il link da mostrare.
   */
  installUrl: string | null
  /** Se `reason` è uno dei casi di AgentBlockCode, quale; null altrimenti. */
  reasonCode: AgentBlockCode | null
  /**
   * Solo se `distribution` è binary e c'è un checksum verificabile: tutto quello che serve al dialog di conferma.
   * - checksum: da dove viene; sha256: il checksum completo in esadecimale. La UI offre la conferma (installa/aggiorna) SOLO se
   *   `sha256` non è null E `blocked` è null: un `agents.install` senza checksum non esiste. `sha256` è null per una release GitHub
   *   quando non si è riusciti a leggerlo ora (`blocked: 'checksum-unavailable'`, voce `unavailable`) o quando la release non lo
   *   pubblica (`blocked: 'no-checksum'`, voce `unavailable` con `reasonCode` `no-checksum` e `installUrl`, come Cursor). In `agents.detect` (che non legge le release) può essere null senza che sia un blocco.
   * - host: da cui si scarica, minuscolo (è quello che `agents.install` deve rimandare uguale). Per github.com è `github.com/<proprietario>/<repository>` (da mostrare così nel dialog); per gli altri solo l'host; size: byte dell'archivio da HEAD/Content-Length con timeout (null se ignota: non blocca niente);
   * - blocked: se Ladder rifiuterebbe questo download (l'installazione fallirebbe con lo stesso codice): 'host', 'checksum-conflict', 'no-checksum' o 'checksum-unavailable'.
   * Per mostrare la versione, il nome e la dimensione: `registryVersion`, `name`, `size`.
   */
  download: { checksum: AgentChecksumSource; sha256: string | null; host: string; size: number | null; blocked: AgentBlockCode | null } | null
  /**
   * Eseguibile con il nome atteso trovato nel PATH della shell di login (solo agenti curati): il nome può essere di un altro programma,
   * quindi `path` è un "trovato" e non una conferma. `version` da `--version` solo in `agents.catalog` (con 4 secondi di tempo); in `agents.detect` è sempre null.
   */
  detected: { path: string; version: string | null } | null
  /**
   * Binario scaricato da Ladder; `updateAvailable`: il registro ha una versione diversa. Nessun aggiornamento automatico.
   * `signature`: esito di codesign alla sua installazione; null se non è noto (installato prima di questo controllo).
   */
  installed: { version: string; updateAvailable: boolean; signature: AgentSignature | null } | null
  login: AgentLogin
  /** Installazione in corso, se c'è. */
  install: AgentInstall | null
}

/**
 * Installazione (o aggiornamento) di un binario. `stage` riusa le fasi di ConnectionStage: downloading (il checksum si
 * verifica a fine download), installing (estrazione), verifying (il programma sta dentro la cartella dell'agente e non è
 * in quarantena), finishing (scambio della cartella). `state` done/error/cancelled chiudono l'operazione.
 */
export interface AgentInstall {
  id: string
  version: string
  state: 'running' | 'done' | 'error' | 'cancelled'
  stage: ConnectionStage | null
  /** Da 0 a 1, solo in `downloading`; null se la dimensione non è nota. */
  progress: number | null
  bytes: number | null
  total: number | null
  /** Errore già tradotto (checksum errato, nessun checksum, archivio non sicuro…); null se non c'è. */
  error: string | null
  /** Se l'errore è uno dei blocchi di sicurezza (AgentBlockCode), quale; null altrimenti. */
  errorCode: AgentBlockCode | null
  /**
   * Firma del binario, nota da `verifying` in poi (a installazione finita resta qui e in `AgentCatalogEntry.installed.signature`).
   * La conferma dell'utente precede il download, quindi la firma si mostra dopo l'installazione: un binario `unsigned` si installa comunque.
   */
  signature: AgentSignature | null
}
/** Chat: l'agente parla con Ladder. Terminale: la CLI originale gira in un PTY. */
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
  /** Profilo scelto per questo progetto, per agente. Assente = profilo predefinito (LAD-23). */
  profiles?: Partial<Record<ProfileAgent, string>>
}

/** Agenti che hanno un account: Claude Code e Codex. */
export type ProfileAgent = 'claude-code' | 'codex'

/**
 * Un account con nome ("Lavoro", "Personale") per un agente, con la sua cartella di configurazione
 * (`CLAUDE_CONFIG_DIR` per Claude Code, `CODEX_HOME` per Codex). Il profilo predefinito (`isDefault`) non ha cartella
 * di Ladder: usa quella della CLI (~/.claude, ~/.codex) e c'è sempre, uno per agente. Id del predefinito: `default:<agent>`.
 */
export interface Profile {
  id: string
  agent: ProfileAgent
  name: string
  /** Cartella di configurazione gestita da Ladder; null nel profilo predefinito. */
  configDir: string | null
  isDefault: boolean
  addedAt: number
}

/** Stato dell'esecuzione: deriva dall'agente, non dalla UI. Nessun limite di sessioni attive (LAD-67): un turno parte sempre subito. */
export type RunState = 'idle' | 'starting' | 'running' | 'waiting' | 'error'

/** Allegato inviato all'agente. Per ora solo immagini, in base64. */
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

/** Da dove viene il titolo: provvisorio (dal primo messaggio), generato da un modello piccolo, scelto dall'utente. */
export type TitleSource = 'provisional' | 'generated' | 'user'

export interface SessionSummary {
  id: string
  projectId: string
  title: string
  /** 'user' vince su ogni generazione automatica; "Rigenera titolo" lo riporta a 'generated'. */
  titleSource: TitleSource
  /** Un titolo è in corso di generazione (automatica o richiesta): la UI può mostrare un indicatore. */
  titleGenerating?: boolean
  agent: AgentId
  /** Profilo con cui gira la sessione (solo Claude Code e Codex); assente = predefinito. Fissato alla creazione. */
  profileId?: string | null
  model: string | null
  effort: Effort | null
  /** Effort davvero in uso quando la sessione non ne ha scelto uno, se l'agente lo comunica (init). */
  effortEffective?: Effort | null
  permission: PermissionLevel
  /** Livello chiesto che vale dal prossimo turno (Codex a turno in corso); null se nessuno in attesa. */
  permissionNext?: PermissionLevel | null
  createdAt: number
  updatedAt: number
  run: RunState
  /** Etichetta breve quando la sessione aspetta l'utente: "Approvazione", "Domanda". */
  waitingLabel: string | null
  /** Testo dell'attività corrente mentre lavora: "Esegue pnpm test". */
  activity: string | null
  unread: boolean
  /**
   * Avviso dei sotto-agenti in background finiti dall'ultima volta che hai aperto la sessione:
   * stato in sidebar e badge del Dock. Si azzera con session.open / session.read.
   */
  agentsNotice?: { finished: number; failed: number; at: number } | null
  /** Ultimo elemento letto: il primo non letto è lastReadSeq + 1. */
  lastReadSeq: number
  archived: boolean
  queue: QueuedMessage[]
  context: {
    /** Token nel contesto adesso (ultima chiamata del loop principale), non la somma del turno. */
    used: number
    window: number
    /** Token a cui scatta la compattazione automatica; null se disattivata, assente se non nota. Il colore dell'indicatore segue questa soglia. */
    compactAt?: number | null
  } | null
  mode: SessionMode
  /** Cartella in cui lavora la sessione: il checkout principale o il suo worktree. */
  cwd: string
  worktree: WorktreeInfo | null
  /** Sessione terminale: comando avviato (claude, codex, …) e terminale che lo ospita. */
  command: string | null
  terminalId: string | null
  /** Lo stato viene da euristiche (output, campanello), non da segnali dell'agente. */
  estimated: boolean
  /** Da quando la sessione aspetta l'utente: ordina "In attesa" e ⌘⇧A per anzianità. */
  waitingSince: number | null
  /** Richiesta aperta più vecchia, per rispondere da "In attesa" senza aprire la sessione. */
  request: RequestItemData | null
  /** Richieste aperte (di solito una; più di una con strumenti in parallelo). */
  openRequests: number
  /** Ultima attività dell'agente (fine turno, errore): decide "Concluse" e "Mentre eri via". */
  activityAt: number
  /**
   * L'agente accetta messaggi dentro il turno in corso (Claude: messaggio nello stream
   * di input, inserito tra un giro di strumenti e l'altro; Codex: turn/steer). ACP: false.
   */
  canSteer: boolean
  /** Branch su cui lavora la sessione: quello del worktree o del checkout principale. */
  branch: string | null
  /** Stato della PR del branch, se c'è (da gh). */
  pr: PrStatus | null
  /** Da dove è nata la sessione: issue, PR o branch. */
  source: SessionSource | null
  /** Sotto-agenti dell'ultimo turno e quelli ancora vivi: la mappa degli agenti. */
  /**
   * Conteggi leggeri dei sotto-agenti, nel summary. L'elenco completo NON viaggia più
   * qui: arriva con l'evento session.subagents (e con la richiesta subagent.list).
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
}

/** Un sotto-agente avviato dalla sessione (Task di Claude Code, spawnAgent di Codex). */
export interface SubagentInfo {
  /** Id stabile: il tool_use di Claude Code o il thread del sotto-agente di Codex. */
  id: string
  /** Sotto-agente che l'ha avviato; null se l'ha avviato la sessione. */
  parentId: string | null
  /** Compito in breve: "Explore the auth module". */
  title: string
  /** Tipo di agente: "general-purpose", "Explore", "worker". */
  kind: string | null
  /** Modello reale o scelto; null se non noto: la UI mostra quello della sessione come ereditato. */
  model: string | null
  /** Effort chiesto per il sotto-agente; null se eredita o non noto. */
  effort?: Effort | null
  /** Id della riga 'tool' in chat che l'ha lanciato (per Claude coincide con id; per Codex è l'item collab). */
  toolId?: string | null
  status: 'running' | 'done' | 'error' | 'stopped'
  startedAt: number
  endedAt: number | null
  /** Cosa sta facendo adesso: l'ultimo strumento o il riassunto dell'agente. */
  activity: string | null
  tokens: number | null
  toolUses: number | null
  /** Continua in background mentre la sessione va avanti. */
  background: boolean
}

/**
 * Dettaglio pesante di un sotto-agente, solo a richiesta (subagent.detail): nel
 * SessionSummary viaggiano solo i campi leggeri di SubagentInfo. Se la board non ha
 * più l'agente (turni precedenti, riavvio), l'host lo ricostruisce dalla riga 'tool'.
 */
export interface SubagentDetail {
  info: SubagentInfo | null
  prompt: string | null
  /** Report finale in markdown; null finché l'agente lavora o se non c'è. */
  report: string | null
  /** Strumenti usati, dal più vecchio; al massimo gli ultimi 200. */
  tools: { name: string; title: string; status: 'running' | 'done' | 'error' | 'denied'; at: number }[]
}

export interface SessionSource {
  kind: 'github-issue' | 'github-pr' | 'linear' | 'branch'
  /** "#12", "LIN-42", nome del branch. */
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
  /** conflicts: il branch non si unisce senza conflitti alla base. */
  mergeable: 'clean' | 'conflicts' | 'unknown'
  review: 'approved' | 'changes' | 'pending' | null
  base: string
  updatedAt: number
  /** Quando è stata unita (LAD-80); null se non è unita o la data non c'è. Diverso da `updatedAt`, che un commento sposta. */
  mergedAt?: number | null
}

export interface WorktreeInfo {
  path: string
  branch: string
  /** Commit da cui è partito il worktree. */
  base: string
}

export interface FileChange {
  path: string
  /** Percorso prima della rinomina. */
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
  /** Ordine stabile all'interno della sessione. */
  seq: number
  at: number
}

export type ChatItem =
  | (ItemBase & {
      kind: 'user'
      text: string
      attachments?: { name: string; mediaType: string }[]
      /** Inserito nel turno in corso invece di aprirne uno nuovo. */
      steered?: boolean
    })
  | (ItemBase & { kind: 'assistant'; text: string; streaming: boolean })
  | (ItemBase & {
      kind: 'tool'
      tool: ToolKind
      /** Nome dello strumento dell'agente, per esempio Bash o Edit. */
      name: string
      /** Testo breve leggibile: "Esegue pnpm test", "Legge src/app.ts". */
      title: string
      /** Comando, percorso o pattern completo. */
      detail: string | null
      status: 'running' | 'done' | 'error' | 'denied'
      output: string | null
      endedAt: number | null
      /** Solo per tool 'agent': modello ed effort del sotto-agente, per mostrarli anche dopo il riavvio. */
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
      /** Tutti i file toccati quando sono più d'uno (patch di Codex); path è il primo. */
      paths?: string[]
      reason: string | null
      options: RequestOption[]
      questions: Question[] | null
      state: 'open' | 'resolved' | 'expired'
      /** Testo che descrive la risposta data: "Approvato", "Rifiutato: usa pnpm". */
      resolution: string | null
      /** Modifica proposta per Edit e Write, come righe con - e +. */
      preview?: { text: string; lines: number; truncated: boolean } | null
      /** Dove hai risposto: nella chat, da "In attesa" o dalla notifica. */
      via?: ResponseVia
    })
  | (ItemBase & {
      kind: 'turn-end'
      status: 'completed' | 'interrupted' | 'error'
      durationMs: number
      counts: { commands: number; edits: number; reads: number; searches: number }
      /** Turno finito senza modifiche, comandi, agenti né domande: "si è fermato senza chiedere nulla". Solo con HostPrefs.stallHint. */
      stalled?: boolean
      files: FileChange[]
      error: string | null
      costUsd: number | null
      /** Checkpoint git di inizio e fine turno: servono al diff e al ripristino. */
      checkpoints?: { start: string; end: string } | null
    })
  | (ItemBase & { kind: 'notice'; tone: 'info' | 'error'; text: string })
  /** Comando / eseguito dall'utente: riga di sistema, non messaggio utente. */
  | (ItemBase & { kind: 'command'; name: string; args: string; status: 'running' | 'done' | 'error' | 'interrupted'; error: string | null })
  /**
   * In testa a un turno aperto dall'agente senza messaggio dell'utente (turno implicito):
   * 'background-agents' se è ripartito dopo la fine di sotto-agenti in background (finished = quanti).
   */
  | (ItemBase & { kind: 'agent-start'; reason: 'background-agents' | 'other'; finished: number | null })
  /**
   * Fine dell'ultimo sotto-agente in background con il coordinatore fermo. state 'waiting':
   * l'agente non è ripartito da solo entro qualche secondo, la UI mostra "Continue" che invia
   * session.continue; 'resumed': è ripartito da solo (turno implicito); 'continued': l'utente ha
   * premuto Continue o ha scritto; 'dismissed': superato da un altro turno.
   */
  | (ItemBase & { kind: 'agents-finished'; finished: number; failed: number; state: 'waiting' | 'resumed' | 'continued' | 'dismissed' })
  /** Contesto compattato (da /compact o automatico). Il testo lo compone la UI. */
  | (ItemBase & { kind: 'compacted'; trigger: 'manual' | 'auto'; preTokens: number | null; postTokens: number | null })
  /** Handoff of the work to another agent. See HandoffItem. */
  | (ItemBase & HandoffItem)
  /** Card for /advisor (one agent) or /committee (several agents). See AdviceItem. */
  | (ItemBase & AdviceItem)
  /** Resume card for an interrupted delegation. See ResumeItem. */
  | (ItemBase & ResumeItem)
  /** Plan limit reached or reset. See LimitItem. */
  | (ItemBase & LimitItem)

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
 * Comando / dichiarato dall'agente della sessione. I comandi di Ladder
 * (/model, /effort, /new) non passano di qui: li definisce e li gestisce la UI.
 * - claude-code: supportedCommands() e commands_changed (builtin, .claude/commands, skill).
 * - codex: fissi compact e review, più le skill di skills/list.
 * - acp: available_commands_update.
 */
export interface SlashCommand {
  /** Senza "/". */
  name: string
  description: string
  /** Suggerimento per gli argomenti; null se il comando non ne prende. */
  hint: string | null
  source: 'builtin' | 'custom' | 'skill'
  aliases?: string[]
}

export type RequestResponse = { optionId: string; message?: string } | { answers: Record<string, string> }
export type ResponseVia = 'chat' | 'inbox' | 'notification'
export type RequestItemData = Extract<ChatItem, { kind: 'request' }>

/** Una finestra dei limiti del piano: quanto ne hai usato e quando si azzera. */
export interface UsageWindow {
  key: string
  minutes: number
  /** Limite riservato a una famiglia di modelli, per esempio Opus. */
  model: string | null
  percent: number | null
  /** Secondi Unix. */
  resetsAt: number | null
  state: 'ok' | 'warning' | 'limited'
  /** Nome già pronto quando la finestra non è una durata, per esempio un modello o l'uso extra. */
  label?: string
  /** Testo sotto la barra al posto del reset, per esempio "12,40 € di 50 €". */
  detail?: string
  /** Da dove viene il consumo della finestra, in punti percentuali del limite: "Claude Code 34", "Chat 2". */
  breakdown?: { label: string; percent: number }[]
}

export interface AgentStatus {
  agent: AgentId
  name: string
  kind: 'native' | 'acp'
  available: boolean
  version: string | null
  /** Account in uso, per esempio "Claude Ultra" o "ChatGPT Plus". */
  account: string | null
  /** Profilo di cui è lo stato (Claude Code e Codex); assente = predefinito. Ogni profilo ha account, limiti e modelli suoi. */
  profileId?: string
  /** Email dell'account, quando l'agente la espone: si vede in basso nella sidebar. */
  email?: string | null
  /**
   * `efforts`: livelli che il modello accetta; vuoto se non ne ha, assente se l'agente non lo dice.
   * `isDefault`: il modello che parte se la sessione non ne sceglie uno (al massimo uno per agente;
   * le righe alias tipo "default" non compaiono). Fonte: config dell'agente (settings di Claude,
   * config.toml di Codex), poi il default dichiarato dall'agente (resolvedModel, isDefault, currentValue).
   * `defaultEffort`: livello usato se la sessione non ne sceglie uno; null o assente se non noto.
   */
  models: { id: string; label: string; efforts?: Effort[]; isDefault?: boolean; defaultEffort?: Effort | null }[]
  error: string | null
  /** Finestre dei limiti, aggiornate da ogni sessione. */
  usage?: UsageWindow[]
  /** Quando i limiti sono stati letti l'ultima volta, in millisecondi. */
  usageAt?: number | null
  /** Limiti d'uso leggibili, quando l'agente li espone: "14% della finestra di 5 h · 11% settimanale". */
  limits?: string | null
  /** Percorso della CLI usata. */
  path?: string | null
  /** Icona dell'agente ACP (data URL); per i nativi la sceglie l'interfaccia. */
  icon?: string | null
}

export type InspectorTab = 'changes' | 'files' | 'history' | 'merge'
export type EditorId = 'cursor' | 'vscode' | 'zed' | 'xcode'
/** Quali editor esterni sono installati (risposta di `ladder:editors`, che prima aveva solo cursor e vscode). */
export type EditorAvailability = Record<EditorId, boolean>

/**
 * Predefiniti di una nuova sessione. Ogni campo assente o null eredita dal livello sotto.
 * Ordine di risoluzione (nel renderer): progetto (ProjectUiState.defaults), poi
 * [agents] default del TOML per il solo agente, poi globali (AppPrefs.defaults),
 * poi l'ultimo agente usato e i predefiniti dell'agente. Un valore non più valido
 * (agente assente o non ammesso, modello non in AgentStatus.models, effort non
 * supportato, permesso sopra il massimo del progetto) si ignora o si riduce.
 */
export interface SessionDefaults {
  agent?: AgentId | null
  /** Modello per agente: il modello ha senso solo con il suo agente. */
  models?: Partial<Record<AgentId, string>>
  efforts?: Partial<Record<AgentId, Effort>>
  permission?: PermissionLevel | null
}

/**
 * Profilo di sessione (LAD-60): una combinazione salvata per avviare una sessione con un clic. Non è il profilo account
 * di LAD-23 (`Profile`): quello dice con quale abbonamento gira l'agente, questo quali impostazioni si usano.
 * Si salva nelle preferenze dell'app (`AppPrefs.presets`), valgono in tutti i progetti.
 */
export interface SessionPreset {
  id: string
  /** Nome breve: "Revisione veloce", "Feature lunga". Unico, senza distinguere maiuscole. */
  name: string
  /** A cosa serve, in una o due frasi. Più avanti l'agente coordinatore potrà usarla per scegliere a chi delegare. */
  note?: string
  agent: AgentId
  /** Account (profilo di LAD-23) con cui avviare; assente = quello del progetto. Si ignora se non esiste più o non è dell'agente. */
  profileId?: string | null
  /** Modello e effort si applicano solo se l'agente li ha ancora; altrimenti vale il predefinito. */
  model?: string | null
  effort?: Effort | null
  permission: PermissionLevel
  /** Lavora in un nuovo worktree. */
  worktree: boolean
  /** Testo iniziale della bozza: compare nel composer, non parte da solo. */
  prompt?: string
}

/** Tasto che invia nei composer: Invio (⇧Invio va a capo) oppure ⌘Invio (Invio va a capo). */
export type SendKey = 'enter' | 'mod-enter'

export interface ProjectUiState {
  tabs: string[]
  activeTab: string | null
  /** Ancora di lettura per sessione: elemento in cima alla vista e scostamento in pixel. */
  scroll: Record<string, { itemId: string; offset: number }>
  /** Ispettore a destra (Modifiche, File, Cronologia) e pannello terminale in basso. */
  inspector?: { open: boolean; tab: InspectorTab }
  terminal?: { open: boolean; height: number; active: string | null; side?: 'bottom' | 'right'; width?: number }
  /** Editor esterno preferito per il progetto; assente = AppPrefs.editor. */
  editor?: EditorId
  /** Ultima volta che hai guardato il progetto con la finestra attiva: serve a "Mentre eri via". */
  seenAt?: number
  /** File aperti come tab, nell'ordine di apertura. */
  fileTabs?: { root: string; path: string }[]
  /** Gruppi di chat creati da te, nell'ordine in cui si vedono nella sidebar. */
  groups?: { id: string; name: string; collapsed?: boolean }[]
  /** Gruppo di ogni sessione raggruppata. */
  groupOf?: Record<string, string>
  /** Ultimo agente usato in chat nel progetto: la nuova chat lo propone. */
  lastAgent?: AgentId
  /** LAD-59: false spegne in questo progetto branch, commit e PR scritti dal modello (vale insieme a AppPrefs.generatedText). Assente = acceso. */
  generatedText?: boolean
  /** Predefiniti personali delle nuove sessioni in questo progetto (non committati). */
  defaults?: SessionDefaults
  /**
   * Profilo di sessione (`SessionPreset.id`) proposto dalla nuova chat di questo progetto; ignorato se non esiste più.
   * Il predefinito del progetto applica i valori ma non inserisce il prompt iniziale: quello entra in bozza solo scegliendo il profilo (selettore o ⌘K).
   */
  defaultPreset?: string
  /**
   * Sessioni affiancate nella vista del progetto: da 2 a 3 colonne, nell'ordine da sinistra a destra, e quella attiva
   * (la colonna che riceve le scorciatoie). Assente: una sola colonna. Gli id di sessioni sparite si ignorano alla lettura.
   */
  split?: { sessions: string[]; active: string }
  /** Ultima scelta della nuova chat in questo progetto: dove lavora la sessione e, con un worktree, da quale branch parte (assente = quello attuale). */
  newChat?: { worktree: boolean; baseBranch?: string | null }

  // ── Browser integrato (LAD-57) ──
  /** Tab browser aperte nel progetto, nell'ordine in cui si vedono: `id` è l'identità della tab, `url` l'ultimo indirizzo (si riapre lì al riavvio). */
  browserTabs?: { id: string; url: string; title?: string }[]
  /** Colonna browser a destra delle chat: aperta o no, pagina attiva (tab salvata o di un agente; sparita = la prima), larghezza scelta in px (assente = 40%). */
  browserColumn?: { open: boolean; active: string | null; width?: number }
  // ── Fine browser integrato ──

  // ── LAD-57 parte 2 ──
  /** Browser per l'agente in questo progetto: true/false scavalca AppPrefs.agentBrowser; assente = vale quello globale. Vale dalla prossima ripartenza dell'agente di ogni sessione (spento: subito). */
  agentBrowser?: boolean
  // ── Fine LAD-57 parte 2 ──

  // ── LAD-75 ──
  /** Proporzioni delle colonne affiancate, una per colonna in `split.sessions` (stesso ordine). Assente o di lunghezza diversa: parti uguali. */
  columnWidths?: number[]
  // ── Fine LAD-75 ──
}

/** Sezione della sidebar che raccoglie progetti, creata da te. */
export interface ProjectGroup {
  id: string
  name: string
  collapsed: boolean
  /** Progetti della sezione, nell'ordine in cui si vedono. */
  projectIds: string[]
}

/**
 * Gruppi di progetti, globali (non per progetto). Ogni progetto esistente compare una sola volta:
 * in una sezione o in `ungrouped`. L'host tiene lo stato coerente: un progetto nuovo entra in coda a `ungrouped`,
 * uno rimosso sparisce ovunque, quindi la UI non deve mai ripulire riferimenti orfani.
 */
export interface ProjectGroupsState {
  /** Sezioni nell'ordine in cui si vedono. */
  groups: ProjectGroup[]
  /** Progetti fuori da ogni sezione, nell'ordine in cui si vedono. */
  ungrouped: string[]
}

// ── Scorciatoie da tastiera ──────────────────────────────────────────────

/**
 * Stato delle scorciatoie, globale. L'host tiene keybindings.json nella cartella dati dell'app (formato di VS Code:
 * array di `{ key, command }`, `-comando` toglie quella predefinita; sono ammessi commenti e virgole finali) e il preset scelto.
 * Per applicarlo basta `applyShortcutConfig({ preset, overrides })` di shared/shortcuts.
 */
export interface ShortcutsState {
  preset: ShortcutPreset
  /** Voci valide del file, nell'ordine in cui compaiono: sono quelle da applicare sopra al preset. */
  overrides: Keybinding[]
  /** Voci ignorate (comando sconosciuto, scorciatoia non valida) o file illeggibile, già tradotti. Le voci restano nel file. */
  warnings: string[]
  /** Percorso assoluto di keybindings.json (può non esistere ancora). */
  file: string
  /**
   * Il file non è JSON valido (il messaggio è anche tra gli avvisi): `overrides` è l'ultimo stato letto bene
   * e il file non si tocca finché non lo correggi o lo ripristini.
   */
  invalid: boolean
}

// ── File, diff e cronologia ──────────────────────────────────────────────

export type GitStatusCode = 'M' | 'A' | 'D' | '?' | 'U'

export interface FileTree {
  root: string
  isGit: boolean
  /** Percorsi relativi: tracciati più non tracciati non ignorati. */
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
  /** Ora di modifica su disco: al salvataggio dice se nel frattempo qualcuno ha scritto il file. */
  mtimeMs: number
  /** LAD-70: per i file binari, tipo, dimensioni e URL per l'anteprima (vedi FileMedia). */
  media?: FileMedia | null
}

export type FileWriteResult = { ok: true; mtimeMs: number } | { ok: false; text: string; mtimeMs: number }

// ── LAD-70: anteprima di immagini, PDF e media ───────────────────────────
// I byte non passano dalla MessagePort: la UI li carica da un URL `ladder-file://<id>/<percorso>[?rev=<rev>]` (img, video, audio, iframe),
// servito dal main solo per le root note (progetto o worktree di sessione). `<id>` è l'id opaco che l'host dà con FileMedia.url;
// `rev` è HEAD o uno sha completo di git (checkpoint, commit): serve la versione di quella revisione invece del file su disco.
// Vedi shared/file-type.ts (fileUrl per costruire gli URL, isKnownRev) e main/file-protocol.ts.

export type { FileKind }

/** Descrizione di un file non di testo, per il viewer e il diff. */
export interface FileMedia {
  /** image: png, jpg, gif, webp, ico, avif, bmp; svg: da mostrare solo con <img>; other: fuori whitelist, niente anteprima. */
  kind: FileKind
  /** Tipo reale (dai primi byte), `application/octet-stream` per 'other'. */
  mime: string
  size: number
  /** Solo per le immagini raster che si leggono dall'intestazione (non avif, non svg): altrimenti null e la UI legge naturalWidth dall'<img>. */
  width: number | null
  height: number | null
  /** Ora di modifica del file su disco; null per una revisione di git. */
  mtimeMs: number | null
  /** URL ladder-file pronto per <img>/<video>/<audio>/<iframe>; null per 'other' (si può solo mostrare nel Finder). */
  url: string | null
}
// ── Fine LAD-70 ──────────────────────────────────────────────────────────

/** Ambito del pannello Modifiche. */
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
  /** Il lato "dopo" è lo stato attuale dei file: cambia mentre lavori. */
  live: boolean
}

export interface FilePatch {
  path: string
  oldPath: string | null
  /** Diff unificato di git, con 3 righe di contesto. */
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
  /** Titolo della sessione o autore del commit. */
  detail: string | null
  sessionId: string | null
  turnId: string | null
  /** Stato a cui si può tornare con "Ripristina". */
  sha: string
  /** Modifiche di questo punto. */
  diff: { from: string; to: string } | null
  files: number | null
}

// ── Terminali e configurazione del progetto ──────────────────────────────

export interface TerminalInfo {
  id: string
  projectId: string
  /** Sessione a cui appartiene: la sessione terminale stessa, o quella da cui è partita un'azione. */
  sessionId: string | null
  /**
   * shell: pannello in basso; run: azione di avvio o setup; agent: CLI di una sessione terminale;
   * service: comando lungo del worktree (`[[worktree.services]]`, LAD-66), avviato da Ladder, con `title` = nome del servizio.
   * Si ferma da solo (con tutto ciò che ha avviato) quando la sessione si archivia o il worktree si rimuove; dopo un riavvio
   * di Ladder torna `stopped` e `terminal.restart` lo rilancia. Non tiene viva la sessione per l'auto-archiviazione (è sempre acceso) e non conta come agente al lavoro; gli altri terminali in esecuzione sì.
   */
  kind: 'shell' | 'run' | 'agent' | 'service'
  title: string
  cwd: string
  command: string | null
  /** stopped: ripristinato dopo un riavvio di Ladder, il processo non c'è più. */
  state: 'running' | 'exited' | 'stopped'
  exitCode: number | null
  createdAt: number
  /** LADDER_PORT passato al processo. Per un servizio è la porta libera assegnata, dal blocco del worktree a partire da base + 1 (null se non la vuole). */
  port: number | null
}

/** Un comando lungo da avviare insieme al worktree (LAD-66), per esempio il server di sviluppo. */
export interface WorktreeService {
  /** Nome leggibile: è il titolo del terminale. Unico nel progetto; lo stesso nome nel file personale sostituisce quello del progetto. */
  name: string
  /** Eseguito da una shell di login nella cartella del worktree. Con `port` può usare $LADDER_PORT. Vuoto nel file personale = servizio tolto. */
  command: string
  /** `port` nel TOML, predefinito true: assegna al servizio una LADDER_PORT libera del blocco del worktree, da base + 1 (la base resta a setup, shell e [[run]]), diversa tra worktree e servizi. */
  port: boolean
  /**
   * Da quale file viene. project: solo `.ladder/settings.toml`; personal: solo `settings.local.toml`; both: definito nel progetto e
   * ridefinito (o disattivato) nel personale, che vince. Con `both` i campi sopra sono quelli del personale, tranne se `disabled`.
   */
  source: 'project' | 'personal' | 'both'
  /**
   * true: il file personale ha lo stesso nome con `command` vuoto, quindi il servizio del progetto è disattivato. Resta nell'elenco
   * (con command e port del progetto) ma l'host non lo avvia. Per riattivarlo basta togliere la voce vuota da `personalServices`.
   */
  disabled: boolean
  /** Il comando nel file del progetto, presente solo con `source: 'both'`: è quello che tornerebbe in vigore ripristinando il servizio. */
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
   * setup: script eseguito alla creazione del worktree, in un terminale "setup" della sessione (LADDER_PORT impostata).
   * setupWait (`setup_wait`, predefinito true): il primo messaggio parte a script finito; false: parte subito, lo script gira in parallelo.
   * archive: script di pulizia, eseguito quando la sessione col worktree si archivia e prima che Ladder rimuova il worktree (anche con archiveMerged). copy: percorsi da copiare in più
   * rispetto a `.worktreeinclude` (vedi `project.worktreeFiles`).
   * ports: quante porte consecutive (da LADDER_PORT, la base) ha un worktree; la base resta a setup, shell e [[run]], i servizi con `port` usano le altre in ordine
   * (da base + 1, quindi `ports - 1` servizi con porta): con `ports` = 1 e servizi con porta attivi `errors` lo segnala e quei servizi non partono (serve almeno 2). Lo slot di un worktree rimosso si libera e si riusa.
   * services (`[[worktree.services]]`, LAD-66): comandi lunghi che l'host avvia in un terminale `service` per servizio, alla creazione
   * del worktree dopo lo script di setup (con setupWait false lo script gira in parallelo alla sessione, ma i servizi partono comunque a setup finito;
   * se il setup esce con errore non partono, e la sessione riceve una nota). Si fermano prima dello script di pulizia (`archive`).
   * I due file TOML si fondono per nome del servizio: `services` è l'elenco già fuso (progetto, poi i soli-personali), con i servizi
   * disattivati inclusi (`disabled`), che l'host non avvia. Nello stesso file un nome ripetuto: vince l'ultimo.
   * personalServices: il contenuto attuale di `[[worktree.services]]` nel file personale, così com'è (comprese le voci con `command` vuoto,
   * che disattivano il servizio omonimo del progetto). È l'elenco che `WorktreeSettingsPatch.services` sostituisce per intero: la UI lo
   * modifica (aggiungi/modifica/rimuovi/disattiva = voce vuota/riattiva = togli la voce) e lo rinvia completo.
   * Voci non valide nel file personale (name o command mancanti, port non booleano, chiavi in più) non compaiono in `personalServices` e vengono
   * segnalate in `errors`; salvare `services` con voci simili nel file è RIFIUTATO con un errore che dice quale voce e perché (per non cancellarle in silenzio).
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
  /** [agents]: agenti ammessi (vuoto = tutti), agente proposto, livello di permesso massimo. */
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
  /** File letti, relativi alla radice del progetto. */
  sources: string[]
  errors: string[]
}

/** Solo i campi presenti cambiano. `setup` e `archive` null o vuoti = nessuno script. */
export interface WorktreeSettingsPatch {
  setup?: string | null
  archive?: string | null
  setupWait?: boolean
  copy?: string[]
  /**
   * SOSTITUISCE l'intero elenco `[[worktree.services]]` del file personale: la UI deve inviare l'elenco personale completo
   * (parti da `worktree.personalServices`), altrimenti le voci omesse si perdono. `port` assente = true. Per disattivare un servizio del
   * progetto: stesso nome e `command` vuoto; per riattivarlo, ometti la voce. Nome vuoto: il salvataggio è rifiutato (errore);
   * nome ripetuto: vince l'ultima voce, nella posizione della prima.
   */
  services?: { name: string; command: string; port?: boolean }[]
}

/**
 * Cosa si copia dal checkout principale in un worktree nuovo (LAD-58). `.worktreeinclude` nella radice del progetto ha la
 * sintassi di .gitignore (come in Claude Code) ed elenca i file da copiare; ne valgono solo quelli ignorati da git
 * (i tracciati ci sono già). Senza il file vale `.env*`. `files` sono percorsi relativi alla radice, `node_modules` escluso.
 */
export interface WorktreeFiles {
  source: 'file' | 'default'
  patterns: string[]
  files: string[]
}

/** Archivio SQLite dell'host (LAD-22). */
export interface DataInfo {
  /** Cartella dei dati di Ladder (database, impostazioni, scorciatoie). */
  dir: string
  dbPath: string
  dbBytes: number
  /** Copie nella cartella `backups` dei dati, la più recente prima. */
  backups: { path: string; bytes: number; at: number }[]
}

// ── Review con un altro agente ───────────────────────────────────────────

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
  /** Ambito rivisto, per collegare i commenti al diff giusto. */
  scope: DiffScope
  state: 'running' | 'done' | 'error' | 'cancelled'
  summary: string | null
  comments: ReviewNote[]
  error: string | null
  startedAt: number
}

// ── Ricerca, issue e merge ───────────────────────────────────────────────

export interface SearchHit {
  sessionId: string
  itemId: string
  /** Testo intorno alla corrispondenza. */
  snippet: string
  kind: 'message' | 'reply' | 'command' | 'file'
  at: number
}

/** Elemento da cui creare una sessione: issue o PR di GitHub, issue di Linear, branch. */
export interface IssueItem {
  source: SessionSource['kind']
  /** Numero della issue o PR, identificativo Linear o nome del branch. */
  ref: string
  title: string
  body: string | null
  url: string | null
  /** Branch da usare: quello della PR, quello suggerito da Linear, il branch scelto. */
  branch: string | null
  state: string | null
  updatedAt: number | null
}

export interface IssueList {
  items: IssueItem[]
  /** Perché la lista è vuota o parziale: gh mancante, nessun remote GitHub, chiave Linear assente. */
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
  /** Branch di destinazione: quello della PR o il predefinito del repository. */
  base: string | null
  isDefaultBranch: boolean
  /** File modificati e non committati. */
  dirty: number
  /** Commit del branch che la base non ha. */
  ahead: number
  behind: number
  /** Commit non ancora pubblicati sul remote; null se il branch non ha upstream. */
  unpushed: number | null
  hasUpstream: boolean
  /** File in conflitto se unisci la base, calcolato senza toccare la cartella. */
  conflicts: string[]
  gh: 'ok' | 'missing' | 'unauthenticated' | 'no-remote' | 'error'
  ghError: string | null
  pr: PrStatus | null
  checks: MergeCheck[]
  comments: ReviewComment[]
  // ── LAD-69 ──
  /** Commit dell'upstream da scaricare (↓ dell'intestazione, come GitStatus.behind); 0 senza upstream. */
  behindUpstream: number
  /** Righe aggiunte/tolte dalle modifiche non committate (come GitStatus.added/removed). */
  added: number
  removed: number
  /** Il repository ha almeno un remote git (senza, niente Push né Pubblica). */
  hasRemote: boolean
  /** Upstream del branch, per esempio "origin/feat" (come GitStatus.upstream); null se non pubblicato o HEAD staccato. */
  upstream: string | null
  /** Commit di testa della PR (`headRefOid` di GitHub, sha completo) come l'host l'ha letto ora; null senza PR. È ciò che l'utente vede: `pr.merge` lo vuole indietro in `expectedHeadOid`. */
  prHeadOid?: string | null
  /** `mergeStateStatus` di GitHub (CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, HAS_HOOKS, DRAFT, UNKNOWN…); null senza PR. */
  mergeState: string | null
  /** Una sessione sta lavorando nella cartella: Push, Merge e Archivia aspettano. */
  agentBusy: boolean
  /** Perché la PR non si può unire ora (vuoto = unibile o nessuna PR aperta). */
  blocks: MergeBlock[]
  /** Passo successivo e se è abilitato: calcolato in un solo punto lato host, stessa logica del chip dell'intestazione. */
  nextAction: NextAction
  // ── fine LAD-69 ──
}

// ── Collegamenti: GitHub, Claude Code e Codex ────────────────────────────────

/** Servizi che Ladder sa collegare da sé: login dal browser, senza passare dal Terminale. */
export type ConnectionId = 'github' | 'claude-code' | 'codex'

/**
 * - missing: lo strumento (gh, CLI di Codex) non c'è; `connection.login` lo scarica e poi fa il login.
 * - unauthenticated: lo strumento c'è ma non è collegato a un account.
 * - connected: collegato; `user`, `plan` ed `email` dicono chi.
 * - error: lo stato non si è potuto leggere (`error` dice perché).
 */
export type ConnectionState = 'missing' | 'unauthenticated' | 'connected' | 'error'

/** Fase di un collegamento in corso, nell'ordine in cui si presentano. */
export type ConnectionStage = 'downloading' | 'verifying' | 'installing' | 'waiting-browser' | 'finishing'

/** Un login (con l'eventuale download dello strumento) in corso. Presente in ConnectionStatus finché dura. */
export interface ConnectionLogin {
  stage: ConnectionStage
  /** Da 0 a 1, solo in `downloading`; null quando la dimensione non è nota. */
  progress: number | null
  /** Byte scaricati e totali, in `downloading`: la UI li mostra ("120 MB di 350 MB"). */
  bytes: number | null
  total: number | null
  /** Pagina aperta nel browser per il login (in `waiting-browser`): "Riapri" e "Copia link" se non si è aperta. */
  url: string | null
  /** Codice monouso da digitare nella pagina: solo GitHub (`gh auth login --web`). */
  code: string | null
}

export interface ConnectionStatus {
  id: ConnectionId
  /** Profilo di cui è lo stato (solo claude-code e codex); assente = predefinito. */
  profileId?: string
  state: ConnectionState
  /** Da dove viene lo strumento: installato dall'utente (`system`), incluso in Ladder (`bundled`, solo Claude Code) o scaricato da Ladder (`downloaded`). */
  source: 'system' | 'bundled' | 'downloaded' | null
  version: string | null
  /** Nome utente GitHub; null per Claude Code e Codex. */
  user: string | null
  /** Piano dell'abbonamento: "Max", "Pro", "Plus"; null per GitHub o se l'account non lo dice. */
  plan: string | null
  email: string | null
  /** Login o download in corso; null altrimenti. */
  login: ConnectionLogin | null
  /** Errore dell'ultimo tentativo (login non riuscito, download con checksum errato, annullato…), già tradotto. */
  error: string | null
}

/** Chiave delle bozze: id della sessione oppure `new:<projectId>` per la nuova chat. */
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
      /** Profilo (account) con cui avviare; assente = quello del progetto, poi il predefinito. */
      profileId?: string | null
      attachments?: Attachment[]
      /** Sessione terminale: comando da avviare al posto della chat. */
      mode?: SessionMode
      command?: string
      /** Lavora in un nuovo worktree invece che nel checkout principale. */
      worktree?: boolean
      /** Con lo script di setup del progetto: true aspetta che finisca prima del primo messaggio, false parte subito. Assente = ProjectSettings.worktree.setupWait. */
      setupWait?: boolean
      /** Branch del worktree: nuovo (da HEAD) o esistente da estrarre (PR, branch scelto). */
      branch?: { name: string; existing: boolean; pr?: number } | null
      /** Solo con `worktree` e senza `branch`: branch locale da cui parte il worktree (predefinito: quello attuale del checkout principale). Sconosciuto: errore. */
      baseBranch?: string | null
      /** Solo con `worktree` e senza `branch`: nome scelto per il nuovo branch, usato così com'è (nessun prefisso aggiunto). Vuoto o assente: nome generato. Non valido o già esistente: errore. */
      newBranch?: string | null
      source?: SessionSource | null
      title?: string
    }
  /** Sessione terminale ferma (dopo un riavvio o un'uscita): riavvia la CLI, riprendendo la conversazione se può. */
  | { type: 'session.resume'; sessionId: string }
  /**
   * Con la sessione al lavoro: busy 'queue' (predefinito) accoda per la fine del turno,
   * 'steer' inserisce nel turno se canSteer, altrimenti accoda. Da fermo busy non conta.
   */
  /** "Continue" dopo agents-finished: invia al coordinatore il testo fisso di ripresa (nella lingua dell'host) come messaggio dell'utente. */
  | { type: 'session.continue'; sessionId: string; itemId: string }
  | { type: 'session.send'; sessionId: string; text: string; attachments?: Attachment[]; busy?: 'queue' | 'steer' }
  /** Elenco attuale dei comandi / della sessione; data: SlashCommand[] (vuoto se non ancora noti). */
  | { type: 'session.commands'; sessionId: string }
  /**
   * Esegue un comando dell'agente. L'host aggiunge una riga 'command' (mai 'user')
   * e la instrada: Claude e ACP come prompt "/name args", Codex su thread/compact/start
   * o review/start (args vuoti: uncommittedChanges; altrimenti custom instructions).
   * Rifiutato con errore se la sessione sta lavorando o il comando è sconosciuto.
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
  /** Rinomina a mano: il titolo diventa 'user' e nessuna generazione automatica lo sovrascrive. */
  | { type: 'session.rename'; sessionId: string; title: string }
  /**
   * Rigenera il titolo con un modello piccolo, anche se era stato rinominato a mano (azione esplicita:
   * la sorgente torna 'generated'). Risponde quando finisce; data: il nuovo titolo. Errore tradotto se
   * l'agente non lo supporta, non c'è ancora una conversazione, un titolo è già in corso o il modello non risponde.
   * Il titolo nuovo arriva anche con session.upsert.
   */
  | { type: 'session.title.regenerate'; sessionId: string }
  | { type: 'session.unread'; sessionId: string }
  /** File del progetto, percorsi relativi: tracciati e non tracciati non ignorati. */
  | { type: 'project.files'; projectId: string }
  | { type: 'session.queue.set'; sessionId: string; queue: QueuedMessage[] }
  /** data: SubagentDetail. id è SubagentInfo.id oppure l'id della riga 'tool'. */
  | { type: 'subagent.detail'; sessionId: string; id: string }
  /** data: SubagentInfo[] della sessione (all'apertura o dopo una riconnessione). */
  | { type: 'subagent.list'; sessionId: string }
  /**
   * Messaggio in coda da consegnare adesso. 'steer': entra nel turno in corso senza
   * interromperlo (solo se canSteer; altrimenti errore). A sessione ferma, entrambi i
   * modi avviano il messaggio come un invio normale. 'now': interrompe il turno e
   * avvia subito questo messaggio, davanti al resto della coda. Il messaggio esce dalla
   * coda; la riga 'user' nasce quando arriva all'agente (con steered: true se inserito).
   */
  | { type: 'session.queue.deliver'; sessionId: string; id: string; how: 'steer' | 'now' }
  | { type: 'session.interrupt'; sessionId: string }
  | { type: 'session.respond'; sessionId: string; requestId: string; response: RequestResponse; via?: ResponseVia }
  /**
   * Va inviato con rid (request): data = { permission, appliesFrom: 'now' | 'next-turn' }.
   * L'host aggiorna la riga solo se l'agente accetta; se rifiuta risponde con errore e il
   * livello resta quello di prima. Con 'now' le richieste di permesso aperte che il nuovo
   * livello consente si approvano da sole (full: tutte tranne le domande; edit: i tool di
   * modifica); 'next-turn' quando l'agente non può cambiarlo a turno in corso (Codex).
   */
  | { type: 'session.permission.set'; sessionId: string; permission: PermissionLevel }
  | { type: 'session.model.set'; sessionId: string; model: string }
  | { type: 'session.effort.set'; sessionId: string; effort: Effort }
  | { type: 'session.open'; sessionId: string }
  | { type: 'session.read'; sessionId: string }
  | { type: 'session.archive'; sessionId: string }
  /**
   * Chiude il processo dell'agente della sessione: il messaggio successivo riprende la stessa conversazione con un processo nuovo,
   * che rilegge impostazioni e server MCP. Con un turno o sotto-agenti al lavoro il riavvio aspetta che finiscano.
   */
  | { type: 'session.restartAgent'; sessionId: string }
  | { type: 'draft.set'; key: DraftKey; text: string }
  | { type: 'ui.set'; projectId: string; state: ProjectUiState }
  // ── LAD-57 parte 2 ──
  /** Stop del browser dell'agente: ferma l'azione in corso, rifiuta le chiamate successive e revoca gli strumenti finché non c'è `resume` o un nuovo turno dell'utente. Risponde con lo stato. */
  | { type: 'browser.agent.stop'; sessionId: string }
  /** Riabilita gli strumenti dopo uno stop. Risponde con lo stato. */
  | { type: 'browser.agent.resume'; sessionId: string }
  /** Stato del browser dell'agente: di una sessione, o di tutte quelle che ne hanno uno (all'apertura di una finestra). Risponde con AgentBrowserState[]. */
  | { type: 'browser.agent.state'; sessionId?: string }
  // ── Fine LAD-57 parte 2 ──
  // Gruppi di progetti nella sidebar. Ogni comando risponde ProjectGroupsState (lo stesso che arriva nell'evento
  // `projectGroups.changed`, a tutte le finestre). Id o progetto sconosciuti: errore, nessuna modifica.
  /** Nuova sezione in fondo; il nome viene ripulito dagli spazi, vuoto = errore. Risponde lo stato (l'id è l'ultima sezione). */
  | { type: 'projectGroups.create'; name: string; projectIds?: string[] }
  | { type: 'projectGroups.rename'; groupId: string; name: string }
  /** Elimina la sezione: i suoi progetti tornano in coda a `ungrouped`, nel loro ordine. */
  | { type: 'projectGroups.delete'; groupId: string }
  | { type: 'projectGroups.collapse'; groupId: string; collapsed: boolean }
  /** Nuovo ordine delle sezioni: `groupIds` deve elencarle tutte; quelle omesse restano in coda, gli id ignoti si scartano. */
  | { type: 'projectGroups.reorder'; groupIds: string[] }
  /** Sposta un progetto in una sezione (`groupId`) o fuori da ogni sezione (null), alla posizione `index` (predefinita: in fondo). Serve anche a riordinare. */
  | { type: 'projectGroups.move'; projectId: string; groupId: string | null; index?: number }
  // Scorciatoie. Tutti rispondono ShortcutsState; a ogni cambiamento arriva anche l'evento `shortcuts.changed`.
  /** Stato attuale (rilegge il file). */
  | { type: 'shortcuts.get' }
  /**
   * Salva preset e personalizzazioni: scrive `overrides` in keybindings.json in modo atomico. Le voci che l'host
   * aveva ignorato (sconosciute o non valide) restano nel file, davanti alle nuove. Voci non valide in `overrides`
   * o file con errore di sintassi: errore, nessuna modifica (anche il preset).
   */
  | { type: 'shortcuts.save'; preset: ShortcutPreset; overrides: Keybinding[] }
  /** Toglie tutte le personalizzazioni (il file diventa `[]`; il vecchio contenuto va in keybindings.json.bak). Il preset non cambia. */
  | { type: 'shortcuts.reset' }
  /** Apre keybindings.json nell'app di sistema per i .json (lo crea vuoto se manca). Risponde null. */
  | { type: 'shortcuts.openFile' }
  // File, diff e cronologia. `root` è la cartella di un progetto o di una sessione (worktree).
  | { type: 'fs.tree'; root: string }
  | { type: 'fs.read'; root: string; path: string }
  /** `baseMtime` null: scrive comunque. Altrimenti, se il file è cambiato, non scrive e rimanda il testo su disco. */
  | { type: 'fs.write'; root: string; path: string; text: string; baseMtime: number | null }
  | { type: 'fs.watch'; root: string; on: boolean }
  // ── LAD-70 ──
  /** Descrive un file non di testo della root, o la sua versione alla revisione `rev` (HEAD o sha completo di git). Risponde FileMedia. */
  | { type: 'fs.media'; root: string; path: string; rev?: string | null }
  /** Mostra il file nel Finder: solo dentro la root. Risponde null. */
  | { type: 'fs.reveal'; root: string; path: string }
  // ── Fine LAD-70 ──
  | { type: 'diff.files'; root: string; scope: DiffScope }
  | { type: 'diff.file'; root: string; from: string; to: string; path: string; oldPath?: string | null }
  /** Riporta i file allo stato di `to`. Restituisce il checkpoint per annullare. */
  | { type: 'git.restore'; root: string; to: string; paths?: string[]; label: string }
  | { type: 'history.list'; root: string; sessionId?: string | null }
  // Terminali.
  | { type: 'terminal.create'; projectId: string; sessionId?: string | null; cwd?: string }
  | { type: 'terminal.attach'; id: string; cols: number; rows: number }
  | { type: 'terminal.input'; id: string; data: string }
  | { type: 'terminal.resize'; id: string; cols: number; rows: number }
  | { type: 'terminal.close'; id: string }
  | { type: 'terminal.restart'; id: string }
  /** Pulisce la copia dello schermo dell'host (schermo e scrollback, resta la riga del cursore): non scrive nulla alla shell. Terminale inesistente: ignorata. */
  | { type: 'terminal.clear'; id: string }
  /** Ultime righe del terminale come testo semplice, per @terminal. */
  | { type: 'terminal.output'; id: string; lines?: number }
  // Configurazione del progetto (.ladder/settings.toml) e azioni di avvio.
  | { type: 'project.settings'; projectId: string }
  | { type: 'run.start'; projectId: string; sessionId?: string | null; name: string }
  /**
   * Salva setup, pulizia, attesa e copie del progetto in `.ladder/settings.local.toml` (personale, fuori da git; il file
   * viene riscritto, quindi i suoi commenti si perdono). Vince sul file del progetto campo per campo. Risponde ProjectSettings.
   */
  | { type: 'project.worktree.set'; projectId: string; patch: WorktreeSettingsPatch }
  /** Anteprima di cosa copierebbe un worktree nuovo. Risponde WorktreeFiles. */
  | { type: 'project.worktreeFiles'; projectId: string }
  // Dati (LAD-22). Il database è uno solo, nella cartella dati dell'app.
  /** Risponde DataInfo. */
  | { type: 'data.info' }
  /**
   * Copia coerente del database (VACUUM INTO, anche a sessioni al lavoro). Senza `to`: nuovo file `ladder-AAAAMMGG-HHMMSS.db`
   * in `backups` nella cartella dati; con `to` (percorso assoluto scelto con `ladder:pick-save-path`) scrive lì e sostituisce
   * un file esistente. Risponde { path, bytes }. Non c'è ripristino.
   */
  | { type: 'data.backup'; to?: string }
  /** Apre la cartella dati nel Finder (lo fa il main). Risponde null. */
  | { type: 'data.openFolder' }
  // Ricerca nelle conversazioni (⌘K), issue e PR per nuove sessioni, pannello merge e prompt dei pulsanti.
  | { type: 'search'; query: string }
  | { type: 'issues.list'; projectId: string; source: 'github-issue' | 'github-pr' | 'branch' }
  | { type: 'merge.info'; root: string; fetch?: boolean }
  /** Testo del prompt dietro un pulsante (create_pr, fix, conflicts, review, issue), con le variabili già sostituite. */
  | { type: 'prompt.render'; projectId: string; name: string; vars: Record<string, string> }
  // Agenti ACP: catalogo del registro, aggiunta e rimozione.
  /**
   * Aggiunge un agente al catalogo "I tuoi agenti". Per una CLI rilevata: `agents.add` con `source: 'registry'` e
   * l'id; l'host usa il percorso trovato (distribution `path`), altrimenti il binario scaricato, altrimenti npx/uvx.
   * Risponde AgentStatus.
   */
  | { type: 'agents.add'; spec: AcpAgentSpec }
  /**
   * Catalogo completo (LAD-56): risponde AgentCatalogEntry[] con i curati in cima, nell'ordine Gemini CLI, Cursor,
   * GitHub Copilot, OpenCode, Amp, goose, Cline, Qwen Code, Kiro CLI, Junie, Factory Droid, poi il resto del registro
   * per nome. Include rilevamento, stato e login: fa un giro della shell di login per ogni CLI, quindi la UI lo
   * chiede all'apertura di Impostazioni → Agenti e del primo avvio, non a ogni render. Se il registro non risponde: errore.
   */
  | { type: 'agents.catalog' }
  /**
   * Cerca nel PATH della shell di login le CLI degli agenti curati (senza avviarle né scrivere niente) e risponde
   * AgentCatalogEntry[] solo per quelle trovate. Più leggero di `agents.catalog`: per il primo avvio ("abbiamo trovato…").
   */
  | { type: 'agents.detect' }
  /**
   * Scarica e installa il binario di un agente in `<dati>/bin/<id>` (anche per aggiornarlo). Serve la conferma
   * esplicita dell'utente: `confirmed` deve essere true e `version`, `sha256` e `host` quelli che la UI gli ha mostrato nel dialog
   * (AgentCatalogEntry.registryVersion, download.sha256, download.host): TUTTI e tre sono obbligatori e l'host li confronta sempre
   * con quelli che userebbe adesso (il checksum dal registro o dalla release, riletti freschi); se uno è diverso rifiuta e la UI
   * rilegge il catalogo. Un `sha256` che non è di 64 cifre esadecimali o un `host` vuoto si rifiutano. Rifiuta anche se non c'è un
   * checksum verificabile, se un binario ha argomenti che un runtime esegue come codice (`-XX:`, `-javaagent`, `-agentlib`, `-Djava.`, `--add-opens`, `@file`…: la voce è `unavailable`), se l'host dell'archivio non è quello atteso (`host`), se la stessa versione è già stata scaricata con
   * un checksum diverso (`checksum-conflict`, rifiutato come gli altri blocchi: la promessa è rifiutata, il codice arriva con l'evento `agent.install`, non c'è risposta `running`).
   * Una seconda richiesta per la stessa versione durante il download riceve lo stato di quel download (un solo download) solo se `sha256`
   * e `host` coincidono con quelli del download in corso; se differiscono rifiuta con `checksum-changed` (la sua conferma non si ignora
   * in silenzio) SENZA evento `agent.install`: lo stato del job in corso non cambia (un evento di errore per lo stesso id lo mostrerebbe
   * come fallito mentre sta scaricando), quindi qui il codice non arriva alla UI, solo il testo del rifiuto; la UI rilegge il catalogo.
   * La lettura del checksum di una release GitHub dura al massimo 15 secondi (poi errore "can't read the checksum right now").
   * Se la scrittura del checksum registrato fallisce dopo la registrazione dell'agente, l'installazione resta riuscita (`done`). Per un'altra versione dello stesso agente è un errore ("un'altra installazione è in corso").
   * Risponde AgentInstall (state running) e prosegue in
   * background: ogni passo arriva come evento `agent.install` (errorCode per i blocchi di sicurezza, signature dopo la
   * verifica). A fine installazione l'agente è aggiunto (agent.status). Il binario si prepara in una cartella
   * temporanea e si sposta solo dopo checksum, estrazione e codesign; Ladder non esegue niente prima. Il checksum della versione
   * si registra (per accorgersi di un registro che lo cambia) solo a installazione riuscita.
   * Aggiornamento: la cartella nuova porta un marcatore `.ladder-version` (0644, scritto da Ladder) con versione e impronta della voce
   * registrata; se l'app si chiude a metà dello scambio, al riavvio la cartella resta quella la cui impronta coincide con la voce nel
   * database, altrimenti torna la precedente. Con `signature` il programma dentro un `.app` deve stare in Contents/MacOS, Helpers,
   * Frameworks (non runtime né jbr: contengono il JDK), essere un Mach-O e soddisfare da solo il requisito del firmatario (non basta la firma del pacchetto).
   */
  | { type: 'agents.install'; id: string; version: string; confirmed: true; sha256: string; host: string }
  /** Annulla un'installazione in corso: la cartella finale non cambia. Risponde null. */
  | { type: 'agents.install.cancel'; id: string }
  /**
   * LAD-79: elenco di "Altri agenti" nelle Subscription (OtherAgentConnection[]). Risponde subito con quanto è noto (programmi
   * cercati nel PATH della shell di login, versioni, ultimo stato) e per gli agenti installati con `auth` unknown o provato da più di
   * 10 minuti avvia in background una prova (al massimo 2 insieme): ogni esito arriva come evento `agent.connection`
   * (prima con `probing: true`, poi col risultato). La prova avvia il programma dell'agente, fa `initialize` e `session/new` in
   * una cartella neutra (la home) senza mandare prompt, con `NO_BROWSER=true` nell'ambiente (l'agente non apre il browser) e senza
   * variabili ANTHROPIC_*, CLAUDE* e chiavi API; poi lo ferma. Non legge mai file di credenziali. Nessun download né installazione.
   */
  | { type: 'agents.others' }
  /** Ripete la prova di un agente e risponde OtherAgentConnection aggiornato (anche per un id senza riga: errore). Emette `agent.connection` e, se la prova dà ready/required, `agent.login`. */
  | { type: 'agents.others.refresh'; id: string }
  /**
   * Accesso tramite la CLI dell'agente, in un terminale di Ladder (con TTY: i login di Gemini, Copilot, Cursor sono interattivi).
   * Come le azioni di progetto (`run.start`): un terminale `kind: 'run'` del progetto (`projectId`, altrimenti il primo progetto aperto; errore se non ce n'è),
   * titolo "Sign in to <agente>", cartella del progetto, lanciato con la shell di login; con `loginCommand` null apre la CLI da sola.
   * Risponde TerminalInfo (la UI lo apre con il suo id); un secondo `login` mentre quello gira risponde lo stesso terminale.
   * Quando il processo esce Ladder ripete la prova dell'agente ed emette `agent.connection` (anche con un'uscita con errore o chiuso dall'utente).
   * Errore se l'agente non è installato o è npx/uvx. Il browser lo apre la CLI da sé: Ladder non vede credenziali.
   */
  | { type: 'agents.others.login'; id: string; projectId?: string }
  /**
   * Uscita tramite la CLI, nello stesso modo di `agents.others.login` (terminale, poi nuova prova ed `agent.connection`), solo se
   * `logoutCommand` non è null; altrimenti errore e la UI mostra `logoutHelp`. Risponde TerminalInfo.
   */
  | { type: 'agents.others.logout'; id: string; projectId?: string }
  /**
   * Accesso a un agente ACP con uno dei suoi metodi (AgentLogin.methods, solo di tipo `agent`): chiama `authenticate`
   * del protocollo ACP e poi apre una sessione di prova per verificare l'esito. Ladder non vede né salva credenziali:
   * le gestisce l'agente (spesso apre il browser). `projectId` dà la cartella di lavoro (altrimenti la home). Può
   * durare fino a 5 minuti. Risponde AgentLogin aggiornato (ready se l'accesso è riuscito, required altrimenti) ed
   * emette `agent.login`. Un metodo `terminal` o `unsupported` si rifiuta. Errore se l'agente non è aggiunto o il metodo non c'è.
   * Se l'agente muore o non parte l'errore arriva subito. Una seconda richiesta con lo stesso `methodId` mentre l'accesso è in
   * corso riceve la stessa risposta (un solo processo); con un altro metodo è un errore.
   */
  | { type: 'agents.authenticate'; id: string; methodId: string; projectId?: string }
  /**
   * Ferma l'accesso in corso per quell'agente ("Smetti di aspettare"): uccide il processo dell'agente e libera subito l'id, così
   * una nuova `agents.authenticate` parte senza "già in corso". La richiesta `agents.authenticate` pendente risponde con il
   * AgentLogin com'era (senza errore e senza evento). Risponde null; senza un accesso in corso non fa niente.
   */
  | { type: 'agents.authenticate.cancel'; id: string }
  | { type: 'agents.remove'; id: string }
  /** Rilegge i limiti d'uso del piano, senza aprire una sessione né consumare quota. */
  | { type: 'agents.usage'; agent: AgentId; profileId?: string }
  /**
   * Predefiniti dell'agente per un progetto, letti dalla config dell'agente con i settings di
   * progetto (Claude: .claude/settings*.json; Codex: config.toml e profilo). data:
   * { model: string | null; effort: Effort | null; known: boolean } con model = id di AgentStatus.models.
   * known false: l'utente ha configurato qualcosa che Ladder non sa risolvere (niente badge).
   * AgentStatus.models[].isDefault resta il predefinito a livello utente.
   */
  | { type: 'agents.defaults'; agent: AgentId; projectId: string; profileId?: string }
  /**
   * Profili (LAD-23). `profile.create` crea la cartella di configurazione e risponde il Profile; i nomi sono unici per
   * agente. `profile.rename` risponde il Profile. `profile.remove` non tocca il predefinito e rifiuta se una sessione
   * attiva lo usa; le sessioni ferme passano al predefinito; la cartella di configurazione non si cancella (ci sono le credenziali).
   * `project.profile` sceglie il profilo di un progetto per un agente (profileId null = predefinito): vale per le nuove sessioni,
   * quelle esistenti tengono il loro. Ogni cambiamento arriva come `profile.upsert`, `profile.removed` e `project.upsert`.
   */
  | { type: 'profile.create'; agent: ProfileAgent; name: string }
  | { type: 'profile.rename'; profileId: string; name: string }
  | { type: 'profile.remove'; profileId: string }
  | { type: 'project.profile'; projectId: string; agent: ProfileAgent; profileId: string | null }
  /**
   * Collegamenti (GitHub, Claude Code, Codex). `connection.list` risponde ConnectionStatus[] senza avviare nulla.
   * `connection.refresh` rilegge lo stato di uno (risponde ConnectionStatus). `connection.login` risponde subito con lo
   * stato (login valorizzato) e prosegue in background: ogni passo arriva come evento `connection.update`; se lo
   * strumento manca lo scarica (download con checksum), poi apre il browser. `switchAccount`: esce prima dall'account
   * attuale ("Cambia account"): il logout avviene prima del nuovo login, quindi se l'utente annulla il login resta scollegato
   * (la UI lo scrive nella conferma di "Cambia account"). `connection.cancel` interrompe download o login e non lascia errori. `connection.logout` esce e
   * risponde lo stato; due logout in parallelo condividono la stessa operazione. Se `claude auth status` non risponde, lo stato è `error`.
   * Alla fine di un login riuscito l'host rilegge anche `agent.status` (account, modelli, limiti) e le viste GitHub
   * si aggiornano da sole con una nuova richiesta di `issues.list` e `merge.info`.
   * `profileId` (solo claude-code e codex) indirizza il profilo; assente = predefinito. `connection.list` ne risponde uno
   * per profilo.
   */
  | { type: 'connection.list' }
  | { type: 'connection.refresh'; id: ConnectionId; profileId?: string }
  | { type: 'connection.login'; id: ConnectionId; switchAccount?: boolean; profileId?: string }
  | { type: 'connection.cancel'; id: ConnectionId; profileId?: string }
  | { type: 'connection.logout'; id: ConnectionId; profileId?: string }
  /** Review in sola lettura delle modifiche di una sessione, chiesta a un altro agente. Torna come commenti. */
  | { type: 'review.start'; sessionId: string; agent: AgentId; scope: DiffScope }
  | { type: 'review.cancel'; reviewId: string }
  // ── LAD-59: testi scritti dal modello piccolo (solo su richiesta esplicita) ──
  /**
   * Propone il messaggio di commit dal diff della cartella della sessione e dalla conversazione. Risponde GeneratedCommit.
   * `source` assente: i file in stage se ce ne sono, altrimenti tutto il working tree. Non committa nulla.
   * Errori (testo tradotto): generazione spenta, agente senza modello piccolo, nessuna modifica, timeout (60 s).
   */
  | { type: 'text.commit'; sessionId: string; source?: 'staged' | 'working' }
  /**
   * Propone titolo e descrizione della PR dai commit e dal diff del branch rispetto alla base, e dalla conversazione.
   * Risponde GeneratedPr. Non crea la PR. Errori come text.commit, più "nessun commit rispetto alla base".
   */
  | { type: 'text.pr'; sessionId: string }
  /** Annulla la generazione di commit/PR in corso per la sessione e la libera subito (la richiesta in sospeso fallisce con "cancelled"). Risponde null. */
  | { type: 'text.cancel'; sessionId: string }
  // ── LAD-59 commit ──
  /**
   * Commit fatto da Ladder nella cartella della sessione, con `git commit` (hook del repo inclusi, niente --no-verify,
   * nessun trailer, autore dalle config git). Messaggio = `subject`, riga vuota, `body`: non viene riscritto.
   * Se c'è qualcosa in stage si committa solo quello; altrimenti `paths` ('all' o un elenco di percorsi) viene messo
   * in stage con `git add -A` (rispetta .gitignore). Risponde GitCommitResult e manda `fs.changed` (il pannello si aggiorna).
   * Errori (testo tradotto): oggetto vuoto, su più righe o oltre 200 caratteri; byte NUL; "Nothing to commit."; hook o git
   * falliti (con il loro output).
   */
  | { type: 'git.commit'; sessionId: string; subject: string; body?: string; paths?: string[] | 'all' }
  /**
   * Prepara l'apertura della PR: l'host scrive titolo e descrizione in file temporanei privati (cartella 0700, file 0600,
   * nomi casuali, cancellati alla chiusura della sessione, a una nuova preparazione o all'uscita dell'app) e risponde
   * PrPrepared con il prompt `create_pr` completo, che porta all'agente solo i PERCORSI: titolo e descrizione non vengono
   * mai incollati in un comando. Errori (testo tradotto): titolo vuoto, su più righe o oltre MAX_PR_TITLE caratteri;
   * descrizione oltre MAX_PR_BODY; byte NUL. Non invia nulla alla sessione: lo fa la UI con `session.send`.
   */
  | { type: 'pr.prepare'; sessionId: string; projectId: string; branch: string; base: string; title: string; body: string }
  // ── LAD-68 ──
  /**
   * Stato git leggero della cartella della sessione (worktree se c'è) per l'intestazione. Risponde GitStatus, o null se la
   * cartella non è un repository git. Non chiama gh: per il pannello merge resta `merge.info`.
   */
  | { type: 'git.status'; sessionId: string }
  /**
   * Iscrive (on) o toglie (off) la UI agli aggiornamenti `git.status` della cartella della sessione. Le iscrizioni sono per
   * connessione (finestra) e per sessione: un secondo `on` della stessa finestra non fa nulla, l'`off` di una finestra non toglie
   * l'iscrizione di un'altra, e la chiusura di una finestra toglie tutte le sue iscrizioni. Finché c'è un iscritto l'host osserva la cartella, rilegge lo stato
   * a ogni cambio e fa un `git fetch` in background (all'apertura e ogni ~5 minuti, mai mentre un turno lavora lì).
   * Risponde null; la sessione archiviata o un progetto rimosso tolgono da soli le iscrizioni.
   */
  | { type: 'git.watch'; sessionId: string; on: boolean }
  // ── fine LAD-68 ──
  // ── LAD-80 ──
  /**
   * Mappa dei branch del progetto: una riga per sessione (worktree e non) con distanza da main, stato del merge e ultimo commit.
   * Risponde BranchMap. Solo letture git sul checkout principale (nessun gh, nessuna scrittura), con cache per sha: chiamarla spesso costa poco.
   * Un progetto sconosciuto è un errore; un progetto non git (o con la cartella sparita) risponde una mappa vuota con `base` null.
   */
  | { type: 'project.branchMap'; projectId: string }
  /**
   * Iscrive (on) o toglie (off) la finestra agli eventi `project.branchMap` del progetto. Per connessione e con conteggio (due `on`
   * vogliono due `off`); la chiusura della finestra toglie tutte le sue iscrizioni. Senza iscritti l'host non rilegge nulla. Risponde null.
   */
  | { type: 'project.branchMap.watch'; projectId: string; on: boolean }
  // ── fine LAD-80 ──
  // ── Branch del checkout principale ──
  /** Branch locali del progetto (con quello attuale, i file non committati e l'eventuale sessione al lavoro nel checkout principale). Risponde ProjectBranches; un progetto non git risponde un elenco vuoto. */
  | { type: 'project.branches'; projectId: string }
  /**
   * Cambia il branch del checkout principale (`git switch --no-guess <branch>`, mai un checkout di file). Rifiuta, con un messaggio tradotto, se:
   * una sessione del progetto che lavora nel checkout principale (non in worktree) ha un turno o dei sotto-agenti in corso; il branch non esiste
   * in locale; è già estratto in un worktree; HEAD è a metà di un'operazione che git non lascia interrompere; git non riesce a portare le modifiche.
   * `dirty` decide cosa fare delle modifiche non committate (anche non tracciate): 'carry' (predefinito) prova lo switch normale, che le porta con sé se git lo consente;
   * 'stash' prima fa `git stash push -u -m "ladder: before switching to <branch>"`, mai uno stash silenzioso. Se lo switch fallisce dopo lo stash, lo stash viene ripreso.
   * Risponde BranchSwitchResult e manda `fs.changed` e `project.upsert`, come per un cambio fatto altrove.
   */
  | { type: 'project.branch.switch'; projectId: string; branch: string; dirty?: 'carry' | 'stash' }
  /** Crea un branch dal commit attuale e lo estrae (`git switch -c`): le modifiche non committate restano dove sono. Stesse protezioni di `project.branch.switch`; il nome si valida come per il push e non deve esistere già. */
  | { type: 'project.branch.create'; projectId: string; name: string }
  // ── fine Branch del checkout principale ──
  // ── LAD-69 ──
  /**
   * Anteprima del push, leggera (solo git locale, nessuna rete): cosa verrebbe inviato, da mostrare nella conferma. Risponde
   * GitPushPreview. `remote` serve solo quando il branch non ha upstream e il repo ha più remote (vedi `problem`).
   * Destinazione: il push va SEMPRE a un branch con lo stesso nome di quello locale (`target`, per esempio "origin/feat"), mai a un
   * branch con nome diverso. Se l'upstream punta a un altro branch (`git switch -c feat origin/main`) o a un altro remote di
   * `branch.<b>.pushRemote`/`remote.pushDefault`, l'upstream NON è la destinazione: l'anteprima dice `willPublish: true` e
   * `upstreamElsewhere` riporta l'upstream attuale (che dopo il push passa a `target`). Remote scelto: `remote` richiesto, poi
   * `branch.<b>.pushRemote`, `remote.pushDefault`, il remote dell'upstream, l'unico remote.
   * Errori (testo tradotto): HEAD staccato; cartella non repo git; `remote` che non è tra quelli del repo o diverso da quello
   * dell'upstream; sessione senza cartella (progetto rimosso).
   */
  | { type: 'git.push.preview'; sessionId: string; remote?: string }
  /**
   * Push fatto da Ladder con git, SOLO su azione esplicita dell'utente (la UI chiede sempre conferma con branch e numero di commit
   * dell'anteprima): mai su richiesta dell'agente. Branch con upstream: invia al branch dell'upstream; senza upstream o con
   * `publish: true`: `git push -u <remote> <branch>`. Mai force. Risponde GitPushResult, manda `fs.changed` e rilegge lo stato
   * (evento `git.status`). Una sola operazione alla volta per repo; rifiutato (errore tradotto) se l'agente di quella cartella sta
   * lavorando. Un push rifiutato non modifica nulla (nemmeno la config dell'upstream).
   * Errori tradotti: non fast-forward, credenziali mancanti o rifiutate, remote non raggiungibile, hook pre-push o remoto che rifiutano
   * (con l'output, ultimi 4000 caratteri), HEAD staccato, nessun remote o più remote senza upstream, nulla da inviare, timeout di 3 minuti.
   * `expectedHead`: lo sha completo di HEAD mostrato nell'anteprima (`GitPushPreview.head`); se HEAD è diverso il push è rifiutato
   * ("Il branch è cambiato dopo l'anteprima: riapri la conferma") e non parte nulla. La UI lo passa sempre.
   */
  | { type: 'git.push'; sessionId: string; publish?: boolean; remote?: string; expectedHead?: string }
  /**
   * Merge della PR del branch della sessione con `gh pr merge`, SOLO su azione esplicita dell'utente (conferma con il metodo scelto).
   * Controlli prima, senza chiamare merge se falliscono: gh collegato; PR aperta, non bozza, del branch della sessione, senza
   * conflitti, senza blocchi di MergeBlock (CI in corso o fallita, review richiesta, branch non aggiornato). Mai --admin né --auto;
   * `--match-head-commit` fissa il commit controllato. `deleteBranch` NON passa --delete-branch a gh: se true cancella, dopo il merge
   * riuscito, solo il branch REMOTO della PR (mai quello locale; salta se la PR viene da un fork). Risponde PrMergeResult
   * e aggiorna PR/stato (eventi `fs.changed`, `git.status`, `session.summary`).
   * Rifiutata (errore tradotto) una PR da fork (`isCrossRepository`) e una PR la cui testa non coincide con l'upstream locale del branch
   * (commit non ancora pubblicati o branch diverso). `expectedHeadOid`: lo sha di testa della PR che l'utente ha visto nel dialogo
   * (`MergeInfo.prHeadOid`); se la PR riletta ha un oid diverso il merge è rifiutato ("la PR è cambiata: riapri la conferma"); a gh va
   * sempre `--match-head-commit` con l'oid verificato. La UI lo passa sempre.
   * Se gh non risponde entro 90 s l'errore dice di ricontrollare lo stato della PR (potrebbe essere stata unita) e lo stato si rilegge.
   */
  | { type: 'pr.merge'; sessionId: string; number: number; method: PrMergeMethod; deleteBranch?: boolean; expectedHeadOid?: string }
  /**
   * "Archivia" dopo il merge: chiude la sessione e, se è in un worktree che nessun'altra sessione usa, lo toglie (come
   * l'archiviazione automatica a PR unita: script di pulizia compreso, il branch resta). Solo se la PR risulta unita o il branch
   * è già nella base; mai con modifiche non committate o commit che esistono solo qui (errore tradotto, nulla viene toccato).
   * Risponde GitArchiveResult.
   */
  | { type: 'git.archive'; sessionId: string }
  // ── fine LAD-69 ──
  // ── fine LAD-59 commit ──
  // ── fine LAD-59 ──

export type HostEvent =
  | {
      type: 'snapshot'
      projects: Project[]
      sessions: SessionSummary[]
      drafts: Record<DraftKey, string>
      ui: Record<string, ProjectUiState>
      /** Gruppi di progetti; assente nelle fixture (= nessuna sezione). */
      projectGroups?: ProjectGroupsState
      agents: AgentStatus[]
      /** Profili di Claude Code e Codex, predefiniti compresi; assente nelle fixture (= solo i predefiniti). */
      profiles?: Profile[]
      /** Stato dei collegamenti all'avvio; assente nelle fixture. */
      connections?: ConnectionStatus[]
      terminals: TerminalInfo[]
      /** Scorciatoie all'avvio; assente nelle fixture (= predefinite). */
      shortcuts?: ShortcutsState
    }
  | { type: 'project.upsert'; project: Project }
  | { type: 'project.removed'; projectId: string }
  /** Cambiato qualcosa nei gruppi di progetti (anche per un progetto aggiunto o rimosso): stato completo. */
  | { type: 'projectGroups.changed'; state: ProjectGroupsState }
  /** Le sessioni ferme da `autoArchiveDays` giorni sono state archiviate (arrivano anche i loro `session.upsert`). */
  | { type: 'sessions.autoArchived'; sessionIds: string[] }
  /** Le scorciatoie sono cambiate (file modificato a mano, salvataggio, ripristino): stato completo. */
  | { type: 'shortcuts.changed'; state: ShortcutsState }
  | { type: 'session.upsert'; session: SessionSummary }
  | { type: 'session.items'; sessionId: string; items: ChatItem[]; replace: boolean }
  /** Elenco completo dei sotto-agenti della sessione, con debounce; sostituisce il precedente. */
  | { type: 'session.subagents'; sessionId: string; subagents: SubagentInfo[] }
  /** Elenco dei comandi / cambiato (all'avvio della sessione o con commands_changed). */
  | { type: 'session.commands'; sessionId: string; commands: SlashCommand[] }
  | { type: 'agent.status'; status: AgentStatus }
  | { type: 'profile.upsert'; profile: Profile }
  | { type: 'profile.removed'; profileId: string }
  | { type: 'agent.removed'; agent: AgentId }
  /** Avanza o finisce l'installazione di un binario (`agents.install`): stato completo, l'ultimo evento ha state done, error o cancelled. */
  | { type: 'agent.install'; install: AgentInstall }
  /** Cambiato lo stato del login di un agente ACP (dopo `agents.authenticate` o una sessione): `id` è quello del registro. */
  | { type: 'agent.login'; id: string; login: AgentLogin }
  /** LAD-79: riga di "Altri agenti" cambiata (inizio e fine di una prova, fine di un accesso o di un'uscita): riga completa, sostituisce la precedente con lo stesso `id`. */
  | { type: 'agent.connection'; agent: OtherAgentConnection }
  | { type: 'review.update'; review: ReviewState }
  | { type: 'terminal.upsert'; terminal: TerminalInfo }
  | { type: 'terminal.removed'; id: string }
  | { type: 'terminal.data'; id: string; data: string }
  /** Il terminale è stato pulito (`terminal.clear`): ogni renderer svuota il proprio xterm per `id`. */
  | { type: 'terminal.cleared'; id: string }
  /** Il terminale del progetto ha stampato un indirizzo locale (server di sviluppo): la UI può proporre o aprire la tab Browser. Una volta per progetto e indirizzo. */
  | { type: 'browser.devserver'; projectId: string; terminalId: string; url: string }
  // ── LAD-57 parte 2 ──
  /** Stato del browser dell'agente di una sessione: intero a ogni cambiamento. `state.closed` = la sessione non ha più il browser. */
  | { type: 'browser.agent'; state: AgentBrowserState }
  // ── Fine LAD-57 parte 2 ──
  /** Qualcosa è cambiato nella cartella: albero, stato git e diff "attuali" vanno riletti. */
  | { type: 'fs.changed'; root: string }
  // ── LAD-68 ──
  /** Stato git di una cartella cambiato (modifiche, commit, fetch, cambio branch): intero, solo se è diverso dall'ultimo mandato. */
  | { type: 'git.status'; status: GitStatus }
  // ── fine LAD-68 ──
  // ── LAD-80 ──
  /** Mappa dei branch cambiata: intera, solo se è diversa dall'ultima mandata, per i progetti con una finestra iscritta (`project.branchMap.watch`). */
  | { type: 'project.branchMap'; projectId: string; map: BranchMap }
  // ── fine LAD-80 ──
  /** Un collegamento è cambiato: avanza il download o il login, o è finito (anche con errore). */
  | { type: 'connection.update'; status: ConnectionStatus }

/** Messaggi sul canale renderer ↔ host. I comandi con `rid` ricevono una risposta con lo stesso id. */
export type ToHost = { rid?: string; command: HostCommand }
export type FromHost =
  | { kind: 'event'; event: HostEvent }
  | { kind: 'result'; rid: string; ok: true; data?: unknown }
  | { kind: 'result'; rid: string; ok: false; error: string }

// ── Host ↔ processo main: notifiche, badge del Dock e preferenze ─────────────

/** Eventi che possono diventare una notifica di macOS. Decide il main, che sa cosa stai guardando. */
export type AttentionEvent =
  | { kind: 'request'; sessionId: string; projectId: string; itemId: string | null; title: string; body: string }
  | { kind: 'resolved'; sessionId: string; itemId: string | null }
  | { kind: 'turn'; sessionId: string; projectId: string; projectName: string; itemId: string | null; durationMs: number; title: string }
  | { kind: 'error'; sessionId: string; projectId: string; itemId: string | null; title: string; body: string }
  /**
   * Sotto-agenti in background finiti a sessione ferma: 'done' quando non ne resta nessuno
   * in corso (finished = quanti sono finiti dall'ultimo avviso), 'failed' subito per ogni errore.
   */
  | { kind: 'agents'; sessionId: string; projectId: string; projectName: string; itemId: string | null; outcome: 'done' | 'failed'; finished: number; failed: number; title: string; body: string }

/** `open-url`: l'host non ha un browser; il main apre l'indirizzo https (pagina di login) nel browser predefinito. */
export type HostToMain =
  | { type: 'attention'; event: AttentionEvent }
  | { type: 'badge'; count: number }
  | { type: 'open-url'; url: string }
  /** Scorciatoie in uso: il main le applica agli acceleratori del menu e ricostruisce il menu. */
  | { type: 'shortcuts'; preset: ShortcutPreset; overrides: Keybinding[] }
  /** Apre keybindings.json (il main sa il percorso) nell'app di sistema. */
  | { type: 'open-keybindings' }
  /** Sessioni che stanno lavorando (turno in corso, non in attesa di te), a ogni cambiamento del numero: il main tiene il Mac sveglio se AppPrefs.keepAwake. */
  | { type: 'activity'; running: number }
  /** Apre una cartella o un file nel Finder / app di sistema: il main lo fa solo dentro la cartella dati dell'app. */
  | { type: 'open-path'; path: string }
  // ── LAD-57 parte 2 ──
  /** Operazione sul browser dell'agente: il main la esegue e risponde con `browser-agent-result` (stesso `rid`). */
  | { type: 'browser-agent'; rid: string; op: BrowserAgentOp }
  // ── Fine LAD-57 parte 2 ──
  // ── LAD-70 ──
  /** Root da cui il main può servire file (ladder-file://<id>/…): elenco completo a ogni cambio, ciò che manca smette di funzionare. */
  | { type: 'file-roots'; roots: { id: string; root: string }[] }
  /** Mostra nel Finder un file della root `id`: il main ricontrolla che sia dentro la root. */
  | { type: 'reveal-file'; id: string; path: string }
  // ── Fine LAD-70 ──

export interface HostPrefs {
  /** Lingua di avvisi, errori, notifiche e prompt predefiniti. */
  locale?: Locale
  /** Titoli generati da un modello piccolo dopo il primo turno. Predefinito true. */
  generatedTitles?: boolean
  /** LAD-59: nome del branch, messaggio di commit e testo della PR scritti dal modello; globale, vale per tutti i progetti. Predefinito true. */
  generatedText?: boolean
  /** Istruzione di autonomia nel prompt di sistema delle sessioni in Edit e Full access. Predefinito true. Vale dall'avvio (o ripresa) della sessione. */
  autonomyHint?: boolean
  /** Segnala i turni fermi senza motivo (turn-end.stalled). Predefinito false finché l'euristica non è provata. */
  stallHint?: boolean
  /** LAD-21: cartella dei worktree nuovi (`<cartella>/<progetto>/<nome>`); null = quella predefinita. Non sposta i worktree esistenti. */
  worktreesDir?: string | null
  /** LAD-21: prefisso dei branch dei worktree nuovi. Predefinito 'ladder/'. Vedi cleanBranchPrefix in shared/worktree-prefs. */
  branchPrefix?: string
  /** LAD-22: archivia le sessioni ferme da tanti giorni; null = mai. */
  autoArchiveDays?: number | null
  // ── LAD-57 parte 2 ──
  /** Browser per l'agente, globale (vedi AppPrefs.agentBrowser). Predefinito false. */
  agentBrowser?: boolean
  // ── Fine LAD-57 parte 2 ──
}

export type MainToHost =
  | { type: 'connect' }
  | { type: 'prefs'; prefs: HostPrefs }
  // ── LAD-57 parte 2 ──
  | { type: 'browser-agent-result'; rid: string; result: BrowserAgentResult }
  /** La vista dell'agente non c'è più (l'utente ha chiuso la tab o la finestra): l'host revoca gli strumenti della sessione. */
  | { type: 'browser-agent-closed'; sessionId: string }
  // ── Fine LAD-57 parte 2 ──

/** Preferenze dell'app salvate dal main in settings.json, insieme al tema. */
export interface AppPrefs {
  notifications: boolean
  /** Suono solo per approvazioni e domande. */
  sound: boolean
  /** "Non disturbare" fino a questo istante: niente notifiche; "In attesa" e badge restano. */
  dndUntil: number | null
  /** Lingua dell'interfaccia: inglese per default, italiano a scelta. */
  locale: Locale
  /** Predefiniti globali delle nuove sessioni. */
  defaults: SessionDefaults
  /** Profili di sessione salvati (LAD-60), nell'ordine in cui si mostrano. */
  presets: SessionPreset[]
  /** Vale in tutti i composer. Predefinito 'enter'. */
  sendKey: SendKey
  /**
   * Cosa fa il tasto di invio mentre la sessione lavora: 'steer' inserisce nel turno
   * (dove l'agente lo permette, altrimenti accoda), 'queue' accoda. Predefinito 'steer'.
   * L'altra azione resta sul tasto di invio con ⌥ (Alt) in più e sui comandi della coda.
   */
  busySend: 'steer' | 'queue'
  /** Genera il titolo delle sessioni con un modello piccolo dopo il primo turno (Claude, Codex). Predefinito true; "Rigenera titolo" vale comunque. */
  generatedTitles: boolean
  /**
   * LAD-59: interruttore generale per nome del branch, messaggio di commit e testo della PR.
   * Predefinito true. Per progetto: ProjectUiState.generatedText. I titoli restano governati da generatedTitles.
   */
  generatedText: boolean
  /** Font dei messaggi in chat (utente e modello); il resto dell'app resta in Mona Sans. Predefinito 'system-sans' (LAD-71; prima 'system-mono', migrato una volta dal main). */
  chatFont: ChatFont
  /**
   * Larghezza del testo della chat, per colonna (container query), non per finestra:
   * 'comfortable' ~820px (predefinita), 'wide' ~1100px, 'full' tutta la colonna (LAD-71; prima in ch). I blocchi
   * larghi (codice, diff, tabelle, output) arrivano fino a ~1100px o alla colonna.
   */
  chatWidth: 'comfortable' | 'wide' | 'full'
  /** Vedi HostPrefs.autonomyHint e stallHint. */
  autonomyHint: boolean
  stallHint: boolean
  /**
   * LAD-77: nome con cui l'app saluta l'utente. Stringa tagliata di al più 80 caratteri; null = non impostato (vuota o solo spazi).
   * Resta solo in settings.json su questo Mac: non va all'host, né ad agenti o servizi.
   */
  userName: string | null
  // ── LAD-57 parte 2 ──
  /**
   * Browser per l'agente (strumenti browser_* in un browser isolato, visibile in una tab). Predefinito false: dà all'agente
   * rete e DOM, quindi si accende a mano. Per progetto: ProjectUiState.agentBrowser. Opzionale solo per le fixture.
   */
  agentBrowser?: boolean
  // ── Fine LAD-57 parte 2 ──

  // ── LAD-21: leggibilità, editor, worktree ──
  /** Dimensione del testo dei messaggi in chat, rispetto a quella del font scelto (chatFont). Predefinita 'default'. */
  chatTextSize: TextSize
  /** Dimensione del testo nell'editor dei file, in px (10–24). Predefinita 12. */
  editorTextSize: number
  /** Font del codice nell'editor dei file (e nei blocchi di codice, se la UI lo vuole). Predefinito 'system-mono'. */
  editorFont: CodeFont
  /** Altezza delle righe della sidebar. Predefinita 'comfortable'. */
  sidebarDensity: 'comfortable' | 'compact'
  /** Editor esterno di "Apri nell'editor"; ProjectUiState.editor lo sostituisce per un progetto. Se non è installato si ripiega sul primo installato (Cursor, VS Code, Zed, Xcode). Predefinito 'cursor'. */
  editor: EditorId
  /** Cartella dei worktree nuovi (assoluta; `~` iniziale accettata); null = predefinita (~/Developer/.ladder/worktrees o ~/.ladder/worktrees). Valori non assoluti diventano null. */
  worktreesDir: string | null
  /** Prefisso dei branch dei worktree nuovi, per esempio 'ladder/' (predefinito) o 'nico/'. Vuoto = nessun prefisso. Valori non validi per git tornano al predefinito. */
  branchPrefix: string

  // ── LAD-22: dati e sistema ──
  /** Archivia le sessioni ferme (senza turno, richieste o coda) da tanti giorni; null = mai (predefinito). 1–365. Vedi l'evento `sessions.autoArchived`. */
  autoArchiveDays: number | null
  /** Apre Ladder all'accesso (app.setLoginItemSettings). Ha effetto solo nell'app installata; in sviluppo resta false. Predefinito false. */
  openAtLogin: boolean
  /** Tiene il Mac sveglio (powerSaveBlocker 'prevent-app-suspension': lo schermo può spegnersi) finché almeno una sessione sta lavorando. Predefinito false. */
  keepAwake: boolean
  /** Suono delle notifiche quando `sound` è attivo: 'default' o il nome di un suono di sistema di macOS. Predefinito 'default'. */
  soundName: RequestSound
}

export type TextSize = 'small' | 'default' | 'large' | 'xlarge'
/** system-mono: SF Mono / Cascadia Mono / Consolas; monaspace-neon è incluso nell'app. */
export type CodeFont = 'system-mono' | 'monaspace-neon'
export type RequestSound = 'default' | 'Glass' | 'Ping' | 'Pop' | 'Hero' | 'Submarine' | 'Funk' | 'Tink'

/** system-mono: SF Mono / Cascadia Mono / Consolas; system-sans: SF Pro / Segoe UI. */
export type ChatFont = 'system-mono' | 'system-sans' | 'mona-sans' | 'monaspace-neon'

/** Cosa sta guardando la finestra: il main non notifica una richiesta della sessione che hai davanti. */
export interface WindowView {
  projectId: string | null
  sessionId: string | null
  /** Tutte le sessioni visibili nella finestra (colonne affiancate comprese); sessionId è quella attiva. */
  visibleSessionIds?: string[]
}

// ── Browser integrato (LAD-57, prima parte) ──────────────────────────────
// Una WebContentsView del main per tab, con partizione `persist:project-<id>`: cookie e sessioni separati
// da quelli dell'utente e tra progetti. La UI comunica solo il rettangolo e i comandi; il main gestisce la vista.

/** Rettangolo della vista in pixel CSS della finestra (coordinate del renderer, origine in alto a sinistra). */
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserLoadError {
  /** Codice di rete di Chromium (es. -102 connessione rifiutata); 0 per errori nostri (schema bloccato, pagina morta). */
  code: number
  description: string
  url: string
}

/** Stato di una tab browser; il main lo invia intero a ogni cambiamento (evento `ladder:browser-event`). */
export interface BrowserState {
  tabId: string
  projectId: string
  /** Indirizzo corrente (anche durante il caricamento); stringa vuota prima della prima navigazione. */
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Errore dell'ultimo caricamento del frame principale; null appena parte una nuova navigazione. */
  error: BrowserLoadError | null
  /**
   * Avviso non bloccante: un link mailto: o di altro schema non web è stato bloccato dal frame principale. La pagina resta
   * quella di prima (non è un `error`). Già tradotto; si azzera quando parte una nuova navigazione. Assente = null.
   */
  notice?: string | null
  // ── LAD-57 parte 2 ──
  /** Presente solo nella tab del browser dell'agente (tabId `agent:<sessionId>`): partizione isolata, in memoria. Assente = tab dell'utente. */
  agent?: { sessionId: string } | null
  // ── Fine LAD-57 parte 2 ──
}

/** Scorciatoia dell'app premuta mentre la pagina del browser ha il focus (evento `ladder:browser-shortcut`): il renderer la tratta come un keydown. */
export interface BrowserShortcut {
  key: string
  code: string
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
}

export type BrowserAction = 'back' | 'forward' | 'reload' | 'hard-reload' | 'stop' | 'focus' | 'devtools'

/** Esito di navigate: `error` è un testo già traducibile da mostrare (indirizzo vuoto o schema non permesso). */
export type BrowserNavigateResult = { ok: true; url: string } | { ok: false; error: string }
// ── Fine browser integrato ───────────────────────────────────────────────

// ── LAD-57 parte 2: strumenti del browser per l'agente ───────────────────
// Il browser dell'agente è una tab Browser dell'utente, marcata "agente" (BrowserState.agent), con partizione isolata e in memoria
// (`project-<id>-agent-<sessionId>`, senza `persist:`): nessun cookie né storage dell'utente, tutto cancellato a fine sessione.
// Gli strumenti sono un server MCP dell'host (HTTP su 127.0.0.1, token per sessione) registrato negli adapter solo se
// AppPrefs.agentBrowser / ProjectUiState.agentBrowser è acceso. Il main possiede la vista e la pilota su richiesta dell'host.
//
// Flusso UI:
//  1. L'agente chiama uno strumento → il main crea la vista (nascosta) e l'host emette `browser.agent` con `tabId`.
//  2. La UI, vedendo `state.tabId` nuovo, apre la tab Browser con quell'id (window.ladder.browser.open(tabId, projectId) restituisce
//     la vista già creata; per un id `agent:` che non esiste il main risponde null) e la mostra: l'agente lavora in vista.
//     Se la tab non è visibile, screenshot e click funzionano peggio (vista nascosta): conviene portarla in primo piano.
//  3. `action` è l'azione in corso (una sola alla volta), `last` l'ultima conclusa. Ogni chiamata arriva anche in chat come card
//     strumento (`mcp__ladder-browser__browser_*`), e le conferme come normali richieste di approvazione (RequestItem, toolName `browser_*`).
//  4. Stop: `browser.agent.stop` (pulsante nella tab o nella chat). Chiudere la tab dell'agente vale come stop definitivo.
//     Per la UI: `stopped` = mostra "Agent browser stopped" con un pulsante Resume (`browser.agent.resume`).

/** Gli strumenti che l'agente vede. */
export type AgentBrowserTool = 'browser_navigate' | 'browser_read_page' | 'browser_screenshot' | 'browser_click' | 'browser_type' | 'browser_console'

export interface AgentBrowserAction {
  tool: AgentBrowserTool
  /** Su cosa agisce, già pronto da mostrare: l'indirizzo, o `e12 · "Save"`; null per read/screenshot/console. Il testo digitato non c'è. */
  target: string | null
  at: number
}

export interface AgentBrowserState {
  sessionId: string
  projectId: string
  /** Id della tab Browser dell'agente (`agent:<sessionId>`), da passare a window.ladder.browser.*; null finché la vista non è stata creata o dopo la chiusura. */
  tabId: string | null
  /** Strumenti attivi per questa sessione. false: interruttore spento (lo stato non si emette se non c'è mai stato un browser). */
  enabled: boolean
  /**
   * Fermato: gli strumenti rifiutano ogni chiamata. Vale per lo stop esplicito dell'utente e per la chiusura della tab, fino a `browser.agent.resume`
   * (anche dopo la chiusura: lo stato resta, `tabId` è null e la tab si ricrea alla prima azione dell'agente). La UI lo offre dalla palette comandi
   * e dal menu "+" della barra delle tab. L'interruzione del turno non imposta `stopped`: ferma l'azione in corso e il turno dopo riparte da sé.
   */
  stopped: boolean
  /** Il browser dell'agente non c'è più (sessione chiusa o interruttore spento): la UI chiude la tab. */
  closed: boolean
  /** Azione in corso (anche in attesa della tua conferma); null se nessuna. */
  action: (AgentBrowserAction & { waitingForYou: boolean }) | null
  /** Ultima azione conclusa: `ok` false con il motivo già tradotto in `error`. */
  last: (AgentBrowserAction & { ok: boolean; error?: string | null }) | null
  /** Domini fuori da localhost che hai autorizzato in questa sessione (si azzera alla chiusura). */
  allowedHosts: string[]
}

/**
 * Canale host → main (HostToMain `browser-agent`). Il main risponde sempre con dati semplici (stringhe, numeri): nessun contenuto della
 * pagina viene mai interpretato come comando. `sessionId` identifica la vista; il main ricontrolla da sé ogni indirizzo.
 */
export type BrowserAgentOp =
  /** Crea la vista se manca. `projectId` per la partizione. */
  | { op: 'open'; sessionId: string; projectId: string }
  | { op: 'navigate'; sessionId: string; url: string }
  | { op: 'read'; sessionId: string; maxChars: number; maxElements: number }
  | { op: 'screenshot'; sessionId: string }
  | { op: 'click'; sessionId: string; ref: string }
  | { op: 'type'; sessionId: string; ref: string; text: string }
  | { op: 'console'; sessionId: string; limit: number }
  /**
   * Cosa la tab può aprire oltre a localhost. Con `host: null` riparte da zero: svuota i domini ammessi e fissa `any` (true solo per Full access).
   * Con `host` AGGIUNGE quel dominio senza svuotare nulla (né `any`): chi chiama manda prima `host: null` e poi un'aggiunta per ogni dominio ammesso
   * (approvati per la sessione, più quello approvato una volta). `any` vale solo nel messaggio con `host: null`.
   */
  | { op: 'allow'; sessionId: string; host: string | null; any?: boolean }
  /** Ferma caricamento e azione in corso. Con `freeze` (stop dell'utente, predefinito) il main rifiuta ogni operazione fino a `resume`; senza, solo un timeout. */
  | { op: 'stop'; sessionId: string; freeze?: boolean }
  | { op: 'resume'; sessionId: string }
  /** Distrugge la vista e svuota la partizione. */
  | { op: 'close'; sessionId: string }

export interface AgentPageElement {
  /** Riferimento stabile per click/type (`e12`): vale finché il documento è lo stesso. */
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
  | { ok: true; url?: string; title?: string; text?: string; elements?: AgentPageElement[]; truncated?: boolean; image?: { mediaType: string; data: string }; /** Avvertenza già tradotta (es. screenshot uniforme). */ note?: string; messages?: { level: string; text: string }[]; tabId?: string }
  /** `error` è già tradotto; `code` distingue il caso per l'host: `blocked` = indirizzo non ammesso, `stopped`, `closed`, `timeout`, `stale-ref`, `failed`. */
  | { ok: false; code: 'blocked' | 'stopped' | 'closed' | 'timeout' | 'stale-ref' | 'failed'; error: string; host?: string }
// ── Fine LAD-57 parte 2 ──────────────────────────────────────────────────

// ── LAD-59: testi scritti da un modello ──────────────────────────────────────

/** Quanto del diff non è arrivato al modello (limite di caratteri): file tagliati o saltati e caratteri non inviati. */
export interface GeneratedTextCut {
  files: number
  chars: number
}

/** Risposta di `text.commit`. `body` vuoto = solo oggetto. Il testo è sempre una proposta da modificare. */
export interface GeneratedCommit {
  subject: string
  body: string
  /** Quale diff è stato descritto. */
  source: 'staged' | 'working'
  /** File modificati nel diff descritto. */
  files: number
  truncated: GeneratedTextCut | null
}

// ── LAD-59 commit ──
/** Oggetto del commit più lungo accettato dall'host (`git.commit`); la UI usa lo stesso limite. */
export const MAX_COMMIT_SUBJECT = 200
/** Titolo e descrizione della PR più lunghi accettati da `pr.prepare`. */
export const MAX_PR_TITLE = 256
export const MAX_PR_BODY = 65_000

/** Risposta di `pr.prepare`: il prompt da mandare alla sessione e i file scritti. */
export interface PrPrepared {
  prompt: string
  titlePath: string
  bodyPath: string
}

/** Risposta di `git.commit`: hash corto del nuovo commit e oggetto (senza spazi ai bordi). */
export interface GitCommitResult {
  hash: string
  subject: string
}
// ── fine LAD-59 commit ──

// ── LAD-68 ──
/**
 * Stato git di una cartella per l'intestazione della sessione. Stessa fonte dei campi comuni di `MergeInfo`
 * (`dirty`, `unpushed` = `ahead` se `hasUpstream`, `hasUpstream`).
 */
export interface GitStatus {
  /** Cartella di lavoro (worktree se la sessione ne ha uno): chiave per abbinare l'evento `git.status`. */
  root: string
  /** Branch corrente; null con HEAD staccato. */
  branch: string | null
  /** Upstream del branch, per esempio "origin/main"; null se non pubblicato (o HEAD staccato). */
  upstream: string | null
  hasUpstream: boolean
  /** Commit da inviare (HEAD ha, l'upstream no): la freccia ↑. 0 se non c'è upstream (leggi `hasUpstream`). */
  ahead: number
  /** Commit da scaricare (l'upstream ha, HEAD no): la freccia ↓, aggiornata dal fetch in background. */
  behind: number
  /** File con modifiche non committate (stage, cartella di lavoro e non tracciati non ignorati). */
  dirty: number
  /** Righe aggiunte/tolte dalle modifiche non committate (stage + cartella di lavoro vs HEAD; i file nuovi contano per intero). 0 se dirty è 0. */
  added: number
  removed: number
  isWorktree: boolean
}
// ── fine LAD-68 ──

// ── LAD-80 ──
/** Perché una riga della mappa non ha i numeri: i campi dipendenti sono null. */
export type BranchMapProblem =
  /** La sessione non ha un branch (HEAD staccato sul checkout principale). */
  | 'detached'
  /** Il branch non esiste più (cancellato, o repository senza commit). */
  | 'branch_missing'
  /** Il ramo principale non esiste (repository senza commit, base cancellata). */
  | 'no_base'
  /** Il branch e il ramo principale hanno storie non correlate: nessun merge-base. */
  | 'no_merge_base'

/**
 * Una sessione sulla mappa. Tutti i tempi sono ms; l'asse X lo normalizza la UI. Lo stato "a parole" lo calcola la UI da `run`,
 * `archived` e `merged` come per la sidebar (in esecuzione = running/starting, ti aspetta = waiting, unita = merged, ferma = il resto).
 */
export interface BranchMapEntry {
  sessionId: string
  title: string
  agent: AgentId
  run: RunState
  archived: boolean
  /** Ultima attività della sessione: ordina la mappa (le più recenti prima) e decide "gli ultimi 6 attivi". */
  activityAt: number
  /** Stato della PR del branch se già in cache (nessuna chiamata a gh per costruire la mappa); null se ignoto o senza PR. */
  prState: PrStatus['state'] | null
  /** false: la sessione lavora sul checkout principale. L'host manda solo quelle sul ramo principale (`isBase`), le ultime 20: servono a "sei su main". */
  isWorktree: boolean
  /** La cartella del worktree non esiste più (il branch può esserci ancora: i numeri sono quelli del branch). */
  worktreeMissing: boolean
  /** null con HEAD staccato. */
  branch: string | null
  /** Il branch è il ramo principale stesso (sessione sul checkout principale): niente curva, nessun conteggio. */
  isBase: boolean
  problem: BranchMapProblem | null
  /** Punto di stacco da main (`git merge-base`): sha completo e data del commit. Null con `problem`. */
  mergeBase: string | null
  mergeBaseAt: number | null
  /** Commit del branch non nel ramo principale (↑) e del ramo principale non nel branch (↓). Da `merged` in poi hanno poco senso: con lo squash ↑ resta > 0. */
  ahead: number | null
  behind: number | null
  /**
   * Unito: 'git' = il branch è già tutto nel ramo principale E c'è la prova che ha avuto commit propri: un merge commit del ramo
   * principale che lo cita come genitore, oppure (fast-forward) il suo branch su origin, arrivato dopo la nascita, è dentro il ramo
   * principale. Un branch solo "avanzato" lungo main (pull, reset) NON è unito. 'pr' = la PR del branch è unita (squash e rebase
   * compresi), era già in cache e il branch non ha commit dopo di lei (oggetto della PR non scaricato: non unito). Gli archiviati
   * uniti si ricordano dopo un riavvio (colonne `merged_via`/`merged_at`). Nel dubbio null: meglio un mancato "unito" che uno falso.
   */
  merged: 'git' | 'pr' | null
  /** Quando: merge commit sul ramo principale se c'è (git), `mergedAt` della PR (pr), data dell'ultimo commit del branch come ripiego. Null se non unito. */
  mergedAt: number | null
  /** Ultimo commit del branch. */
  lastCommit: { subject: string; at: number } | null
  /** Righe aggiunte/tolte dai commit del branch rispetto al merge-base (non le modifiche non committate). */
  added: number | null
  removed: number | null
  /** File con modifiche non committate, solo se il tracker git ha già letto la cartella; altrimenti null. */
  dirty: number | null
  /**
   * Riga del checkout principale su un branch che NON è il ramo principale (per esempio `development` con `main` come base): una sola
   * per progetto, letta dal git (compare anche senza sessioni). `sessionId` è la sessione più recente non archiviata del checkout
   * principale, o `main-checkout:<projectId>` se non ce n'è (allora non si apre); `isWorktree` è false e `branch` il branch estratto.
   * `dirty` sono i file non committati del checkout principale. Con HEAD staccato la riga non c'è.
   */
  mainCheckout?: true
}

export interface BranchMap {
  projectId: string
  /**
   * Ramo principale, letto senza rete (origin/HEAD, poi main o master; se il pannello Merge l'ha già risolto con gh vale quello).
   * Una PR verso un altro ramo cambia la base del pannello Merge ma non quella della mappa. Null se il progetto non è git o la cartella non c'è.
   */
  base: string | null
  /** Data dell'ultimo commit del ramo principale (fine della linea di main); null se non si legge. */
  baseAt: number | null
  /** Sha completo dell'ultimo commit del ramo principale (la stessa ref di `baseAt`); null se non si legge. */
  baseSha: string | null
  /** Al massimo 50 righe di worktree (attivi o uniti), le più recenti, più le ultime 20 sessioni sul ramo principale; le altre non ci sono (`hidden`). */
  entries: BranchMapEntry[]
  /** Righe che avrebbero un posto sulla mappa (worktree attivi o uniti) ma non ci sono per il limite di 50; stima per difetto. */
  hidden: number
  /** Lettura fallita: la mappa è vuota e la UI può dirlo (testo già tradotto). Assente o null se è andata bene. */
  error?: string | null
}
// ── fine LAD-80 ──

// ── Branch del checkout principale ──
/** Un branch locale del progetto, per il menu del branch e per la scelta del punto di partenza di un worktree. */
export interface LocalBranch {
  name: string
  /** Data (ms) e titolo dell'ultimo commit. */
  at: number
  subject: string
  /** È il branch estratto nel checkout principale. */
  current: boolean
  /** Cartella del worktree che lo ha estratto (non il checkout principale): git vieta di estrarlo anche altrove. Null se libero. */
  worktree: string | null
}

/** Risposta di `project.branches`. */
export interface ProjectBranches {
  projectId: string
  /** Branch del checkout principale; null con HEAD staccato. */
  current: string | null
  /** Branch locali, l'ultimo commit più recente prima. */
  branches: LocalBranch[]
  /** File con modifiche non committate nel checkout principale (anche non tracciati). */
  dirty: number
  /** Sessione del checkout principale (non in worktree) con un turno o dei sotto-agenti al lavoro: finché c'è, il cambio di branch è rifiutato. */
  busy: { sessionId: string; title: string } | null
  /** Cartella in cui finiscono i worktree di questo progetto (con `~` al posto della cartella di casa), per mostrarla nella nuova chat. */
  worktreesFolder: string
}

/** Risposta di `project.branch.switch` e `project.branch.create`. */
export interface BranchSwitchResult {
  branch: string
  /** Messaggio dello stash creato prima del cambio (`git stash push -u`); null se non c'è stato. */
  stash: string | null
}
// ── fine Branch del checkout principale ──

// ── LAD-69 ──
export type PrMergeMethod = 'merge' | 'squash' | 'rebase'

/** Anteprima di `git.push.preview`. */
export interface GitPushPreview {
  branch: string
  /** Remote a cui andrebbe il push; null se manca (vedi `problem`). */
  remote: string | null
  /** Remote del repository (`git remote`): per far scegliere quando `problem` è 'choose-remote'. */
  remotes: string[]
  /** Upstream attuale, per esempio "origin/feat"; null se il branch non è pubblicato (o l'upstream è sparito). */
  upstream: string | null
  /** Destinazione esatta del push, per esempio "origin/feat" (`<remote>/<branch locale>`); null se manca il remote (vedi `problem`). */
  target: string | null
  /** L'upstream attuale punta altrove (altro nome di branch o altro remote): NON è la destinazione e dopo il push diventa `target`. Altrimenti null. */
  upstreamElsewhere: string | null
  /** Sha completo di HEAD al momento dell'anteprima: la UI lo rimanda in `git.push.expectedHead`. '' se il branch non ha commit. */
  head: string
  /** Il push imposta l'upstream su `target` (`-u`): branch non pubblicato, o con upstream altrove. */
  willPublish: boolean
  /** Fino a 50 commit che verrebbero inviati, il più recente prima. */
  commits: { hash: string; subject: string }[]
  /** Numero totale dei commit da inviare (può superare commits.length). */
  total: number
  /** Commit dell'upstream che il branch non ha (da ultimo fetch): se > 0 e total > 0 il push verrebbe rifiutato. */
  behind: number
  /** Il push verrebbe rifiutato perché non è un fast-forward (behind > 0 e total > 0): serve prima integrare l'upstream. */
  wouldBeRejected: boolean
  /** no-remote: il repo non ha remote. choose-remote: più remote e nessun upstream, serve `remote`. */
  problem: 'no-remote' | 'choose-remote' | null
}

/** Risposta di `git.push`. */
export interface GitPushResult {
  branch: string
  remote: string
  /** Commit inviati (contati prima del push sull'upstream o, se si pubblica, su ciò che il remote non ha). */
  pushed: number
  /** Upstream dopo il push, per esempio "origin/feat". */
  upstream: string
  /** Il branch è stato pubblicato con questo push (prima non aveva upstream). */
  published: boolean
}

/** Risposta di `pr.merge`. */
export interface PrMergeResult {
  number: number
  method: PrMergeMethod
  /** PR riletta dopo il merge (di norma state 'merged'); null se gh non l'ha restituita. */
  pr: PrStatus | null
  /** Branch remoto cancellato (solo se richiesto con `deleteBranch`). */
  branchDeleted: boolean
  /** Perché il branch remoto non è stato cancellato, se richiesto e fallito (il merge è comunque riuscito). */
  branchDeleteError: string | null
}

/** Risposta di `git.archive`. */
export interface GitArchiveResult {
  /** La sessione è stata archiviata. */
  archived: true
  worktreeRemoved: boolean
  /** Perché il worktree è rimasto: 'none' (la sessione non ha un worktree), 'shared' (un'altra sessione lo usa), 'dirty' (file non committati), 'failed' (git l'ha rifiutato). Il branch resta sempre. */
  worktreeKept: 'none' | 'shared' | 'dirty' | 'failed' | null
  /** 'failed': perché git non l'ha tolto (stderr ripulito e accorciato); altrimenti assente o null. */
  worktreeError?: string | null
}

/** Cosa impedisce di unire la PR, in ordine di priorità (il primo è il motivo mostrato nel tooltip di Merge). */
export type MergeBlockKind = 'draft' | 'conflicts' | 'ci_failing' | 'ci_pending' | 'changes_requested' | 'review_required' | 'behind' | 'blocked'

export interface MergeBlock {
  kind: MergeBlockKind
  /** conflicts: file in conflitto; ci_failing / ci_pending: numero di check. */
  count?: number
}

/** Passo successivo del pannello: Commit → Push/Pubblica → Crea PR → Merge → Archivia. */
export type NextActionKind = 'commit' | 'push' | 'publish' | 'create_pr' | 'merge' | 'archive' | 'none'

/**
 * Perché il passo è disabilitato (`blocked`) o la spiegazione di 'none'/'create_pr':
 * detached (HEAD staccato), default_branch (niente PR sul branch predefinito), no_remote, no_commits (niente rispetto alla base),
 * github_missing / github_unauthenticated / no_github_remote / github_error (gh non pronto), pr_closed (la PR precedente è chiusa:
 * se ne apre un'altra), behind_upstream (l'upstream ha commit che il branch non ha: il push verrebbe rifiutato), agent_busy (l'agente
 * sta lavorando), dirty / unpushed (Archivia con modifiche o commit non inviati), oppure il primo MergeBlockKind.
 */
export type NextActionReason =
  | 'detached' | 'default_branch' | 'no_remote' | 'no_commits' | 'github_missing' | 'github_unauthenticated' | 'no_github_remote' | 'github_error'
  | 'pr_closed' | 'behind_upstream' | 'agent_busy' | 'dirty' | 'unpushed'
  | MergeBlockKind

export interface NextAction {
  kind: NextActionKind
  /** Il pulsante principale è disabilitato (con `reason` nel tooltip). 'none' è sempre blocked. */
  blocked: boolean
  reason: NextActionReason | null
}
// ── fine LAD-69 ──

/** Risposta di `text.pr`. `body` include già il collegamento all'issue (riga "Closes …") se c'è. */
export interface GeneratedPr {
  title: string
  body: string
  /** Issue collegata: da source della sessione o citata nel primo messaggio; null se non c'è. */
  issue: { ref: string; url: string | null } | null
  /** Branch di base del confronto. */
  base: string
  files: number
  truncated: GeneratedTextCut | null
}
// ── fine LAD-59 ──
