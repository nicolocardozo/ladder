# S2 · Claude Agent SDK

Domanda: l’Agent SDK TypeScript regge le sessioni lunghe e interattive della chat di Blue, con il login Max già fatto nella CLI?

Risposta breve: **sì**. Tutti i criteri passano con `@anthropic-ai/claude-agent-sdk@0.3.319`, modello `haiku`, `settingSources: []` e login dell’abbonamento. Servono però tre accorgimenti che il piano non prevede (ambiente ripulito, connettori claude.ai spenti, variabile per `session_state_changed`) e una gestione dei processi orfani.

## Come si esegue

```sh
cd spikes/claude-sdk
npm install
npm start            # run.ts: una sessione, 10 turni (criteri 1-6, 8, 9), ~2 min (approvazione tenuta 65 s)
npm run resume       # resume.ts: riprende l'ultima sessione in un nuovo processo + `claude --resume` (criterio 7)
npm run kill         # kill.ts: SIGKILL dell'host a metà turno; poi `npm run resume`
node probe.ts        # connettori claude.ai ed effort a metà sessione
```

Variabili utili: `HOLD_MS` (durata dell’approvazione in sospeso, default 65000), `TOOL_WAIT_MS` (attesa prima dell’interruzione del comando, default 32000), `ONLY=stream,approvals,question,controls,interrupt`, `CLAUDE_BIN` (usa una CLI installata invece di quella inclusa nell’SDK), `SPIKE_MODEL`.

I repository di prova vengono creati in `.tmp/`; i log grezzi (JSONL, un evento per riga) e i riepiloghi in `results/`. Entrambi sono ignorati da git. Le trascrizioni delle sessioni finiscono, come sempre, in `~/.claude/projects/-Users-…-spikes-claude-sdk--tmp-repo-*`: si possono cancellare a mano.

## Risultati

Esecuzione del 7/11/2026, CLI inclusa nell’SDK 2.1.319, `claude` installato 2.1.316 → 2.1.319 (aggiornato da solo durante lo spike). Log: `results/run-2026-11-07T13-08-59-291Z.jsonl`, `results/resume-*.jsonl`.

| # | Criterio | Esito | Evidenza |
|---|---|---|---|
| 1 | `query()` con input in streaming, più turni | ✅ | 10 turni nello stesso processo e nella stessa `session_id`; al turno 2 ricorda l’ultima parola del turno 1 (“twelve”) |
| 2 | Streaming con `includePartialMessages` | ✅ | 34 `text_delta` in sessione; primo delta 1,47 s dopo l’invio al turno 1 (compreso l’avvio del processo), 1,2–1,5 s nei turni brevi successivi; `result.ttft_ms` 1,6 s. Haiku manda pezzi grossi: una risposta corta arriva in 1 delta; la storia del 6a ne aveva mandati 21 quando è stata interrotta |
| 3 | Approvazioni con `canUseTool` | ✅ | Sequenza `Write:allow → Bash:deny → Bash:allow`; il messaggio del rifiuto arriva al modello come `tool_result` d’errore, il modello riprova, `notes.txt` risulta in stage; `result.permission_denials` elenca la chiamata rifiutata |
| 3b | Promessa in sospeso ≥ 60 s | ✅ | Approvazione di `Write` tenuta 65 s, `signal.aborted=false`, il turno finisce con `success`. Durante l’attesa non arriva **nessun** messaggio (niente battito). Anche **10 minuti** (600 s) passano: vedi sotto |
| 4 | `AskUserQuestion` | ✅ | Arriva in `canUseTool` con `input.questions`; risposta con `updatedInput: { ...input, answers: { "Which color do you prefer?": "Green" } }`; il modello risponde “GREEN” |
| 5 | `setPermissionMode('acceptEdits')` | ✅ | `Write` successivo senza `canUseTool`; arriva `system/status` con `permissionMode: "acceptEdits"` |
| 5 | `setModel('sonnet')` | ✅ | `assistant.message.model = claude-sonnet-5-5`; `modelUsage` con due chiavi (haiku e sonnet) |
| 5 | `supportedModels()` | ✅ | `default`/`opus` → claude-opus-5-5 “Opus 5.5”, `fable` → claude-fable-5-1, `sonnet` → claude-sonnet-5-5, `haiku` → claude-haiku-5-5, più id espliciti (Opus 5, Sonnet 5, Fable 5, Opus 4.8/4.7/4.6, Sonnet 4.6, Haiku 4.5). Effort low…max su tutti tranne Haiku 4.5 (nessuno) e i 4.6 (senza xhigh) |
| 5 | Effort a metà sessione | ⚠️ | Non c’è `setEffort()`. `applyFlagSettings({ effortLevel: 'low' })` viene accettato senza errori, ma nessun evento conferma il valore applicato (`init.effort` è `null` o assente in questo trasporto). All’avvio c’è l’opzione `effort` |
| 6 | `interrupt()` | ✅ | **Durante il testo**: `result` `error_during_execution`, `terminal_reason: aborted_streaming`, 9 ms dopo la chiamata, 0 delta dopo. **Durante un comando** (Bash da 32 s): `terminal_reason: aborted_tools` in 7 ms, processi del comando terminati entro 72 ms, `task_notification` con `status: stopped`. Il turno dopo risponde “still here” |
| 7 | Ripresa in un nuovo processo | ✅ | `resume: <id>` in un processo nuovo: stessa `session_id` (nessun fork), risponde “notes.txt, edits.txt” in 2,1 s |
| 7 | `claude --resume <id> -p … --model haiku` | ✅ | Exit 0, stessa `session_id`, ricorda i file e conta anche la domanda fatta dall’SDK: SDK e CLI scrivono la stessa trascrizione (147 → 171 righe). Funziona sia con 2.1.319 sia con 2.1.316, e l’SDK 0.3.319 guida anche la CLI 2.1.316 (`CLAUDE_BIN`) |
| 7 | Ripresa dopo SIGKILL dell’host | ✅ con riserva | Riprende e ricorda `a.txt`. Il figlio `claude` sopravvive circa 8 s al padre ucciso: se Blue riprende subito, due processi scrivono la stessa sessione |
| 8 | Tipi di messaggio | ✅ | Elenco e mappatura sotto |
| 9 | Abbonamento o chiave API | ✅ | `init.apiKeySource: "none"` (login claude.ai, nessuna chiave); `accountInfo()`: `subscriptionType: "Claude Ultra"`, `apiProvider: "firstParty"`; c’è `rate_limit_event`, che esiste solo con i piani. Funziona anche con `settingSources: []` |

