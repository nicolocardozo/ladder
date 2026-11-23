// Conversazioni d'esempio per la pagina di anteprima della chat (pnpm dev:web → /preview.html).
import type { AgentStatus, ChatItem, ConnectionId, ConnectionStatus, FileChange, Profile, Question, RequestOption, SlashCommand, SubagentDetail, SubagentInfo, ToolKind, UsageWindow } from '@shared/protocol'

import { t } from '@shared/i18n'

type Kind<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>
type Omitted<K extends ChatItem['kind']> = Omit<Kind<K>, 'id' | 'turnId' | 'seq' | 'at' | 'kind'>

/** Costruisce elementi con id, seq e orari coerenti. */
export class ConversationBuilder {
  items: ChatItem[] = []
  private seq = 0
  private turnId = 't0'
  private turnCount = 0
  constructor(
    private clock = Date.now() - 3 * 60 * 60 * 1000,
    private prefix = 'i'
  ) {}

  private push<K extends ChatItem['kind']>(kind: K, fields: Omitted<K>, advanceMs: number): Kind<K> {
    this.clock += advanceMs
    const seq = ++this.seq
    const item = { id: `${this.prefix}${seq}`, turnId: this.turnId, seq, at: this.clock, kind, ...fields } as unknown as Kind<K>
    this.items.push(item)
    return item
  }

  get now() {
    return this.clock
  }

  /** Sposta tutti gli orari in modo che l'ultimo elemento sia di `agoMs` fa: le durate "da 3 min" restano credibili. */
  shiftToNow(agoMs = 20_000) {
    const delta = Date.now() - agoMs - this.clock
    for (const item of this.items) {
      item.at += delta
      if (item.kind === 'tool' && item.endedAt !== null) item.endedAt += delta
    }
    this.clock += delta
    return this.items
  }

  turn() {
    this.turnId = `${this.prefix}-turn-${++this.turnCount}`
    return this
  }

  user(text: string, gapMs = 90_000, attachments?: { name: string; mediaType: string }[]) {
    return this.push('user', attachments ? { text, attachments } : { text }, gapMs)
  }

  assistant(text: string, streaming = false, afterMs = 4_000) {
    return this.push('assistant', { text, streaming }, afterMs)
  }

  tool(
    tool: ToolKind,
    name: string,
    title: string,
    detail: string | null,
    opts: { status?: Kind<'tool'>['status']; output?: string | null; ms?: number } = {}
  ) {
    const ms = opts.ms ?? 1_400
    const status = opts.status ?? 'done'
    const item = this.push('tool', { tool, name, title, detail, status, output: opts.output ?? null, endedAt: null }, 900)
    if (status !== 'running') {
      item.endedAt = item.at + ms
      this.clock += ms
    }
    return item
  }

  permission(fields: {
    toolName: string
    title: string
    command?: string | null
    path?: string | null
    reason?: string | null
    options?: RequestOption[]
    state?: Kind<'request'>['state']
    resolution?: string | null
  }) {
    return this.push(
      'request',
      {
        requestId: `req-${this.seq + 1}`,
        requestType: 'permission',
        toolName: fields.toolName,
        title: fields.title,
        command: fields.command ?? null,
        path: fields.path ?? null,
        reason: fields.reason ?? null,
        options: fields.options ?? defaultOptions('pnpm add'),
        questions: null,
        state: fields.state ?? 'open',
        resolution: fields.resolution ?? null
      },
      1_200
    )
  }

  question(questions: Question[], state: Kind<'request'>['state'] = 'open', resolution: string | null = null) {
    return this.push(
      'request',
      {
        requestId: `req-${this.seq + 1}`,
        requestType: 'question',
        toolName: 'AskUserQuestion',
        title: 'Claude Code ha una domanda',
        command: null,
        path: null,
        reason: null,
        options: [],
        questions,
        state,
        resolution
      },
      1_500
    )
  }

  end(fields: Partial<Omitted<'turn-end'>> & { durationMs: number }) {
    return this.push(
      'turn-end',
      {
        status: fields.status ?? 'completed',
        durationMs: fields.durationMs,
        counts: fields.counts ?? { commands: 0, edits: 0, reads: 0, searches: 0 },
        files: fields.files ?? [],
        error: fields.error ?? null,
        costUsd: fields.costUsd ?? null,
        ...(fields.stalled ? { stalled: true } : {})
      },
      600
    )
  }

  notice(text: string, tone: 'info' | 'error' = 'info') {
    return this.push('notice', { text, tone }, 2_000)
  }

  /** Comando / eseguito dall'utente: riga di sistema. */
  agentStart(reason: Kind<'agent-start'>['reason'], finished: number | null) {
    return this.push('agent-start', { reason, finished }, 1_000)
  }

  /** Fine dei sotto-agenti in background con il coordinatore fermo. */
  agentsFinished(state: Kind<'agents-finished'>['state'], finished: number, failed = 0) {
    return this.push('agents-finished', { finished, failed, state }, 2_000)
  }

  command(name: string, args = '', status: Kind<'command'>['status'] = 'done', error: string | null = null) {
    return this.push('command', { name, args, status, error }, 30_000)
  }

  /** Contesto compattato, a mano o in automatico. */
  compacted(trigger: Kind<'compacted'>['trigger'], preTokens: number | null = null, postTokens: number | null = null) {
    return this.push('compacted', { trigger, preTokens, postTokens }, 4_000)
  }
}

export function defaultOptions(rule: string): RequestOption[] {
  return [
    { id: 'allow', label: 'Approva', kind: 'allow' },
    { id: 'allow-always', label: `Consenti sempre ${rule}`, kind: 'allow-always' },
    { id: 'deny', label: 'Rifiuta', kind: 'deny' }
  ]
}

const VITEST_FAIL = `
 RUN  v3.2.4 /Users/dev/Developer/acme-monorepo/apps/web

 ❯ src/features/payments/PaymentsTable.test.tsx (9 tests | 2 failed) 412ms
   ✓ mostra le righe della prima pagina
   ✓ filtra per stato
   × mantiene il filtro quando cambio pagina
     → expected "scaduti" to be "tutti"
   × ripristina i filtri dopo il refresh
     → Unable to find an element with the text: Scaduti
   ✓ azzera la pagina quando cambia il filtro
   ✓ ordina per importo
   ✓ esporta CSV
   ✓ mostra lo stato vuoto
   ✓ gestisce l'errore di rete

 Test Files  1 failed (1)
      Tests  2 failed | 7 passed (9)
   Start at  10:14:02
   Duration  1.84s`.trim()

const VITEST_PASS = `
 RUN  v3.2.4 /Users/dev/Developer/acme-monorepo/apps/web

 ✓ src/features/payments/PaymentsTable.test.tsx (9 tests) 388ms
 ✓ src/features/payments/useTableFilters.test.ts (4 tests) 21ms

 Test Files  2 passed (2)
      Tests  13 passed (13)
   Start at  10:15:31
   Duration  1.62s`.trim()

const PLAYWRIGHT_OUTPUT = [
  'Running 14 tests using 4 workers',
  '',
  ...Array.from({ length: 48 }, (_, i) =>
    i % 7 === 3
      ? `  ✘  ${i + 1} [chromium] › payments.spec.ts:${20 + i}:5 › filtri › scenario ${i + 1} (5.0s)`
      : `  ✓  ${i + 1} [chromium] › payments.spec.ts:${20 + i}:5 › filtri › scenario ${i + 1} (${(0.6 + (i % 5) * 0.3).toFixed(1)}s)`
  ),
  '',
  '  1) [chromium] › payments.spec.ts:23:5 › filtri › scenario 4',
  '',
  '    Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/pagamenti',
  '',
  '  7 failed',
  '  41 passed (1.2m)',
  'Error: process exited with code 1'
].join('\n')

