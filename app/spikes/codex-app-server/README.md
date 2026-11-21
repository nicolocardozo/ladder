# S1 · Codex App Server con login ChatGPT

Domanda: `codex app-server` (JSON-RPC 2.0 su stdio, JSONL, senza campo `jsonrpc`) copre tutto il ciclo di una sessione di Blue usando il login ChatGPT già presente?
**Risposta: sì.** Tutti i 10 criteri passano con `@openai/codex@0.167.0`, piano Plus. Ci sono però alcune sorprese che cambiano il piano (vedi “Cosa cambia nel piano”).

Verificato il 7/11/2026 su macOS 26.6 (arm64), Node 24.20.

## Come si esegue

```sh
npm install          # versioni esatte, fuori dal workspace pnpm
npm run generate     # tipi in generated/stable e generated/experimental (ignorati da git)
npm run typecheck
npm run all          # oppure i singoli script, nell'ordine sotto
```

| Script | Cosa fa | Thread |
|---|---|---|
| `probe` | handshake, `account/read`, `account/rateLimits/read`, `model/list`, sceglie il modello più economico | nessuno |
| `run` | `thread/start` in un repo git temporaneo, turno con file e comandi, approvazioni, streaming; alla fine `SIGKILL` del processo | 1 persistente, “blue-spike S1 lifecycle” |
| `resume` | nuovo processo, `thread/list`, `thread/read`, `thread/resume`, domanda sul file creato | riusa quello di `run` |
| `steer` | latenza del primo delta, `turn/steer`, `turn/interrupt` su un comando lungo, turno successivo | effimero |
| `schema` | `outputSchema` su un turno, poi un turno senza schema | effimero |
| `reasoning` | un turno con effort high per vedere i delta di ragionamento | effimero |
| `bgclean` | dopo un interrupt chiude il comando rimasto vivo con `thread/backgroundTerminals/clean` (sperimentale) | effimero |
| `features` | elenco dei feature flag (diagnostica) | nessuno |
| `events` | metodi distinti visti nei log e mappatura verso gli eventi di Blue | nessuno |

Il client è `src/client.ts`: spawn, JSONL, richieste con id e timeout, notifiche tipizzate, risposte alle richieste del server, log JSONL in `results/` (email e id account oscurati). I tipi vengono da `generated/stable` con `import type`, quindi Node non li carica a runtime. `src/util.ts` ha repo temporaneo, scelta del modello, `runTurn` con i conteggi. Esiti in `results/checks.json`, metodi in `results/methods.json`.

Il login resta quello di `~/.codex` (CODEX_HOME di default). Gli script non leggono `auth.json` né `config.toml`; dall'account stampano solo tipo e piano.
Ogni `npm run run` aggiunge un thread alla cronologia di Codex; gli altri thread sono effimeri. Durante lo spike ne ho creati 2, entrambi “blue-spike S1 lifecycle”.

## Risultati

Modello usato: `gpt-6-luna`, effort `low`, tier `default` (vedi gotcha sul tier).