Prova da 10 minuti, come chiede il piano (`ONLY=approvals HOLD_MS=600000 node run.ts`, output in `results/hold-10min.out`): ✅ approvazione di `Write` in sospeso per 600 s, `signal.aborted=false`, poi `Bash:deny → Bash:allow` e turno chiuso con `success` 5 s dopo il rilascio. Nel frattempo girava in parallelo un’altra sessione (`npm start`) senza problemi.

## Tipi di messaggio osservati

Conteggi di una sessione completa (`run.ts`). I campi principali sono nei log.

| Tipo | N | Note |
|---|---|---|
| `system/init` | 10 | **Uno per turno**, non uno per sessione. `apiKeySource`, `model`, `permissionMode`, `claude_code_version`, `cwd`, `tools`, `mcp_servers`, `skills`, `agents`, `plugins`, `slash_commands`, `capabilities` (es. `interrupt_receipt_v1`, `ask_user_question_unanswered_v1`), `fast_mode_state`, `effort` (null) |
| `system/session_state_changed` | 30 | `running` / `requires_action` / `idle`. Solo con `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` |
| `system/status` | 16 | `status: "requesting"` a ogni chiamata API; `permissionMode` dopo `setPermissionMode`; `compacting` quando compatta |
| `system/thinking_tokens` | 2 | `estimated_tokens`, `estimated_tokens_delta` |
| `system/task_started`, `system/task_notification` | 1+1 | Comando Bash come task: `task_id`, `tool_use_id`, `description`, `status: stopped` dopo l’interruzione |
| `stream_event` | 230 | `message_start`, `content_block_start` (text, thinking, tool_use), `content_block_delta` (`text_delta`, `thinking_delta`, `input_json_delta`, `signature_delta`), `content_block_stop`, `message_delta` (stop_reason, usage), `message_stop` |
| `assistant` | 18 | **Un messaggio per blocco** (thinking, text, tool_use), raggruppabili per `message.id`; `message.usage` per chiamata |
| `user` con `tool_result` | 6 | `tool_use_id`, `is_error`, più `tool_use_result` strutturato (es. `{stdout, stderr, interrupted}` per Bash, patch per Write) |
| `user` con testo | 2 | Sintetici: “[Request interrupted by user]”, “[Request interrupted by user for tool use]” |
| `user` con `isReplay` | 2 | Dopo `setModel`: `<local-command-stdout>Set model to …</local-command-stdout>` |
| `tool_progress` | 1 | Battito ogni 30 s: `tool_use_id` = `<id>-heartbeat-0`, l’id vero è in `parent_tool_use_id`; `elapsed_time_seconds` |
| `rate_limit_event` | 1 | Solo alla prima richiesta: `status`, `resetsAt`, `rateLimitType` (`seven_day`), `unifiedWindows.seven_day.utilization` (0,09), stato dell’overage |
| `result/success` | 8 | `result`, `num_turns`, `duration_ms`, `ttft_ms`, `usage` (del turno), `modelUsage` (per modello, con `contextWindow` 1M e `maxOutputTokens`), `total_cost_usd` (**cumulativo** e a prezzo di listino, `costBasis: "list"`), `permission_denials`, `terminal_reason`, `subagent_stats` |
| `result/error_during_execution` | 2 | Interruzioni: `is_error: true`, `terminal_reason` `aborted_streaming` / `aborted_tools`, `errors` con una diagnostica interna |