const FILTERS_DIFF = `@@ -0,0 +1,38 @@
+import { useSearchParams } from 'react-router-dom'
+
+export type PaymentStatus = 'tutti' | 'pagati' | 'scaduti' | 'in-attesa'
+
+export function useTableFilters() {
+  const [params, setParams] = useSearchParams()
+  const status = (params.get('stato') as PaymentStatus | null) ?? 'tutti'
+  const page = Number(params.get('pagina') ?? '1')
+
+  const setStatus = (value: PaymentStatus) =>
+    setParams((p) => {
+      p.set('stato', value)
+      p.delete('pagina')
+      return p
+    })`

const TABLE_DIFF = `@@ -12,17 +12,9 @@ export function PaymentsTable() {
-  const [status, setStatus] = useState<PaymentStatus>('tutti')
-  const [page, setPage] = useState(1)
-
-  useEffect(() => {
-    setPage(1)
-  }, [status])
+  const { status, setStatus, page, setPage } = useTableFilters()
   const { data, isLoading } = usePayments({ status, page })`

const FINAL_1 = `Ho spostato lo stato dei filtri da \`useState\` a un hook basato su \`useSearchParams\`. La paginazione legge e scrive gli stessi parametri, quindi i filtri restano quando cambi pagina o ricarichi.

Il punto da cui partire è \`src/features/payments/useTableFilters.ts\`, usato in \`src/features/payments/PaymentsTable.tsx:48\`.

\`\`\`ts src/features/payments/useTableFilters.ts
export function useTableFilters() {
  const [params, setParams] = useSearchParams()
  const status = (params.get('stato') as PaymentStatus | null) ?? 'tutti'
  const page = Number(params.get('pagina') ?? '1')

  // Cambiare filtro riporta alla prima pagina: niente pagine vuote.
  const setStatus = (value: PaymentStatus) =>
    setParams((p) => { p.set('stato', value); p.delete('pagina'); return p })

  return { status, setStatus, page, setPage: (n: number) => setParams((p) => { p.set('pagina', String(n)); return p }) }
}
\`\`\`

Cosa cambia per chi usa la tabella:

- i link condivisi aprono la tabella con gli stessi filtri, per esempio \`/pagamenti?stato=scaduti&pagina=2\`;
- il pulsante **Indietro** del browser torna al filtro precedente;
- \`usePayments\` non cambia: riceve ancora \`{ status, page }\`.

Ho aggiunto due casi in \`PaymentsTable.test.tsx\`: cambio pagina e ricarica. \`pnpm vitest run payments\` passa con 13 test.`

const FINAL_2 = `Per questi filtri la URL è la fonte di verità più semplice, e il motivo principale è che li vuoi condivisibili.

| | \`useSearchParams\` | Store Zustand |
|---|---|---|
| Sopravvive al refresh | Sì | Solo con \`persist\` |
| Link condivisibile | Sì | No |
| Indietro del browser | Funziona | Va gestito a mano |
| Stato tra pagine diverse | Per pagina | Globale |

Uno store ha senso quando lo stesso filtro serve in più schermate contemporaneamente, per esempio una sidebar che mostra i conteggi. Qui non succede.

> Se in futuro servirà, puoi sincronizzare lo store dalla URL in un solo punto, senza toccare i componenti.

Un dettaglio da sapere: \`setParams\` crea una voce nella cronologia a ogni cambio. Se il filtro di ricerca testuale finisse nella URL, conviene usare \`{ replace: true }\` per non riempire la cronologia a ogni tasto.`

const FINAL_3 = `Il filtro per intervallo di date usa lo stesso \`DateRangePicker\` di Movimenti e salva le date nella URL come \`dal\` e \`al\` in formato ISO.

\`\`\`tsx src/features/payments/PaymentsFilters.tsx
<DateRangePicker
  value={{ from: dateFrom, to: dateTo }}
  onChange={({ from, to }) => setRange(from, to)}
  presets={['ultimi-7-giorni', 'mese-corrente', 'mese-scorso']}
/>
\`\`\`

Il cambiamento in \`usePayments\` è piccolo:

\`\`\`diff
-  const { data } = useQuery(['payments', status, page], () => fetchPayments({ status, page }))
+  const { data } = useQuery(['payments', status, page, from, to], () =>
+    fetchPayments({ status, page, from, to })
+  )
\`\`\`

Non ho aggiunto \`dayjs\` alla root come avevo proposto: uso \`date-fns\`, già presente in \`apps/web/package.json\`.

1. Apri \`/pagamenti\` e scegli **Mese scorso**.
2. Ricarica: l'intervallo resta.
3. Cambia pagina: l'intervallo resta e la pagina torna alla prima solo se cambi filtro.`

function payments(b: ConversationBuilder) {
  b.turn()
  b.user(
    'La tabella pagamenti perde i filtri quando cambio pagina. Tienili nella URL, così restano anche dopo un refresh o in un link condiviso, e aggiungi un test.'
  )
  b.tool('search', 'Grep', 'Cerca useState nei filtri dei pagamenti', 'useState<PaymentStatus>', {
    output: 'src/features/payments/PaymentsTable.tsx:12:  const [status, setStatus] = useState<PaymentStatus>(\'tutti\')\nsrc/features/payments/PaymentsFilters.tsx:8:  status: PaymentStatus',
    ms: 300
  })
  b.tool('read', 'Read', 'Legge src/features/payments/PaymentsTable.tsx', 'src/features/payments/PaymentsTable.tsx', { ms: 120 })
  b.tool('read', 'Read', 'Legge src/features/payments/usePayments.ts', 'src/features/payments/usePayments.ts', { ms: 90 })
  b.assistant(
    'Lo stato dei filtri vive in `PaymentsTable.tsx` con `useState`, e `usePayments.ts` lo riceve come argomento. Lo sposto in un hook che legge e scrive i parametri della URL, così la tabella non deve sapere da dove arrivano.'
  )
  b.tool('command', 'Bash', 'Esegue git status --short', 'git status --short', { output: '', ms: 200 })
  b.tool('edit', 'Write', 'Crea src/features/payments/useTableFilters.ts', 'src/features/payments/useTableFilters.ts', {
    output: FILTERS_DIFF,
    ms: 400
  })
  b.tool('edit', 'Edit', 'Modifica src/features/payments/PaymentsTable.tsx', 'src/features/payments/PaymentsTable.tsx', {
    output: TABLE_DIFF,
    ms: 300
  })
  b.tool('edit', 'Edit', 'Modifica src/features/payments/PaymentsTable.test.tsx', 'src/features/payments/PaymentsTable.test.tsx', {
    ms: 300
  })
  b.tool('command', 'Bash', 'Esegue pnpm vitest run payments', 'pnpm vitest run payments', {
    status: 'error',
    output: VITEST_FAIL,
    ms: 4_200
  })
  b.assistant(
    'Due test falliscono perché il render del test non ha un router: li avvolgo in `MemoryRouter` con `initialEntries`, così posso simulare anche il refresh.'
  )
  b.tool('edit', 'Edit', 'Modifica src/features/payments/PaymentsTable.test.tsx', 'src/features/payments/PaymentsTable.test.tsx', {
    ms: 250
  })
  b.tool('command', 'Bash', 'Esegue pnpm vitest run payments', 'pnpm vitest run payments', { output: VITEST_PASS, ms: 3_900 })
  b.tool('command', 'Bash', 'Esegue pnpm tsc --noEmit -p apps/web', 'pnpm tsc --noEmit -p apps/web', { output: '', ms: 6_100 })
  b.tool('command', 'Bash', 'Esegue pnpm eslint src/features/payments', 'pnpm eslint src/features/payments', { output: '', ms: 2_400 })
  b.tool('command', 'Bash', 'Esegue git diff --stat', 'git diff --stat', {
    output:
      ' src/features/payments/PaymentsTable.test.tsx | 26 ++++++++\n src/features/payments/PaymentsTable.tsx      | 63 +++++-------\n src/features/payments/useTableFilters.ts     | 38 ++++++++\n 3 files changed, 86 insertions(+), 41 deletions(-)',
    ms: 120
  })
  b.assistant(FINAL_1, false, 9_000)
  b.end({
    durationMs: 161_000,
    counts: { commands: 6, edits: 4, reads: 2, searches: 1 },
    files: [
      { path: 'src/features/payments/useTableFilters.ts', added: 38, removed: 0, status: 'A' },
      { path: 'src/features/payments/PaymentsTable.tsx', added: 22, removed: 41, status: 'M' },
      { path: 'src/features/payments/PaymentsTable.test.tsx', added: 26, removed: 0, status: 'M' }
    ],
    costUsd: 0.42
  })
}

