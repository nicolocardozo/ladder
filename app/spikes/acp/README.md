# S5 · Client ACP generico

Domanda: un agente ACP si collega a Blue senza codice specifico?
Risposta: **sì**. Lo stesso client (`src/acp-client.ts`) avvia l'agente da una voce di configurazione o dal registro, e copre avvio, sessione, prompt, aggiornamenti, permessi, annullamento e ripresa dopo kill. I limiti emersi stanno nell'adapter dell'agente, non nel protocollo.

Agente provato: **`@agentclientprotocol/codex-acp` 2.5.0** (l'ultima, la stessa del registro), che porta con sé `@openai/codex` 0.165.0. Ha usato il login ChatGPT già presente in `~/.codex` senza chiamare `authenticate`. La riserva con Claude non è servita e non è stata avviata: `npm run probe -- --registry claude-acp` è pronto (non consuma quota, non manda prompt).

Verificato il 7/11/2026 con Node 24.20, SDK `@agentclientprotocol/sdk` 2.4.0, protocollo v1.

## Come si esegue

```bash
npm install
npm run typecheck
npm run probe      # 1, 2: initialize, capacità, session/new, opzioni, modello economico
npm run turn       # 3, 4, 7: file e comandi, permessi (consenti una volta, poi rifiuta)
npm run cancel     # 5: session/cancel durante `sleep 30`, poi un prompt normale
npm run resume     # 6: SIGKILL, poi session/load e session/resume in processi nuovi
npm run ttfc       # 7: tempi di avvio e al primo chunk, con capacità client vuote
npm run registry   # 8: scarica il registro e aggiorna registry-sample.json
```

Opzioni: `-- --agent codex|claude` (voci in `src/agents.ts`) oppure `-- --registry <id>` (voce costruita dal registro, come “Aggiungi un agente”). Variabili: `ACP_MODEL` forza il modello, `ACP_MODE` la modalità, `ACP_SAMPLES` i campioni di `ttfc`. Per il debug di codex-acp: `APP_SERVER_LOGS=$PWD/results/appserver`.

Ogni script scrive un JSONL in `results/` (ignorato da git): ogni messaggio sul filo (`in`/`out`), lo stderr dell'agente, gli eventi Blue normalizzati (`blue`) e le note. I repository di prova sono in `$TMPDIR/blue-acp-*`. Le sessioni di Codex finiscono comunque in `~/.codex/sessions` (originator `blue-spike`).

| File | Cosa fa |
|---|---|
| `src/acp-client.ts` | `AcpHost`: spawn, `client()` dell'SDK 2.x, gestori per permessi e fs, log grezzo, prompt con tempi |
| `src/normalize.ts` | Mappatura da ACP agli eventi di Blue (criterio 9) |
| `src/harness.ts` | Permessi a copione, turni, scelta della modalità con approvazioni |
| `src/agents.ts`, `src/registry.ts` | Voci agente come dati; dal registro a comando |
| `scripts/*.ts` | Uno script per gruppo di criteri |

## Risultati

| # | Criterio | Esito | Evidenza |
|---|---|---|---|
| 1 | Spawn su stdio, `initialize` v1 | PASS | `protocolVersion: 1`. `loadSession: true`; prompt `image` ed `embeddedContext` (niente audio); MCP `http` sì, `sse` no; `sessionCapabilities`: resume, list, close, delete, fork, additionalDirectories (più subagents e systemPrompt, instabili). `authMethods`: `api-key`, `chat-gpt`. Capacità client: nessuna necessaria (`ttfc` gira con `{}`); fs/* e terminal/* mai chiamati anche se offerti |
| 2 | `session/new`, opzioni, modello economico | PASS | `configOptions`: `mode` (read-only, workspace-write, agent = “Auto review” predefinita, agent-full-access), `collaboration_mode` (default, plan), `model` (8 valori), `reasoning_effort` (categoria `thought_level`, low…ultra), `fast-mode` (`model_config`). Arrivano anche `modes` (vecchio stile) e `models` (vecchio campo instabile, non più nello schema). `set_config_option` model=`gpt-6-luna`, effort=`low`: ok, la risposta riporta tutte le opzioni |
| 3 | Prompt con file e comando | PASS, con lacune | Visti: `agent_message_chunk`, `agent_thought_chunk` (solo con gpt-5.6-luna), `tool_call` (edit con contenuto `diff`, read, execute), `tool_call_update` (stato; output dei comandi in `_meta.terminal_output_delta`), `available_commands_update`, `usage_update`, `session_info_update`. `stopReason: end_turn`. Mai visti: `plan` (in Codex 0.165 il modello non ha lo strumento del piano in modalità default), `current_mode_update`, `config_option_update`. Lacuna: un comando bloccato dalla sandbox non genera nessuna tool call |
| 4 | `session/request_permission` | PASS | Modifica file: `allow_once` “Yes, proceed”, `allow_always` “…don't ask again for these files”, `reject_once` (id `cancel`) “No, and tell Codex what to do differently”. Consenti una volta: `hello.txt` scritto. Rifiuta: `second.txt` non scritto, ma il turno finisce con `stopReason: cancelled` |
| 5 | `session/cancel` | PASS | Annullato 1 s dopo l'avvio di `sleep 30`: `cancelled` in 11 ms, processo `sleep` terminato; il prompt successivo risponde “OK” con `end_turn` |
| 6 | Ripresa dopo kill | PASS | SIGKILL dell'adapter (anche il figlio `codex` muore). Nuovo processo, `session/load`: 564 ms, rigioca 4 aggiornamenti prima della risposta (`user_message_chunk`, `agent_message_chunk`, comandi, info); il modello ricorda “BLUEBERRY-42”. `session/resume`: 48 ms, nessun aggiornamento rigiocato, memoria intatta. `session/list` la elenca. Modello ed effort **non** vengono ripristinati: tornano a quelli di `config.toml` |
| 7 | Tempo al primo chunk | Misurato | Spawn → `initialize`: 100–135 ms, 250 ms via `npx` (1,7 s al primo avvio a freddo). `session/new`: 0,3–1,0 s (una volta 2,3 s). Primo `session/update`: 5–40 ms. Primo `agent_message_chunk` (gpt-6-luna, low): 0,8–1,9 s su prompt banali, 4,4–5,6 s se prima ci sono tool call |
| 8 | Registro | PASS | 45 agenti, versione 1.0.0; distribuzione npx 23, binary 22, uvx 2. Nessuna informazione di login. 7 binari senza `sha256`. Campione in `registry-sample.json`. `npm run probe -- --registry codex-acp` avvia Codex partendo solo dai dati del registro |
| 9 | Mappatura verso gli eventi Blue | Proposta | Tabella sotto e `src/normalize.ts`, usato da tutti gli script |

Log di riferimento in `results/` (solo locali): `probe-codex-acp-2026-11-07T12-56-56-537Z`, `turn-codex-acp-2026-11-07T13-03-01-053Z` (con `appserver-turn/`), `turn-codex-acp-2026-11-07T12-59-15-292Z` (comandi invisibili), `cancel-codex-acp-2026-11-07T13-03-57-888Z`, `resume-codex-acp-2026-11-07T13-04-41-469Z`, `ttfc-codex-acp-2026-11-07T13-05-51-314Z`.

## Insidie

**SDK 2.x.** Non c'è più `ClientSideConnection`. Si scrive `acp.client({ name }).onRequest(...).onNotification(...)`, poi `app.connect(ndJsonStream(...))` restituisce una `ClientConnection`; da `connection.agent` si chiama `request(acp.methods.agent.session.new, …)` e `notify(acp.methods.agent.session.cancel, …)`. `connectWith` chiude la connessione quando la callback finisce: per un host che resta vivo serve `connect`. L'SDK non avvia processi: lo stdio del figlio va convertito con `Writable.toWeb` e `Readable.toWeb`. `zod` è una peer dependency da installare. I gestori di notifiche asincroni girano in parallelo: l'ordine va garantito a mano. Per loggare ogni messaggio basta avvolgere lo `Stream` in due `TransformStream`. Il v1 stabile del 2.4.0 include già session/list, resume, close, delete e `notice`; `usage` in `PromptResponse` esiste solo in `/unstable` e `models` in `session/new` non è più in nessuno schema, ma codex-acp li manda comunque.

**Capacità.** Codex non usa fs né terminale del client: scrive e esegue da sé. Manda comunque un contenuto `{ type: "terminal", terminalId }` anche se il client non annuncia il terminale, e l'output vero arriva in `_meta.terminal_output_delta`, fuori standard. I gestori fs di `AcpHost` sono pronti ma con Codex non sono mai stati chiamati.

**Login.** `authMethods` arriva sempre, anche da loggati: Blue deve chiedere il login solo se `session/new` fallisce con `auth_required`. codex-acp manda una notifica di estensione `_auth/status_update` con email e piano dell'account: va trattata come dato personale.

**Modello economico.** ACP non dà prezzi e i nomi sono opachi (Sol, Terra, Luna, Astra). L'euristica guarda la descrizione (“affordable”); Blue deve far scegliere all'utente o tenere un predefinito per agente. Le scelte si perdono con load e resume (con Codex tornano a gpt-5.6-sol/high): vanno salvate e riapplicate.

**Permessi.** Il `kind` non basta. In codex-acp `reject_once` può essere `cancel` (ferma il turno) o, per i comandi, `decline` (continua senza eseguire). Blue deve mostrare i nomi delle opzioni e aspettarsi la fine del turno dopo un rifiuto.

**Tool call lasciate aperte.** Dopo rifiuto o annullamento la tool call resta `in_progress` per sempre. Blue la chiude da sé alla fine del turno.

**Azioni invisibili.** Codex 0.165 usa la “code mode”: il modello chiama tutto tramite uno strumento JavaScript `exec`. Le chiamate annidate a `apply_patch` ed `exec_command` diventano item e quindi tool call ACP; un comando bloccato dalla sandbox no, perché nemmeno l'App Server emette l'item (verificato nel log dell'App Server e nel rollout). In un primo tentativo gpt-6-luna ha provato a scrivere il file da shell in sola lettura: nessun evento, solo il messaggio finale. Riguarda anche lo spike S1.

**Altro.** La modalità predefinita di codex-acp è “Auto review”: esegue nel workspace senza chiedere. Dopo il primo turno codex-acp fa una chiamata in più al modello per generare il titolo. Non esiste un evento di fine messaggio: il confine si ricava da `messageId`, dal primo aggiornamento di altro tipo o dalla fine del turno. L'adapter usa il vero `~/.codex`, con il suo `config.toml`.

## Mappatura verso gli eventi di Blue

| ACP | Evento Blue | Note |
|---|---|---|
| invio di `session/prompt` | `turn.started` | lato client |
| `agent_message_chunk` | `message.delta` | `messageId` quando c'è |
| confine o fine turno | `message.completed` | calcolato da Blue |
| `agent_thought_chunk` | `reasoning` | delta, chiusura calcolata come per i messaggi |
| `tool_call` | `tool.started` | `kind` (read, edit, execute…), `title`, `locations`, `rawInput` |
| `tool_call_update` con `content` (testo, terminale, diff) o `_meta.*terminal_output*` | `tool.output` | il diff è una proposta per file (testo intero, prima dell'approvazione) |
| `tool_call_update` con stato `completed` o `failed` | `tool.completed` | `rawOutput` (per esempio `exit_code`) |
| `session/request_permission` | `request.opened` | chiave: id JSON-RPC; opzioni con `kind` e nome |
| risposta del client, o `cancelled` all'annullamento | `request.resolved` | all'annullamento le richieste aperte vanno chiuse con `cancelled` |
| `plan` | `plan.updated` | sostituisce l'intero elenco |
| `usage_update` | `usage` | solo finestra di contesto (`used`, `size`, `cost` facoltativo); token del turno da `PromptResponse.usage` (instabile); niente limiti d'uso |
| `stopReason` `end_turn`, `max_tokens`, `max_turn_requests`, `refusal` | `turn.completed` | |
| `stopReason` `cancelled` | `turn.completed` con stato interrupted | |
| errore JSON-RPC su `session/prompt` o uscita del processo | `turn.failed` | |
| `user_message_chunk` | voce di storia | arriva solo con `session/load` |
| `available_commands_update` | comandi del composer | i comandi `/` annunciati dall'agente |
| `current_mode_update`, `config_option_update` | configurazione della sessione | |
| `session_info_update` | titolo della sessione | |
| `notice` | avviso | |
| metodi e campi con `_` | ignorati, nel log grezzo | |

Cosa deve calcolare Blue da sé:

- il diff del turno, da git rispetto al checkpoint: ACP dà solo diff per singola tool call, e Codex li manda prima dell'approvazione (nel test c'era anche quello del file rifiutato, mentre `git diff` mostrava solo `hello.txt`);
- la fine di messaggi e ragionamenti, la durata dei turni;
- la chiusura di tool call e richieste rimaste aperte a fine turno, annullamento o crash, e lo stato “scaduta” delle card;
- la configurazione per thread (modello, effort, modalità) da riapplicare dopo load e resume;
- la storia: `session/resume` non rigioca nulla, quindi la fonte resta il log eventi di Blue;
- i limiti d'uso, che ACP non espone;
- il riavvio del processo dopo un crash, seguito da `session/resume`.

## Raccomandazione per l'adapter ACP di Blue

1. Un solo `AcpAdapter` configurato da un `AgentSpec` (dal registro o scritto a mano). Le differenze tra agenti restano dati facoltativi: modello predefinito, variabili da togliere.
2. SDK 2.4.0 fissato, entrypoint stabile v1; tipi da `/unstable` solo per leggere campi facoltativi come `usage`.
3. Capacità: fs lettura e scrittura limitate alle radici della sessione; terminale spento nella v1 (si aggiunge con node-pty); `auth.terminal` quando Blue saprà aprire un terminale di login; niente elicitation.
4. Opzioni di configurazione al posto delle modalità vecchio stile, salvate nel thread e riapplicate dopo ogni load o resume.
5. Ripresa con `session/resume` e storia dal log di Blue; `session/load` solo per importare sessioni che Blue non conosce, da `session/list`.
6. Card di permesso con i nomi delle opzioni dell'agente, tasti rapidi per `kind`, nessuna ipotesi su cosa succede dopo un rifiuto.
7. Diff da GitService, non dalle tool call.
8. Log JSONL grezzo per sessione, con le notifiche `_auth` oscurate.
9. Per Claude Code e Codex gli adapter nativi restano la prima scelta: via ACP Codex perde i comandi bloccati, i limiti d'uso, il diff aggregato e il piano.

## Cosa cambia nel piano

- Confermato: “aggiungere un agente ACP costa una voce di configurazione” per npx e uvx. Per i binari Blue deve scaricare, verificare e estrarre (7 voci senza `sha256`). Il registro non dice come si fa il login: Blue lo scopre da `initialize`.
- Confermato: `session/load` rigioca la storia, `session/resume` no.
- Nuovo: le opzioni di configurazione non sopravvivono a load e resume, almeno con Codex.
- Nuovo: il significato del rifiuto cambia da agente ad agente (con Codex spesso ferma il turno).
- Nuovo: con Codex 0.165 i comandi bloccati dalla sandbox non producono eventi né via ACP né dall'App Server. Da controllare nello spike S1.
- Aperto: il piano chiedeva due agenti diversi; qui è stato provato solo Codex. Il secondo (`claude-acp` o `gemini`) gira con gli stessi script cambiando `--registry`.

## Secondo agente: Claude (prova senza prompt)

Eseguito dopo la chiusura dello spike con `npm run probe -- --registry claude-acp` (`@agentclientprotocol/claude-agent-acp@0.101.0`, login Claude dell’utente, `ANTHROPIC_API_KEY` rimossa dall’ambiente). Stesso client, nessun codice specifico:

- `initialize` in 7,7 s al primo avvio (download con npx), protocollo 1, `loadSession`, `resume`, `fork`, `list`, `close`; nessun metodo di login esposto, lo stato arriva con `_auth/status_update`.
- `session/new` in 2 s; modalità `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions` (predefinita `auto`); opzioni `mode`, `model`, `effort`.
- `set_config_option` per modello (`haiku`) ed effort (`low`) funziona.
- Nessuna richiesta lato client (fs, terminale, permessi) durante l’avvio.

Il prompt non è stato inviato per non consumare quota: resta da provare un turno completo con permessi.