| # | Criterio | Esito | Evidenza |
|---|---|---|---|
| 1 | Handshake | ✅ | `initialize` → `userAgent: blue/0.167.0 …`, `codexHome`, poi `initialized`. Un secondo `initialize` → `-32600 Already initialized` |
| 2 | Account e limiti | ✅ | `account/read` → `type: chatgpt`, `planType: plus`. `account/rateLimits/read` → bucket `codex`: 14 % della finestra di 300 min, 11 % di quella settimanale, con `resetsAt`. `account/rateLimits/updated` arriva dopo ogni chiamata al modello |
| 3 | `model/list` | ✅ | 8 modelli: `gpt-6.1-sol` (default), `gpt-6-astra`, `gpt-6.1-terra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`. Effort `low`…`max`, più `ultra` tranne i luna; default `low` o `medium`; un solo tier extra, `priority` (“Fast, 2x speed, increased usage”). Nessun prezzo: scelto `gpt-6-luna` (“Fast and affordable”) |
| 4 | `thread/start` | ✅ | cwd del repo temporaneo, `sandbox: workspaceWrite`, `approvalPolicy: untrusted`. Nome impostato con `thread/name/set` |
| 5 | Approvazioni | ✅ | 3 richieste: modifica file accettata (file creato), `git add` rifiutato (item `declined`, file non nell'index), comando successivo accettato (exit 0); il turno continua dopo il rifiuto e termina `completed`. Ordine sempre: `item/started` → `…/requestApproval` → risposta → `serverRequest/resolved` (entro 1 ms) → `item/completed` |
| 6 | Streaming | ✅ | Turno con strumenti: 41 `item/agentMessage/delta`, 2 `item/commandExecution/outputDelta`, 5 `turn/diff/updated`, 1 `turn/plan/updated`, 5 `thread/tokenUsage/updated`, 5 `account/rateLimits/updated`. Ragionamento: 0 delta con effort low; con high 2 `summaryPartAdded` e 2 `summaryTextDelta`, 204 token di ragionamento. Primo delta di testo su un turno semplice: 1,7–2,7 s |
| 7 | Steer e interrupt | ✅ | `turn/steer` con `expectedTurnId` → stesso `turnId`, nessun nuovo `turn/started`, elenco fermato dopo 1 riga, risposta finale “STEERED”. Id sbagliato → `-32600 expected active turn id …`; senza turno attivo → `-32600 no active turn to steer`. `turn/interrupt` → `{}` e `turn/completed` con `interrupted` in circa 100 ms; il turno dopo funziona. **Ma il comando resta vivo** (vedi gotcha) |
| 8 | Ripresa dopo kill | ✅ | `SIGKILL` del processo, nuovo processo, `thread/read` → `notLoaded`, `thread/resume` (con `excludeTurns`) + `thread/turns/list` → 2 turni, risposta “blue-spike.txt”. `approvalPolicy: untrusted` ed effort persistono. `thread/list` trova il thread, ma con `sourceKinds: ["appServer"]` **no**: il thread è registrato come `vscode` |
| 9 | `outputSchema` | ✅ | Messaggio finale `{"verdict":"pass","summary":"…","filesTouched":2}`, valido rispetto allo schema; il turno successivo senza schema torna a testo libero (“Hello!”) |
| 10 | Mappatura eventi | ✅ | 22 notifiche distinte, 2 tipi di richiesta dal server, 10 combinazioni item/tipo, tutte classificate (tabella sotto) |

Non verificati, per tempo o perché costano quota: turno `failed` per limite d'uso (`codexErrorInfo: usageLimitExceeded`), notifica `error` con `willRetry`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, chiamate MCP e ricerca web, decisioni `cancel` e `acceptForSession`, login da zero, più thread in parallelo sullo stesso processo.

## Mappatura verso gli eventi di Blue

| Evento Blue | Da Codex 0.167.0 | Note |
|---|---|---|
| turn.started | `turn/started` | La risposta a `turn/start` arriva prima, già con il `turnId` |
| message.delta | `item/agentMessage/delta` | |
| message.completed | `item/completed` con `agentMessage` | `phase`: `commentary` (preambolo prima degli strumenti) o `final_answer`. Utile per la gerarchia della chat |
| reasoning | `item/reasoning/summaryPartAdded`, `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta`; item `reasoning` | I summary arrivano come titoli interi, non token per token |
| tool.started / completed | `item/started` e `item/completed` per `commandExecution`, `fileChange` (e `mcpToolCall`, `webSearch`, `dynamicToolCall`) | Stato finale `completed`, `failed`, `declined` |
| tool.output | `item/commandExecution/outputDelta` | Non completo: vedi gotcha. L'autorità è `aggregatedOutput` in `item/completed` |
| request.opened | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` (`item/permissions/requestApproval`) | Per i file il diff sta nell'`item/started` precedente (`changes[].diff`), non nella richiesta |
| question.opened | `item/tool/requestUserInput` | Non osservato |
| request.resolved | `serverRequest/resolved` | Arriva anche quando la fine del turno annulla una richiesta pendente |
| diff.updated | `turn/diff/updated` | Diff unificato aggregato del turno |
| plan.updated | `turn/plan/updated` | Solo con `tools.update_plan.enabled` |
| usage / limits | `thread/tokenUsage/updated`, `account/rateLimits/updated` | Il secondo è parziale: va fuso con l'ultimo `account/rateLimits/read` |
| turn.completed / failed | `turn/completed` con `status` `completed`, `interrupted`, `failed` (+ `error`) | |
| stato sessione | `thread/status/changed` | `activeFlags: ["waitingOnApproval"]` è il segnale per “Richiede te” |
| metadati | `thread/started`, `thread/name/updated`, `account/updated` | |
| diagnostica | `mcpServer/startupStatus/updated`, `deprecationNotice`, `warning`, `configWarning`, stderr | Solo log |
| ignorati | `remoteControl/status/changed`, `thread/goal/cleared`, `turn/moderationMetadata` | L'ultima arriva solo con `experimentalApi` |

## Gotcha

- **Versione.** I tipi generati valgono solo per la versione che li genera. `generate-ts --experimental` aggiunge circa 70 metodi (`process/*`, `thread/backgroundTerminals/*`, `thread/queue/*`…) che senza `experimentalApi: true` nell'handshake vengono rifiutati. Il server manda comunque campi fuori dai tipi stabili: `availableDecisions` nelle richieste di approvazione e `emittedAtMs` su ogni notifica.
- **Binario.** `node_modules/.bin/codex` è un launcher JS che su Node 24 fa `execve` del binario nativo (stesso PID, i segnali arrivano diretti). In Electron conviene lanciare direttamente `@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`.
- **sourceKinds.** I thread creati dall'app-server sono registrati con `source: "vscode"`, non `appServer`. Il `thread/list` di default (cli + vscode) li trova già; con `sourceKinds: ["appServer"]` non trova niente. Compaiono quindi anche nella cronologia di Codex e dell'estensione VS Code.
- **Effort del thread.** `thread/start` non accetta l'effort: il thread parte con quello di `config.toml` (qui `high`). Va passato a ogni `turn/start` o con `config: { model_reasoning_effort: "low" }`. Gli override di `turn/start` restano per i turni dopo; `outputSchema` no.
- **Tier.** Ogni modello offre `priority` (2x consumo). Lo spike passa `serviceTierForTurn: "default"` per non ereditare un eventuale tier veloce dalla configurazione.
- **Piano.** In 0.167.0 lo strumento `update_plan` è spento: senza `config: { "tools.update_plan.enabled": true }` in `thread/start` il modello dice che lo strumento non c'è e `turn/plan/updated` non arriva mai.
- **Ragionamento.** Con effort low `gpt-6-luna` non ragiona (`reasoningOutputTokens: 0`), quindi niente delta di ragionamento. Con high arrivano, ma sono pochi titoli.
- **Output dei comandi.** Il primo blocco di output non arriva come delta (“tick 1” solo in `aggregatedOutput`); i comandi brevi non producono delta.
- **Interrupt.** `turn/interrupt` chiude il turno ma non il comando: il processo resta vivo come terminale in background, l'item `commandExecution` non riceve `item/completed` e gli `outputDelta` continuano ad arrivare con il `turnId` vecchio, anche durante il turno successivo. Si chiude con `thread/backgroundTerminals/clean` (sperimentale) o all'uscita dell'app-server.
- **Steer.** L'`agentMessage` in corso resta senza `item/completed`; l'input dello steer arriva come secondo `userMessage` nello stesso turno.
- **Approvazioni.** Con `untrusted` chiede conferma per quasi tutto, anche per un `true` lanciato dal modello all'avvio della shell. `availableDecisions` non elenca `decline`, che però funziona. Gli id delle richieste del server partono da 0 a ogni connessione.
- **Cronologia.** Dopo la ripresa il comando rifiutato non c'è più: la cronologia di Codex contiene solo quello completato. La reidratazione completa in `thread/resume` è deprecata (`deprecationNotice`): si usa `excludeTurns: true` con `thread/turns/list` e `thread/items/list`.
- **Percorsi.** Su macOS la cartella temporanea `/var/…` diventa `/private/var/…`, e il filtro `cwd` di `thread/list` vuole il percorso esatto: si passa sempre il realpath.
- **Costo base.** Ogni turno parte da circa 15k token in ingresso (prompt di sistema e strumenti), in gran parte in cache. Ogni thread avvia anche il server MCP `codex_apps`.
- **stderr.** Log con colori ANSI (per esempio `exec_command failed … rejected by user` dopo un rifiuto): va registrato, non interpretato.

## Raccomandazione per l'adapter Codex

1. Un processo `codex app-server` per progetto, come da piano: binario nativo dalla versione fissata, stdio JSONL, `experimentalApi: false`. Supervisione: se il processo muore, Blue lo riavvia e riprende i thread attivi con `thread/resume` (`excludeTurns`).
2. Client generato dai tipi stabili più una piccola mappa metodo → risposta (i binding non la includono). Al cambio di versione: rigenerare, `typecheck`, rieseguire questi script.
3. `thread/start` con `cwd`, `sandbox`, `approvalPolicy`, `config: { "tools.update_plan.enabled": true, model_reasoning_effort }`. Ogni `turn/start` con `model`, `effort` e `serviceTierForTurn` espliciti.
4. Nell'adapter, una macchina a stati per item: alla fine del turno chiude gli item rimasti aperti (steer, interrupt) e scarta i delta con un `turnId` diverso da quello attivo.
5. Richieste pendenti indicizzate per processo e id, chiuse da `serverRequest/resolved`. La card di approvazione prende comando o diff dall'`item/started` con lo stesso `itemId`.
6. La cronologia la tiene Blue con il proprio registro eventi (rifiuti, piani, output). Gli id dei thread creati da Blue stanno nel database di Blue; `thread/list` con filtro `cwd` serve solo a importare i thread nati nel terminale.
7. Dopo un interrupt: se resta un comando vivo, la prima soluzione è riavviare il processo del progetto. Se serve spesso, si attiva `experimentalApi` solo per `thread/backgroundTerminals/clean`.

## Cosa cambia nel piano

- Sezione 4.6, “Per vedere anche i thread creati da Blue va passato `sourceKinds`”: in 0.167.0 è il contrario. I thread dell'app-server risultano `vscode`, compaiono di default e anche nella cronologia di Codex. Blue deve riconoscere i propri thread dal suo database, non da `source`.
- `turn/interrupt` non ferma i comandi in corso: serve una delle due strategie del punto 7.
- `turn/plan/updated` richiede di attivare `tools.update_plan.enabled`.
- Il ragionamento visibile dipende dall'effort: con low spesso non c'è, quindi la UI non deve aspettarselo.
- Le approvazioni con `untrusted` sono molto frequenti; per l’uso normale resta giusto `on-request`, come nell’esempio di `thread/start` del piano.