function whyUrl(b: ConversationBuilder) {
  b.turn()
  b.user('Perché `useSearchParams` e non uno store Zustand? Negli altri moduli usiamo Zustand.')
  b.assistant(FINAL_2, false, 9_000)
  b.end({ durationMs: 9_400 })
}

function dateRange(b: ConversationBuilder) {
  b.turn()
  b.user('Aggiungi il filtro per intervallo di date con il DateRangePicker che usiamo in Movimenti.', 90_000, [
    { name: 'movimenti-filtri.png', mediaType: 'image/png' },
    { name: 'figma-intervallo-date-versione-finale-approvata.jpg', mediaType: 'image/jpeg' }
  ])
  b.tool('search', 'Glob', 'Cerca DateRangePicker', '**/DateRangePicker*.tsx', {
    output: 'src/components/DateRangePicker/DateRangePicker.tsx\nsrc/components/DateRangePicker/DateRangePicker.stories.tsx',
    ms: 200
  })
  b.tool('read', 'Read', 'Legge src/components/DateRangePicker/DateRangePicker.tsx', 'src/components/DateRangePicker/DateRangePicker.tsx', {
    ms: 110
  })
  b.permission({
    toolName: 'Bash',
    title: 'Esegue pnpm add -w dayjs',
    command: 'pnpm add -w dayjs',
    reason: 'Serve per formattare le date nella URL.',
    state: 'resolved',
    resolution: 'Rifiutato: usa date-fns, è già nel progetto'
  })
  b.tool('command', 'Bash', 'Esegue pnpm add -w dayjs', 'pnpm add -w dayjs', { status: 'denied', ms: 0 })
  b.permission({
    toolName: 'Bash',
    title: 'Esegue pnpm --filter web why date-fns',
    command: 'pnpm --filter web why date-fns',
    state: 'resolved',
    resolution: 'Approvato'
  })
  b.tool('command', 'Bash', 'Esegue pnpm --filter web why date-fns', 'pnpm --filter web why date-fns', {
    output: 'web@0.1.0 /Users/dev/Developer/acme-monorepo/apps/web\n\ndependencies:\ndate-fns 4.1.0',
    ms: 1_100
  })
  b.tool('edit', 'Edit', 'Modifica src/features/payments/PaymentsFilters.tsx', 'src/features/payments/PaymentsFilters.tsx', { ms: 300 })
  b.tool('edit', 'Edit', 'Modifica src/features/payments/useTableFilters.ts', 'src/features/payments/useTableFilters.ts', { ms: 250 })
  b.tool('edit', 'Edit', 'Modifica src/features/payments/usePayments.ts', 'src/features/payments/usePayments.ts', { ms: 200 })
  b.tool('command', 'Bash', 'Esegue pnpm vitest run payments', 'pnpm vitest run payments', { output: VITEST_PASS, ms: 3_700 })
  b.assistant(FINAL_3, false, 8_000)
  b.end({
    durationMs: 104_000,
    counts: { commands: 3, edits: 3, reads: 1, searches: 1 },
    files: [
      { path: 'src/features/payments/PaymentsFilters.tsx', added: 31, removed: 4, status: 'M' },
      { path: 'src/features/payments/useTableFilters.ts', added: 18, removed: 2, status: 'M' },
      { path: 'src/features/payments/usePayments.ts', added: 5, removed: 3, status: 'M' }
    ]
  })
}

function e2eError(b: ConversationBuilder) {
  b.turn()
  b.user('Lancia i test end-to-end di Playwright sul flusso pagamenti.')
  b.tool('command', 'Bash', 'Esegue pnpm playwright test payments', 'pnpm playwright test payments', {
    status: 'error',
    output: PLAYWRIGHT_OUTPUT,
    ms: 72_000
  })
  b.end({
    status: 'error',
    durationMs: 81_000,
    counts: { commands: 1, edits: 0, reads: 0, searches: 0 },
    error: 'Claude Code si è chiuso in modo inatteso (codice 1). Puoi riprendere la sessione dal composer.'
  })
}

/** Comandi / e compattazioni: manuale con i token, automatica senza, un comando fallito. */
function compacted(b: ConversationBuilder) {
  b.turn()
  b.command('compact', 'solo le decisioni sui filtri')
  b.compacted('manual', 142_000, 38_000)
  b.turn()
  b.compacted('auto')
  b.turn()
  b.command('review', '', 'error', 'La sessione sta lavorando: riprova a fine turno.')
}

function renameInterrupted(b: ConversationBuilder) {
  b.turn()
  b.user('Rinomina `PaymentsTable` in `PaymentsGrid` in tutto il progetto, compresi test e storie.')
  b.tool('search', 'Grep', 'Cerca PaymentsTable', 'PaymentsTable', {
    output: Array.from({ length: 14 }, (_, i) => `src/features/payments/file-${i + 1}.tsx:${10 + i}: PaymentsTable`).join('\n'),
    ms: 400
  })
  b.tool('edit', 'Edit', 'Modifica src/features/payments/PaymentsTable.tsx', 'src/features/payments/PaymentsTable.tsx', { ms: 200 })
  b.tool('edit', 'Edit', 'Modifica src/features/payments/index.ts', 'src/features/payments/index.ts', { ms: 150 })
  b.assistant('Ho trovato 14 riferimenti in 9 file. Rinomino prima il componente e l’export, poi aggiorno', false, 3_000)
  b.end({
    status: 'interrupted',
    durationMs: 23_000,
    counts: { commands: 0, edits: 2, reads: 0, searches: 1 },
    files: [
      { path: 'src/features/payments/PaymentsTable.tsx', added: 3, removed: 3, status: 'M' },
      { path: 'src/features/payments/index.ts', added: 1, removed: 1, status: 'M' }
    ]
  })
}

/** Turni conclusi in comune tra le varianti. */
function history(b: ConversationBuilder) {
  payments(b)
  whyUrl(b)
  dateRange(b)
  e2eError(b)
  compacted(b)
  renameInterrupted(b)
}