Previsti dai tipi ma non visti qui: `system/compact_boundary`, `system/api_retry`, `system/permission_denied`, `system/hook_*`, `system/notification`, `auth_status`, `result/error_max_turns`, `error_max_budget_usd`, eventi dei sotto-agenti.

### Mappatura verso gli eventi di Blue

| Evento Blue | Da Agent SDK |
|---|---|
| `turn.started` | Lo emette l’host quando mette il messaggio nella coda; conferma con `session_state_changed: running`. Il `system/init` del turno aggiorna modello, modalità e strumenti |
| `message.delta` | `stream_event` → `content_block_delta` con `text_delta` e `parent_tool_use_id: null` (con un valore, è un sotto-agente). `thinking_delta` → `reasoning.delta` |
| `message.completed` | `assistant` con blocco `text`, raggruppato per `message.id` |
| `tool.started` | `assistant` con blocco `tool_use` (`id`, `name`, `input`); `content_block_start` di tipo `tool_use` per mostrare subito lo spinner |
| `tool.output` | `tool_progress` (usa `parent_tool_use_id`), `task_started` / `task_notification` |
| `tool.completed` | `user` con `tool_result` per lo stesso `tool_use_id`, più `tool_use_result` strutturato |
| `request.opened` | Chiamata di `canUseTool` (`toolUseID`, `title`, `displayName`, `description`, `decisionReason`, `suggestions`, `blockedPath`); poco prima arriva `session_state_changed: requires_action` |
| `request.resolved` | Promessa risolta da Blue; poi `session_state_changed: running`. I rifiuti finiscono anche in `result.permission_denials` |
| `question.opened` / `resolved` | `canUseTool` con `toolName === "AskUserQuestion"`; risposta in `updatedInput.answers` (chiave: testo della domanda, valore: etichetta; più scelte separate da virgola) |
| `usage` / `limits` | `result.usage` (turno), `result.modelUsage` (contesto massimo), `total_cost_usd` solo come “equivalente”, `rate_limit_event` per i limiti del piano |
| `turn.completed` | `result/success`; il segnale definitivo di fine è `session_state_changed: idle` |
| `turn.interrupted` | `result/error_during_execution` con `terminal_reason` `aborted_*` dopo un `interrupt()` di Blue |
| `turn.failed` | Altri `result` con `is_error` (`error_max_turns`, `error_max_budget_usd`, errori API) |
| `session.config` | `system/status` con `permissionMode`; `user` con `isReplay` dopo `setModel` (da nascondere in chat) |

## Insidie