export const STREAM_TEXT = `Parto dal componente: la paginazione di Pagamenti e quella di Movimenti fanno la stessa cosa con due API diverse. Le unifico in \`src/components/Pagination/Pagination.tsx\` con un'interfaccia controllata.

\`\`\`tsx src/components/Pagination/Pagination.tsx
interface PaginationProps {
  page: number
  pageCount: number
  onPageChange: (page: number) => void
  /** Quante pagine mostrare attorno a quella corrente. */
  siblings?: number
}

export function Pagination({ page, pageCount, onPageChange, siblings = 1 }: PaginationProps) {
  const pages = usePageRange(page, pageCount, siblings)
  return (
    <nav aria-label="Paginazione" className="flex items-center gap-1">
      {pages.map((p) => (p === 'gap' ? <span key={p}>…</span> : <PageButton key={p} page={p} current={p === page} onClick={onPageChange} />))}
    </nav>
  )
}
\`\`\`

Poi aggiorno i due punti che la usano:

- \`src/features/payments/PaymentsTable.tsx:71\` passa \`page\` e \`setPage\` da \`useTableFilters\`;
- \`src/features/movements/MovementsList.tsx:118\` oggi tiene la pagina in uno stato locale: la sposto nella URL come in Pagamenti, così il comportamento è lo stesso.

Il test di \`usePageRange\` copre i casi limite: una sola pagina, pagina corrente al bordo, molte pagine con i salti. Lo eseguo appena finisco le modifiche ai due elenchi, poi controllo i tipi con \`pnpm tsc --noEmit\`.`

function paginationStart(b: ConversationBuilder) {
  b.turn()
  b.user('Ora estrai la paginazione in un componente riutilizzabile e usalo anche in Movimenti.')
  b.tool('read', 'Read', 'Legge src/features/payments/PaymentsTable.tsx', 'src/features/payments/PaymentsTable.tsx', { ms: 100 })
  b.tool('read', 'Read', 'Legge src/features/movements/MovementsList.tsx', 'src/features/movements/MovementsList.tsx', { ms: 120 })
  b.tool('search', 'Grep', 'Cerca usePageRange', 'usePageRange', { output: 'Nessun risultato', ms: 300 })
}

export interface Fixture {
  items: ChatItem[]
  run: 'idle' | 'running' | 'waiting' | 'starting' | 'error'
  activity: string | null
  firstUnreadSeq: number | null
}

/** Conversazione normale: storia conclusa e un turno in corso con il testo che arriva. */
export function normalFixture(): Fixture {
  const b = new ConversationBuilder()
  history(b)
  paginationStart(b)
  const firstUnread = b.items[b.items.length - 1].seq + 1
  b.tool('edit', 'Write', 'Crea src/components/Pagination/usePageRange.ts', 'src/components/Pagination/usePageRange.ts', { ms: 300 })
  b.assistant(STREAM_TEXT.slice(0, 760), true, 2_000)
  b.shiftToNow(4_000)
  return { items: b.items, run: 'running', activity: 'Scrive la risposta', firstUnreadSeq: firstUnread }
}

/** Sotto-agenti in background finiti a sessione ferma: il coordinatore ha aperto da sé un turno, senza messaggio dell'utente in testa. */
export function agentsNoticeFixture(): Fixture {
  const b = new ConversationBuilder()
  history(b)
  b.turn()
  b.user('Controlla in parallelo i tre servizi e dimmi dove si duplicano i refresh del token.')
  b.assistant('Avvio tre agenti in background, uno per servizio. Ti scrivo appena finiscono.', false, 5_000)
  b.tool('agent', 'Task', 'Audit billing service', 'Look for duplicated token refresh logic.', { ms: 61_000 })
  b.tool('agent', 'Task', 'Audit auth service', 'Look for duplicated token refresh logic.', { ms: 48_000 })
  b.tool('agent', 'Task', 'Audit notifications service', 'Look for duplicated token refresh logic.', { status: 'error', ms: 12_000 })
  b.end({ durationMs: 14_000 })
  b.turn()
  b.agentStart('background-agents', 3)
  b.assistant('I tre agenti hanno finito. Il refresh del token è duplicato in billing e auth, con la stessa logica di retry. Notifiche non è stato analizzato per un errore: lo rilancio?', false, 8_000)
  b.end({ durationMs: 21_000 })
  b.shiftToNow(60_000)
  return { items: b.items, run: 'idle', activity: null, firstUnreadSeq: null }
}

/** Comando / in corso: la riga con lo spinner, senza messaggio dell'utente. */
export function commandFixture(): Fixture {
  const b = new ConversationBuilder()
  history(b)
  b.turn()
  b.command('compact', '', 'running')
  b.shiftToNow(4_000)
  return { items: b.items, run: 'running', activity: 'Compatta il contesto', firstUnreadSeq: null }
}

/** Turno in corso con sotto-agenti al lavoro: un messaggio già inserito nel turno (steered) e la coda sopra il composer. */
export function busyFixture(): Fixture {
  const b = new ConversationBuilder()
  history(b)
  b.turn()
  b.user('Controlla come gestiamo i refresh del token nei tre servizi e dimmi dove si duplicano.')
  b.assistant('Lancio tre sotto-agenti, uno per servizio, e confronto i risultati.', false, 5_000)
  const steered = b.user('Includi anche il servizio dei pagamenti, se lo trovi.', 20_000)
  ;(steered as { steered?: boolean }).steered = true
  b.assistant('Aggiungo anche i pagamenti all’elenco.', false, 6_000)
  b.shiftToNow(4_000)
  return { items: b.items, run: 'running', activity: 'Sta lavorando', firstUnreadSeq: null }
}

/** Comandi / dell'agente per l'anteprima: come li darebbe Claude Code (builtin, personalizzati, skill). */
export const previewCommands: SlashCommand[] = [
  { name: 'compact', description: 'Compact the conversation, keeping a summary', hint: '[instructions]', source: 'builtin' },
  { name: 'review', description: 'Review a pull request', hint: '[pr]', source: 'builtin' },
  { name: 'clear', description: 'Clear the conversation history', hint: null, source: 'builtin', aliases: ['reset'] },
  { name: 'init', description: 'Create a CLAUDE.md for this project', hint: null, source: 'builtin' },
  { name: 'fix-lint', description: 'Fix every lint error in the changed files', hint: null, source: 'custom' },
  { name: 'deploy-checklist', description: 'Run the pre-deploy checklist for this repository', hint: '[environment]', source: 'skill' },
  { name: 'simplify', description: 'Review the changed code for reuse and simplification', hint: null, source: 'skill' }
]

/** Turno in corso fermo su un'approvazione. */
export function requestFixture(): Fixture {
  const b = new ConversationBuilder()
  history(b)
  b.turn()
  b.user('Il refresh del token deve essere uno solo anche se arrivano due 401 insieme. Aggiungi un test che lo dimostri.')
  b.tool('read', 'Read', 'Legge src/lib/http.ts', 'src/lib/http.ts', { ms: 90 })
  b.tool('edit', 'Edit', 'Modifica src/lib/http.ts', 'src/lib/http.ts', { ms: 400 })
  b.tool('command', 'Bash', 'Esegue pnpm vitest run src/lib', 'pnpm vitest run src/lib', {
    output: ' ✓ src/lib/http.test.ts (12 tests) 64ms\n\n Test Files  1 passed (1)\n      Tests  12 passed (12)',
    ms: 2_100
  })
  b.assistant(
    'Il refresh ora passa da un’unica promessa condivisa in `src/lib/http.ts:41`. Per provare due richieste concorrenti che ricevono 401 mi serve MSW, che non è tra le dipendenze.'
  )
  b.permission({
    toolName: 'Bash',
    title: 'Comando con rete',
    command: 'pnpm add -D msw@2',
    reason: 'Serve a intercettare POST /auth/refresh nei test di concorrenza.',
    options: defaultOptions('pnpm add')
  })
  b.shiftToNow(170_000)
  return { items: b.items, run: 'waiting', activity: null, firstUnreadSeq: null }
}

/** Turno in corso fermo su una domanda con opzioni. */
export function questionFixture(): Fixture {
  const b = new ConversationBuilder()
  history(b)
  b.turn()
  b.user('Passa la sessione a cookie httpOnly: nessun token leggibile dal client.')
  b.tool('search', 'Grep', 'Cerca localStorage', 'localStorage', {
    output: 'src/lib/auth.ts:14\nsrc/lib/auth.ts:31\nsrc/hooks/useSession.ts:9',
    ms: 300
  })
  b.tool('read', 'Read', 'Legge src/lib/auth.ts', 'src/lib/auth.ts', { ms: 100 })
  b.tool('read', 'Read', 'Legge src/hooks/useSession.ts', 'src/hooks/useSession.ts', { ms: 80 })
  b.question([
    {
      question: 'Il backend espone già un endpoint di refresh?',
      header: 'Backend',
      multiSelect: false,
      options: [
        { label: 'Sì', description: 'POST /auth/refresh risponde 204 e imposta il cookie' },
        { label: 'No, va aggiunto', description: null },
        { label: 'Non so', description: 'Cerco negli handler del server prima di procedere' }
      ]
    },
    {
      question: 'Quali pagine devono restare accessibili senza login?',
      header: 'Rotte',
      multiSelect: true,
      options: [
        { label: '/login', description: null },
        { label: '/recupero-password', description: null },
        { label: '/stato-servizio', description: 'Pagina pubblica di stato' }
      ]
    }
  ])
  b.shiftToNow(45_000)
  return { items: b.items, run: 'waiting', activity: null, firstUnreadSeq: null }
}

/** Base per lo streaming simulato: storia conclusa e un turno appena partito. */
export function streamingBase(): { builder: ConversationBuilder; fixture: Fixture } {
  const b = new ConversationBuilder()
  history(b)
  paginationStart(b)
  b.shiftToNow(3_000)
  return { builder: b, fixture: { items: [...b.items], run: 'running', activity: 'Legge i file', firstUnreadSeq: null } }
}

// ——— Conversazione lunga per le prestazioni ———

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const AREAS = ['payments', 'movements', 'invoices', 'customers', 'settings', 'reports', 'onboarding', 'auth']
const COMPONENTS = ['Table', 'Filters', 'Form', 'Dialog', 'List', 'Header', 'EmptyState', 'Toolbar']
const ASKS = [
  'Sistema il bug per cui {c} non si aggiorna dopo il salvataggio.',
  'Aggiungi la validazione al {c} con zod e mostra gli errori sotto i campi.',
  'Rendi {c} accessibile da tastiera e controlla il focus quando si apre.',
  'Scrivi i test per {c}: stato vuoto, caricamento, errore di rete.',
  'Porta {c} al nuovo design system: spaziature, colori e tipografia dai token.',
  'Il {c} è lento con tanti elementi: misura e proponi una soluzione.',
  'Sostituisci le chiamate fetch in {c} con il client generato da OpenAPI.'
]
const LONG_ASK = `Contesto: il {c} viene usato in tre schermate diverse e ognuna lo configura a modo suo.
Vorrei che:
- le props siano tipizzate e documentate;
- i casi limite (nessun dato, errore, caricamento) abbiano lo stesso aspetto ovunque;
- le storie di Storybook coprano tutte le varianti;
- i test girino in meno di un secondo;
- non cambi nulla per chi lo usa già;
- il bundle non cresca.
Se serve rompere l'API, dimmelo prima di farlo.`

const SNIPPETS = [
  "```ts\nexport const schema = z.object({\n  iban: z.string().regex(/^IT\\d{2}[A-Z]\\d{10}[0-9A-Z]{12}$/),\n  importo: z.number().positive(),\n  scadenza: z.coerce.date()\n})\n```",
  "```tsx\nuseEffect(() => {\n  if (!open) return\n  const previous = document.activeElement as HTMLElement | null\n  firstFieldRef.current?.focus()\n  return () => previous?.focus()\n}, [open])\n```",
  "```bash\npnpm vitest run {a} --reporter=dot\n```",
  "```json\n{\n  \"compilerOptions\": { \"strict\": true, \"noUncheckedIndexedAccess\": true }\n}\n```"
]

export function largeFixture(turnCount = 120): Fixture {
  const rand = rng(42)
  const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)]
  const b = new ConversationBuilder(Date.now() - 30 * 24 * 60 * 60 * 1000, 'L')
  for (let t = 0; t < turnCount; t++) {
    const area = pick(AREAS)
    const comp = `${area[0].toUpperCase()}${area.slice(1)}${pick(COMPONENTS)}`
    const base = `src/features/${area}/${comp}.tsx`
    b.turn()
    b.user((rand() < 0.12 ? LONG_ASK : pick(ASKS)).replaceAll('{c}', comp), 600_000)
    const toolCount = 2 + Math.floor(rand() * 9)
    let commands = 0
    let edits = 0
    let reads = 0
    let searches = 0
    const files: FileChange[] = []
    for (let k = 0; k < toolCount; k++) {
      const r = rand()
      if (r < 0.3) {
        reads++
        b.tool('read', 'Read', `Legge ${base}`, base, { ms: 80 })
      } else if (r < 0.45) {
        searches++
        b.tool('search', 'Grep', `Cerca ${comp}`, comp, { output: `${base}:12\n${base}:40`, ms: 200 })
      } else if (r < 0.7) {
        edits++
        const path = k % 2 ? base : base.replace('.tsx', '.test.tsx')
        b.tool('edit', 'Edit', `Modifica ${path}`, path, { ms: 250 })
        if (!files.some((f) => f.path === path))
          files.push({ path, added: 3 + Math.floor(rand() * 40), removed: Math.floor(rand() * 20), status: rand() < 0.2 ? 'A' : 'M' })
      } else {
        commands++
        const failed = rand() < 0.1
        b.tool('command', 'Bash', `Esegue pnpm vitest run ${area}`, `pnpm vitest run ${area}`, {
          status: failed ? 'error' : 'done',
          output: failed ? VITEST_FAIL : VITEST_PASS,
          ms: 2_000 + Math.floor(rand() * 4_000)
        })
      }
      if (k === 2 && rand() < 0.5) b.assistant(`Il problema è in \`${base}\`: ${pick(['lo stato non viene invalidato', 'manca la dipendenza nell’effetto', 'la chiave della query non include il filtro'])}. Lo correggo.`)
    }
    const snippet = rand() < 0.45 ? `\n\n${pick(SNIPPETS).replaceAll('{a}', area)}\n` : ''
    const list = rand() < 0.5 ? `\n\n- \`${base}\` aggiornato\n- test in \`${base.replace('.tsx', '.test.tsx')}\`\n- nessun cambiamento all’API pubblica` : ''
    b.assistant(
      `Fatto. ${comp} ora ${pick(['si aggiorna dopo il salvataggio', 'valida i campi prima dell’invio', 'gestisce il focus correttamente', 'è coperto da test', 'usa i token del design system'])}.${snippet}${list}\n\nHo eseguito \`pnpm vitest run ${area}\`: tutto passa.`,
      false,
      6_000
    )
    b.end({
      durationMs: 20_000 + Math.floor(rand() * 300_000),
      counts: { commands, edits, reads, searches },
      files
    })
  }
  b.shiftToNow(60_000)
  return { items: b.items, run: 'idle', activity: null, firstUnreadSeq: b.items[b.items.length - 6].seq }
}