1. **Ambiente ereditato.** Se Blue parte da un terminale di Claude Code (per esempio `pnpm dev`), l’ambiente contiene `CLAUDECODE`, `CLAUDE_CODE_SIMPLE` (equivale a `--bare`), `ANTHROPIC_BASE_URL` (il proxy dell’app ospite) e una trentina di altre variabili. Non basta togliere `ANTHROPIC_API_KEY`: lo spike toglie tutte le `ANTHROPIC_*` e `CLAUDE*` (`lib.ts`, `cleanEnv`).
2. **Connettori claude.ai.** Con il login dell’abbonamento la CLI collega anche i connettori dell’account claude.ai (qui Gmail, Calendar, Drive, Linear, Bank, …), **anche con `settingSources: []`**. Gli strumenti passano da 29 a 315 e il costo equivalente della sessione da 0,034 a 0,090 USD. Soprattutto, l’agente di un progetto può leggere la posta. Blue deve passare `settings: { disableClaudeAiConnectors: true }` (verificato: `mcp_servers: []`) oppure `strictMcpConfig: true`.
3. **`session_state_changed` non arriva** senza `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` nell’ambiente: l’SDK chiede gli stati per uso interno e li scarta.
4. **`permissionMode` omesso vale `auto`** (classificatore) dove disponibile. Per avere le approvazioni va passato `'default'`.
5. **`canUseTool` non vede tutto.** I comandi di sola lettura (visto con `cat notes.txt`) e le modifiche in `acceptEdits` passano senza chiamarlo. L’hook `PreToolUse` registrato in `run.ts` vede anche queste chiamate (verificato con la `Write` in `acceptEdits`): serve per il registro, come previsto dal piano.
6. **Nessun battito durante un’approvazione.** In 65 s (e in 10 minuti) di attesa non arriva alcun messaggio: lo stato “in attesa” lo deve tenere Blue. Le richieste non scadono: i tipi dell’SDK dicono che i prompt di permesso non hanno scadenza, e i 10 minuti lo confermano.
7. **La CLI blocca `sleep N` in primo piano** (“use Monitor…”): il modello rinuncia e il turno finisce da solo. Nei test servono altri comandi lunghi.
8. **Due binari.** L’SDK installa una sua CLI (`@anthropic-ai/claude-agent-sdk-darwin-arm64`, 2.1.319, 321 MB) diversa da `~/.local/bin/claude`, che si aggiorna da sola. Condividono login (portachiavi) e trascrizioni. Per Electron il binario va lasciato fuori dall’asar e moltiplicato per architettura, oppure si usa la CLI dell’utente con `pathToClaudeCodeExecutable`.
9. **Orfani.** Dopo un SIGKILL dell’host il figlio `claude` resta vivo circa 8 s. Blue deve ricordare il PID (o usare `spawnClaudeCodeProcess`) e, al riavvio, aspettarlo o ucciderlo prima di riprendere la stessa sessione.
10. **Rumore nel flusso.** `system/init` a ogni turno, un `assistant` per blocco, messaggi `user` sintetici dopo interruzioni e `setModel`. L’adapter deve filtrarli prima della UI.
11. **Costi.** `total_cost_usd` è cumulativo e a prezzo di listino anche con l’abbonamento. Va mostrato, se si mostra, come equivalente.
12. **Strumenti in più.** Anche con `settingSources: []` restano 20 skill incluse, 4 plugin interni e strumenti come `CronCreate`, `RemoteTrigger`, `PushNotification`, `SendToProject`, `Workflow`. Conviene una lista `tools` o `disallowedTools` decisa da Blue.

## Raccomandazione per l’adapter Claude Code

- Un `query()` per thread, con una coda asincrona come `prompt` (`InputQueue` in `lib.ts`), tenuto vivo tra i turni. Fine del turno su `result`, fine reale su `session_state_changed: idle`. Chiusura della coda per terminare; `resume: sessionId` per riaprire (la `session_id` resta la stessa).
- Opzioni di base: `permissionMode` esplicito, `includePartialMessages: true`, `settings: { disableClaudeAiConnectors: true }`, `env` ripulito con `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` e `CLAUDE_AGENT_SDK_CLIENT_APP`, hook `PreToolUse` per il registro, `canUseTool` che crea una richiesta persistente e risponde quando l’utente decide (anche dopo minuti).
- `settingSources`: lo spike usa `[]` e il login funziona lo stesso. Per l’uso reale servono almeno `project` (CLAUDE.md e regole del progetto); `user` porterebbe anche gli hook personali dentro le sessioni di Blue, da decidere.
- Modello: `supportedModels()` all’avvio per popolare il selettore, `setModel()` a metà sessione. Effort: opzione `effort` all’avvio; a metà sessione `applyFlagSettings({ effortLevel })`, da verificare quando ci sarà un modo di leggerlo (oppure riavvio con `resume` e nuovo `effort`).
- Interruzione: `interrupt()` basta; mappare `terminal_reason` `aborted_*` su `turn.interrupted`.
- Usare la CLI inclusa nell’SDK, versione fissata insieme al pacchetto, e lasciare `pathToClaudeCodeExecutable` come opzione. La compatibilità delle trascrizioni con la CLI dell’utente è verificata in entrambe le direzioni (2.1.316 e 2.1.319).