/** File di un progetto finto per le citazioni con @: percorsi realistici più ~20k file generati. */
export function previewProjectFiles(synthetic = 20_000): string[] {
  const real = [
    'package.json',
    'pnpm-workspace.yaml',
    'README.md',
    '.github/workflows/ci.yml',
    'apps/web/package.json',
    'apps/web/vite.config.ts',
    'src/main.tsx',
    'src/App.tsx',
    'src/lib/http.ts',
    'src/lib/http.test.ts',
    'src/components/Pagination/Pagination.tsx',
    'src/components/Pagination/usePageRange.ts',
    'src/components/Pagination/usePageRange.test.ts',
    'src/components/DateRangePicker/DateRangePicker.tsx',
    'src/components/DateRangePicker/DateRangePicker.stories.tsx',
    'src/features/payments/PaymentsTable.tsx',
    'src/features/payments/PaymentsFilters.tsx',
    'src/features/payments/useTableFilters.ts',
    'src/features/payments/useTableFilters.test.ts',
    'src/features/movements/MovementsList.tsx',
    'src/features/movements/MovementsFilters.tsx',
    'docs/Guida per i nuovi arrivati.md',
    'e2e/payments.spec.ts'
  ]
  const rand = rng(7)
  const out = [...real]
  for (let i = 0; i < synthetic; i++) {
    const area = AREAS[Math.floor(rand() * AREAS.length)]
    const comp = COMPONENTS[Math.floor(rand() * COMPONENTS.length)]
    const pkg = `packages/pkg-${Math.floor(i / 400)}`
    const ext = rand() < 0.2 ? 'test.ts' : 'tsx'
    out.push(`${pkg}/src/features/${area}/components/${area}-${comp}-${i}.${ext}`)
  }
  return out
}

// ── Collegamenti (anteprima di "Collega i tuoi abbonamenti" e di Impostazioni → Abbonamenti) ─────────────

export type ConnectionScenario = 'first-run' | 'connected' | 'multiple' | 'downloading' | 'error' | 'attention'
export type ConnectionSet = Record<ConnectionId, ConnectionStatus>

const base = (id: ConnectionId): ConnectionStatus => ({ id, state: 'unauthenticated', source: null, version: null, user: null, plan: null, email: null, login: null, error: null })

export const CONNECTION_SCENARIOS: { id: ConnectionScenario; label: string }[] = [
  { id: 'first-run', label: 'Primo avvio' },
  { id: 'connected', label: 'Collegati' },
  { id: 'multiple', label: 'Più email (+N)' },
  { id: 'downloading', label: 'Download in corso' },
  { id: 'error', label: 'Errore' },
  // Footer: Claude vicino al limite settimanale, Codex con il login scaduto, GitHub collegato.
  { id: 'attention', label: 'Login scaduto + vicino al limite' }
]

/** Stati di prova per i tre collegamenti. */
export function connectionScenario(scenario: ConnectionScenario): ConnectionSet {
  const claude = base('claude-code')
  const codex = base('codex')
  const github = base('github')
  switch (scenario) {
    case 'first-run':
      return { 'claude-code': { ...claude, source: 'bundled', version: '2.1.4' }, codex: { ...codex, state: 'missing' }, github: { ...github, state: 'missing' } }
    case 'connected':
      return {
        'claude-code': { ...claude, state: 'connected', source: 'bundled', version: '2.1.4', plan: 'Max', email: 'alex@example.com' },
        codex: { ...codex, state: 'connected', source: 'downloaded', version: '0.58.0', plan: 'Plus', email: 'alex@example.com' },
        github: { ...github, state: 'connected', source: 'system', version: '2.62.0', user: 'alex-dev' }
      }
    case 'multiple':
      return {
        'claude-code': { ...claude, state: 'connected', source: 'system', version: '2.1.4', plan: 'Max', email: 'alex@example.com' },
        codex: { ...codex, state: 'connected', source: 'downloaded', version: '0.58.0', plan: 'Pro', email: 'alex@studio-example.it' },
        github: { ...github, state: 'connected', source: 'downloaded', version: '2.62.0', user: 'alex-dev' }
      }
    case 'downloading':
      return {
        'claude-code': { ...claude, state: 'connected', source: 'bundled', version: '2.1.4', plan: 'Pro', email: 'alex@example.com' },
        codex: { ...codex, state: 'missing', login: { stage: 'downloading', progress: 0.34, bytes: 119_000_000, total: 350_000_000, url: null, code: null } },
        github: { ...github, state: 'missing' }
      }
    case 'attention':
      return {
        'claude-code': { ...claude, state: 'connected', source: 'bundled', version: '2.1.4', plan: 'Max', email: 'alex@example.com' },
        codex: { ...codex, state: 'unauthenticated', source: 'downloaded', version: '0.58.0' },
        github: { ...github, state: 'connected', source: 'system', version: '2.62.0', user: 'alex-dev' }
      }
    case 'error':
      return {
        'claude-code': { ...claude, source: 'bundled', version: '2.1.4', error: t('Login did not complete.') },
        codex: { ...codex, state: 'missing', error: t('The download is corrupted (checksum mismatch). Try again.') },
        github: { ...github, state: 'unauthenticated', source: 'downloaded', version: '2.62.0', login: { stage: 'waiting-browser', progress: null, bytes: null, total: null, url: 'https://github.com/login/device', code: 'ABCD-1234' } }
      }
  }
}

/** Limiti d'uso di prova: finestra di 5 ore e settimanale, la seconda vicina al limite. */
export function previewUsage(fiveHours: number, weekly: number, now = Date.now()): UsageWindow[] {
  const seconds = now / 1000
  return [
    { key: '5h', minutes: 300, model: null, percent: fiveHours, resetsAt: Math.round(seconds + 2 * 3600), state: fiveHours >= 100 ? 'limited' : 'ok' },
    { key: '7d', minutes: 10_080, model: null, percent: weekly, resetsAt: Math.round(seconds + 3 * 86_400), state: weekly >= 100 ? 'limited' : weekly >= 80 ? 'warning' : 'ok' }
  ]
}

/** Agenti con account ed email, per il pulsante dell'account nella sidebar (più email → "+N"). */
export function connectionAgents(set: ConnectionSet, claudeWeekly = 62): AgentStatus[] {
  const agent = (id: 'claude-code' | 'codex', name: string): AgentStatus => ({
    agent: id,
    name,
    kind: 'native',
    available: set[id].state === 'connected',
    version: set[id].version,
    account: set[id].plan ? `${name} ${set[id].plan}` : null,
    email: set[id].email,
    models: [],
    error: null,
    usage: set[id].state === 'connected' ? previewUsage(id === 'claude-code' ? 34 : 12, id === 'claude-code' ? claudeWeekly : 25) : [],
    usageAt: Date.now()
  })
  return [agent('claude-code', 'Claude Code'), agent('codex', 'Codex')]
}

// ── Profili (LAD-23): due account Claude (predefinito e "Work") e uno Codex ───────────────────────────

export const PREVIEW_CLAUDE_WORK = 'claude-work'
export const PREVIEW_PROFILES: Profile[] = [
  { id: 'default:claude-code', agent: 'claude-code', name: 'Default', configDir: null, isDefault: true, addedAt: 0 },
  { id: PREVIEW_CLAUDE_WORK, agent: 'claude-code', name: 'Work', configDir: '/Users/dev/Library/Application Support/Ladder/profiles/claude-work', isDefault: false, addedAt: 1 },
  { id: 'default:codex', agent: 'codex', name: 'Default', configDir: null, isDefault: true, addedAt: 0 }
]

/** Collegamento del profilo "Work" di Claude: collegato (con un altro piano ed email) o da accedere, secondo lo scenario. */
export function previewProfileConnections(scenario: ConnectionScenario): Record<string, ConnectionStatus> {
  const work: ConnectionStatus = { ...base('claude-code'), profileId: PREVIEW_CLAUDE_WORK, source: 'bundled', version: '2.1.4' }
  const connected = scenario === 'connected' || scenario === 'multiple' || scenario === 'downloading'
  return { [PREVIEW_CLAUDE_WORK]: connected ? { ...work, state: 'connected', plan: 'Pro', email: 'alex@studio-example.it' } : work }
}

/** Stato agente dei profili non predefiniti: account, email e limiti propri. */
export function previewProfileAgents(connections: Record<string, ConnectionStatus>): Record<string, AgentStatus> {
  const out: Record<string, AgentStatus> = {}
  for (const [profileId, c] of Object.entries(connections)) {
    if (c.id === 'github') continue
    out[profileId] = {
      agent: c.id,
      name: c.id === 'codex' ? 'Codex' : 'Claude Code',
      kind: 'native',
      available: c.state === 'connected',
      version: c.version,
      account: c.plan ? `${c.id === 'codex' ? 'ChatGPT' : 'Claude'} ${c.plan}` : null,
      profileId,
      email: c.email,
      models: [
        { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], isDefault: true, defaultEffort: 'medium' },
        { id: 'claude-sonnet-5', label: 'Sonnet 5', efforts: ['low', 'medium', 'high'] }
      ],
      error: null,
      usage: c.state === 'connected' ? previewUsage(71, 88) : [],
      usageAt: Date.now()
    }
  }
  return out
}


// Sotto-agenti: cento agenti fra in corso, errori, fermati, completati, annidati e in background senza modello.
const AGENT_TASKS = [
  'Explore the auth module',
  'Map the payment webhooks',
  'Audit the migration scripts',
  'Review the pagination hook',
  'Find the unused exports in shared/',
  'Trace the token refresh flow',
  'Check the i18n catalogs for gaps',
  'Run the table filter tests',
  'Summarize the CI failures',
  'List the deprecated API calls',
  'Compare the two retry strategies',
  'Read the Stripe client wrapper'
]
const AGENT_KINDS = ['Explore', 'general-purpose', 'worker', 'code-reviewer', 'test-runner']
const AGENT_MODELS = ['claude-sonnet-5', 'claude-haiku-5', 'claude-opus-5-5', null]
const AGENT_EFFORTS = [null, 'low', 'medium', 'high', null] as const

/** Gli id delle righe di chat che hanno lanciato i primi agenti: la chat li lega con toolId. */
export function previewSubagents(toolIds: Record<string, string> = {}, now = Date.now()): SubagentInfo[] {
  let seed = 7
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
  const MIN = 60_000
  const out: SubagentInfo[] = []
  const make = (n: number, over: Partial<SubagentInfo>): SubagentInfo => {
    const startedAt = over.startedAt ?? now - (4 + Math.floor(rand() * 90)) * MIN
    const status = over.status ?? 'done'
    const id = `ag-${n}`
    const agent: SubagentInfo = {
      id,
      parentId: null,
      title: `${AGENT_TASKS[n % AGENT_TASKS.length]}${n >= AGENT_TASKS.length ? ` (${Math.floor(n / AGENT_TASKS.length) + 1})` : ''}`,
      kind: AGENT_KINDS[n % AGENT_KINDS.length],
      model: AGENT_MODELS[n % AGENT_MODELS.length],
      effort: AGENT_EFFORTS[n % AGENT_EFFORTS.length],
      toolId: toolIds[id] ?? null,
      status,
      startedAt,
      endedAt: status === 'running' ? null : startedAt + (20 + Math.floor(rand() * 400)) * 1000,
      activity: status === 'running' ? ['Reads src/auth/session.ts', 'Searches for refreshToken', 'Runs pnpm test auth'][n % 3] : null,
      tokens: 4_000 + Math.floor(rand() * 90_000),
      toolUses: 2 + Math.floor(rand() * 30),
      background: false,
      ...over
    }
    out.push(agent)
    return agent
  }
  // Un orchestratore in corso con i suoi figli, uno dei quali ancora al lavoro.
  make(0, { title: 'Review every service for token refresh duplication', kind: 'general-purpose', status: 'running', startedAt: now - 6 * MIN - 34_000 })
  make(1, { parentId: 'ag-0', status: 'done', startedAt: now - 6 * MIN })
  make(2, { parentId: 'ag-0', status: 'running', startedAt: now - 3 * MIN })
  make(3, { parentId: 'ag-0', status: 'error', startedAt: now - 5 * MIN })
  make(4, { parentId: 'ag-2', status: 'running', startedAt: now - 70_000, model: null })
  // Altri in corso: due in background, uno senza modello.
  make(5, { status: 'running', background: true, model: null, startedAt: now - 12 * MIN })
  make(6, { status: 'running', background: true, startedAt: now - 2 * MIN })
  make(7, { status: 'running', startedAt: now - 25_000 })
  // Errori e fermati.
  make(8, { status: 'error', startedAt: now - 30 * MIN })
  make(9, { status: 'error', model: null, startedAt: now - 41 * MIN })
  make(10, { status: 'stopped', startedAt: now - 20 * MIN })
  // Un genitore concluso con tre figli conclusi.
  make(11, { title: 'Split the payments table into features', status: 'done', startedAt: now - 50 * MIN })
  for (const n of [12, 13, 14]) make(n, { parentId: 'ag-11', status: 'done', startedAt: now - 49 * MIN })
  // Il resto: completati, alcuni in background e senza modello.
  for (let n = 15; n < 100; n++) make(n, { status: 'done', background: n % 9 === 0, model: n % 7 === 0 ? null : AGENT_MODELS[n % 3], startedAt: now - (60 + n) * MIN })
  return out
}

const PREVIEW_REPORT = `## Findings

The refresh logic exists in **three** places and they disagree on when to retry.

| Service | Retries | Backoff |
| --- | --- | --- |
| auth | 3 | linear |
| payments | 5 | none |
| reports | 1 | exponential |

Suggested shared helper:

\`\`\`ts
export async function withRefresh<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!isExpired(error)) throw error
    await refreshToken()
    return run()
  }
}
\`\`\`

- Start from \`src/auth/session.ts\`
- Then update the two callers
`

/** Dettaglio finto: per gli agenti noti dalla board, per gli altri (turni vecchi) ricostruito dalla riga. */
export function previewSubagentDetail(agents: SubagentInfo[], id: string): SubagentDetail {
  const info = agents.find((a) => a.id === id) ?? agents.find((a) => a.toolId === id) ?? null
  const running = info?.status === 'running'
  const base = info?.startedAt ?? Date.now() - 10 * 60_000
  const names = [
    ['Read', 'Reads src/auth/session.ts'],
    ['Grep', 'Searches for refreshToken'],
    ['Read', 'Reads src/payments/client.ts'],
    ['Bash', 'Runs pnpm test auth'],
    ['Edit', 'Edits src/auth/session.ts']
  ]
  const count = Math.min(info?.toolUses ?? 6, 40)
  return {
    info,
    prompt: `Look at ${info?.title.toLowerCase() ?? 'the auth module'} and report what you find.\n\nFocus on duplicated logic and on places where errors are swallowed. Do not change any file. Answer with a short list and the paths involved.`,
    report: running ? null : info?.status === 'error' ? null : PREVIEW_REPORT,
    tools: Array.from({ length: count }, (_, i) => ({
      name: names[i % names.length][0],
      title: names[i % names.length][1],
      status: running && i === count - 1 ? ('running' as const) : i === 3 && info?.status === 'error' ? ('error' as const) : ('done' as const),
      at: base + i * 7_000
    }))
  }
}

/** Chat con righe di sotto-agenti: legate alla board (toolId), una conclusa senza board (turno vecchio) e una in corso. */
/** scenario: 'mixed' (in corso, errori, completati), 'idle' (tutti conclusi: icona grigia), 'errors' (nessuno in corso, solo errori: punto rosso). */
export function agentsFixture(scenario: 'mixed' | 'idle' | 'errors' = 'mixed'): Fixture & { subagents: SubagentInfo[] } {
  const b = new ConversationBuilder()
  history(b)
  b.turn()
  b.user('Controlla come gestiamo i refresh del token nei servizi e dimmi dove si duplicano.')
  b.assistant('Lancio un agente per servizio e poi confronto i report.', false, 5_000)
  // Turno vecchio: nessun SubagentInfo, il dialogo si appoggia a subagent.detail con l'id della riga.
  const old = b.tool('agent', 'Task', 'Explore the legacy billing module', 'Look at the legacy billing module and report what you find.', { output: PREVIEW_REPORT, ms: 94_000 })
  const toolIds: Record<string, string> = {}
  for (const n of [0, 2, 5, 8]) {
    const running = n !== 8
    const item = b.tool('agent', 'Task', `Agent ${n}`, `Prompt of agent ${n}`, { status: running ? 'running' : 'error', ms: 40_000 })
    toolIds[`ag-${n}`] = item.id
  }
  b.assistant('Aspetto che finiscano e poi riassumo.', false, 3_000)
  b.shiftToNow(4_000)
  let subagents = previewSubagents(toolIds)
  if (scenario !== 'mixed') {
    subagents = subagents.map((a) => {
      const keepError = scenario === 'errors' && a.status === 'error'
      if (a.status === 'running') return { ...a, status: 'done', endedAt: Date.now() - 30_000, activity: null }
      if (a.status === 'stopped' || (a.status === 'error' && !keepError)) return { ...a, status: 'done' }
      return a
    })
  }
  void old
  return { items: b.items, run: 'running', activity: 'Waits for the agents', firstUnreadSeq: null, subagents }
}

/** Sessioni piccole per il grafico: 3 agenti con un figlio (4 in tutto), 12 (limite del grafico predefinito), 45 (oltre i 40, solo lista). */
export function agentsGraphFixture(size: 'tree' | 'twelve' | 'many'): Fixture & { subagents: SubagentInfo[] } {
  const base = agentsFixture()
  const all = previewSubagents()
  const now = Date.now()
  let subagents: SubagentInfo[]
  if (size === 'tree') {
    // Tre di primo livello (in corso, completato, fermato) e un figlio in errore del primo: quattro agenti, uno per stato.
    const lead = all[0]
    subagents = [
      { ...lead, status: 'running', parentId: null },
      { ...all[11], title: 'Write the migration notes', parentId: null, status: 'done' },
      { ...all[10], parentId: null, status: 'stopped' },
      { ...all[4], parentId: lead.id, status: 'error', endedAt: now - 20_000 }
    ]
  } else subagents = all.slice(0, size === 'twelve' ? 12 : 45)
  return { ...base, subagents }
}

/** Il coordinatore ha lanciato tre agenti in background e ha chiuso il turno: la sessione è ferma e aspetta loro. */
export function agentsWaitingFixture(): Fixture & { subagents: SubagentInfo[] } {
  const b = new ConversationBuilder()
  history(b)
  b.turn()
  b.user('Controlla in parallelo i tre servizi e dimmi dove si duplicano i refresh del token.')
  b.assistant('Avvio tre agenti in background, uno per servizio. Ti scrivo appena finiscono.', false, 5_000)
  const toolIds: Record<string, string> = {}
  for (const n of [0, 2, 5]) toolIds[`ag-${n}`] = b.tool('agent', 'Task', `Agent ${n}`, `Prompt of agent ${n}`, { status: 'running', ms: 40_000 }).id
  b.end({ durationMs: 14_000 })
  b.shiftToNow(4_000)
  const subagents = previewSubagents(toolIds).filter((a) => a.status === 'running').slice(0, 3)
  return { items: b.items, run: 'idle', activity: null, firstUnreadSeq: null, subagents }
}

/** La riga di fine agenti nei quattro stati, uno per turno: in attesa (con Continue), ripreso (nascosto se c'è già la riga di avvio), continuato, superato. */
export function agentsFinishedFixture(): Fixture {
  const b = new ConversationBuilder()
  history(b)
  const turn = (text: string, finished: number, failed: number, state: Kind<'agents-finished'>['state']) => {
    b.turn()
    b.user(text)
    b.assistant('Avvio gli agenti in background e ti scrivo appena finiscono.', false, 5_000)
    b.end({ durationMs: 9_000 })
    b.agentsFinished(state, finished, failed)
  }
  turn('Prima prova: gli agenti finiscono e il coordinatore non riparte.', 3, 0, 'waiting')
  turn('Seconda prova: con un agente fallito.', 3, 1, 'waiting')
  turn('Terza prova: il coordinatore è ripartito da solo (riga nascosta, c’è già quella di avvio).', 2, 0, 'resumed')
  b.turn()
  b.agentStart('background-agents', 2)
  b.assistant('Gli agenti hanno finito: ecco il riepilogo.', false, 4_000)
  b.end({ durationMs: 12_000 })
  turn('Quarta prova: il coordinatore è ripartito, ma senza riga di avvio.', 1, 0, 'resumed')
  turn('Quinta prova: hai premuto Continue.', 2, 0, 'continued')
  turn('Sesta prova: superata da un altro turno (nascosta).', 2, 0, 'dismissed')
  b.shiftToNow(30_000)
  return { items: b.items, run: 'idle', activity: null, firstUnreadSeq: null }
}

/** Turno finito senza modifiche, comandi né domande: avviso "si è fermato senza chiedere nulla". */
export function stalledFixture(): Fixture {
  const b = new ConversationBuilder()
  history(b)
  b.turn()
  b.user('Migra tutti i componenti della tabella ai nuovi token, poi aggiorna le storie.')
  b.assistant('Ho guardato il piano: sono quattordici componenti, conviene partire da Pagination e poi passare alle celle.', false, 6_000)
  b.end({ durationMs: 11_000, stalled: true })
  b.shiftToNow(30_000)
  return { items: b.items, run: 'idle', activity: null, firstUnreadSeq: null }
}
