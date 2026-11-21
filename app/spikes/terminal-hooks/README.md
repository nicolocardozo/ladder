# S6 · Stato delle sessioni terminale tramite hook

Domanda: Blue può sapere se una sessione terminale (la CLI originale in un PTY) sta lavorando, aspetta te o ha finito, iniettando gli hook per processo e senza toccare la configurazione globale?

**Sì per Claude Code, sì con riserve per Codex.** Per Claude Code bastano gli hook inline in `--settings`, che sono immediati e precisi. Per Codex funzionano `notify` e OSC 9 passati con `-c`. Gli hook di Codex invece richiedono la fiducia salvata in `config.toml`, oppure `--dangerously-bypass-hook-trust`. In entrambe le CLI il rifiuto di un permesso con Esc non produce alcun segnale.

## Come si esegue

```sh
npm install              # postinstall: chmod +x dello spawn-helper di node-pty (vedi sotto)
npm run pty:check        # node-pty carica e apre un PTY 120×40
npm run hash             # SHA-256 di ~/.claude/settings.json e ~/.codex/config.toml (solo hash)

npm run claude                        # fiducia → permesso consentito → AskUserQuestion → permesso negato → 75 s di attesa → /exit
SCENARIO=idle npm run claude          # un turno, poi attesa di Notification idle_prompt
IDLE_WAIT_MS=3000 npm run claude      # come sopra, con un'attesa finale breve

npm run codex                                          # OSC 9 + notify: approvazione consentita, poi negata
CODEX_NOTIF_METHOD=bel npm run codex                   # BEL al posto di OSC 9
CODEX_HOOKS=1 npm run codex                            # hook via -c, senza fiducia: modale "Hooks need review"
CODEX_HOOKS=1 CODEX_BYPASS_HOOK_TRUST=1 npm run codex  # hook con --dangerously-bypass-hook-trust
CODEX_DOTTED_REPO=1 CODEX_TRUST_FORM=table npm run codex  # fiducia per un percorso che contiene un punto
```

Ogni esecuzione scrive in `results/<scenario>-<ora>/` questi file: `hooks.jsonl` con gli hook ricevuti, `pty.raw` con il transcript grezzo del PTY, `pty-timeline.jsonl` con i chunk temporizzati (input, output, risposte del terminale, OSC, BEL), `screens/` con lo schermo renderizzato da `@xterm/headless` nei momenti chiave e `summary.json`.

Script: `src/claude.ts`, `src/codex.ts`, `src/notify.mjs` (programma `notify` di Codex), `src/lib.ts` (PTY + schermo headless + server degli hook), `src/toml-keys.ts` (elenca le chiavi di `config.toml` con un hash corto dei valori, senza mai mostrarli). I repo di prova stanno in `os.tmpdir()`. L'ambiente del figlio è una whitelist (HOME, PATH, LANG…), senza `ANTHROPIC_*`, `CLAUDE*` e `OPENAI_*`, così vale il login in abbonamento.

## PTY

- **`node-pty` 1.1.0 funziona** su Node 24.20 / macOS arm64 con il prebuild incluso, senza compilare. È un modulo N-API (`napi_register_module_v1`), quindi in Electron non dovrebbe servire `electron-rebuild`: da verificare nello scaffold F0. `@homebridge/node-pty-prebuilt-multiarch` non è servito.
- Insidia: nel tarball `prebuilds/darwin-arm64/spawn-helper` arriva con i permessi `644`, e il primo `spawn` fallisce con `posix_spawnp failed`. Il rimedio è il `chmod +x` nel postinstall. npm 11 blocca gli script di installazione delle dipendenze (`allowScripts`) e pnpm fa lo stesso: il chmod va fatto dal progetto. In Electron lo `spawn-helper` deve stare fuori dall'asar (`asarUnpack`).
- Le risposte del terminale (DA1, DSR, colori) vanno restituite al processo collegando `term.onData` di xterm a `pty.write`, come farà Blue con xterm.js.

## Risultati

Esecuzioni di riferimento: Claude `claude-…T13-08-41` (completa, 75 s di attesa), `claude-…T13-11-13` (idle), `claude-…T13-23-18` (finale); Codex `codex-osc9-…T13-15-24`, `codex-bel-…T13-16-24`, `codex-osc9-hooks-…T13-19-31`, `codex-osc9-hooks-bypass-…T13-20-10`, `codex-osc9-…T13-23-56` (finale). Latenza = istante dell'hook meno istante del cambio di schermo (negativo = l'hook arriva prima).

| # | Criterio | Esito | Evidenza |
|---|---|---|---|
| A1 | Hook inline con `--settings '<json>'` (tipo `command` + curl) | ✅ | Arrivano SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Notification, Stop, SessionEnd; `session_id` = `--session-id` in ogni payload |
| A1b | Handler `http` | ✅ | Funziona senza altre impostazioni (UserPromptSubmit, PermissionRequest, Notification, Stop). Arriva ~10 ms prima del curl. Header `X-Blue-Token: $BLUE_HOOK_TOKEN` con `allowedEnvVars`: token verificato in ogni chiamata. SessionStart non supporta `http` |
| A1c | StopFailure | ⚪ | Chiave accettata, mai scattata (nessun errore API) |
| A2 | Fiducia della cartella | ✅ | Gestita via PTY. In 2.1.316/319 l'opzione preselezionata è **"No, exit"**: Invio chiude Claude (exit 1). Serve ↓ e poi Invio. Prima della conferma non arriva **nessun** hook; SessionStart arriva ~95 ms dopo |
| A3 | "In attesa di permesso" | ✅ | `PermissionRequest` (tool_name, tool_input.command/description, permission_suggestions) arriva **6–8 ms prima** del dialogo. `Notification permission_prompt` ("Claude needs your permission") arriva **+6,0 s** dopo, con un ritardo fisso in 3 esecuzioni su 3 |
| A3b | Consenso via PTY | ✅ | Invio su "1. Yes": il dialogo si chiude in ~25 ms. Nessun hook segnala la risposta; il primo è `PostToolUse` a +400 ms, a comando finito |
| A3c | Fine turno | ✅ | `Stop` con `last_assistant_message: "ok"` arriva **11–14 ms prima** che sparisca lo spinner |
| A3d | Domanda (AskUserQuestion) | ✅ | `PreToolUse` + `PermissionRequest` con `tool_name: AskUserQuestion` ~13 ms prima del dialogo; nessuna Notification entro 3 s |
| A3e | Permesso negato con Esc | ❌ | **Nessun hook**: niente Stop, PostToolUseFailure o PermissionDenied. Il transcript JSONL (`transcript_path`) registra invece `[Request interrupted by user for tool use]` e `system/turn_duration` |
| A4 | `idle_prompt` | ⚠️ | Arriva esattamente **60,0 s dopo Stop** ("Claude is waiting for your input"), anche senza eventi di focus. Dopo un rifiuto non arriva (75 s di attesa). Non indica un blocco |
| B5 | `notify` via `-c` | ✅⚠️ | `agent-turn-complete` con `thread-id`, `turn-id`, `cwd`, `client: codex-tui`, `input-messages`, `last-assistant-message`; token ok. **Falso positivo**: al primo turno scatta anche per il thread interno che genera il titolo (thread-id diverso, input "Generate a concise, single-line task title…"), 0,4–2 s prima della fine reale |
| B5b | OSC 9 (`tui.notification_method="osc9"`, `notification_condition="always"`) | ✅ | All'approvazione `Approval requested: /bin/zsh -lc 'date > now.txt'` (troncato se lungo) arriva nello stesso chunk del dialogo (0/−1 ms); a fine turno OSC 9 con l'ultimo messaggio, ~40 ms prima di notify. Solo thread principale |
| B5c | BEL | ✅ | BEL all'approvazione e a fine turno, ma senza testo: non distingue i due casi |
| B5d | Approvazione via PTY | ✅ | `y` approva. Esc nega e **non emette nessun segnale** (né notify, né OSC, né hook Stop) |
| B5e | Fiducia del progetto per processo | ✅ | `-c projects.<percorso>.trust_level="trusted"` funziona senza virgolette. Con le virgolette ricompare il prompt "Trust this folder?", perché il percorso `-c` è diviso sui punti. Per percorsi con un punto funziona la forma tabella `-c 'projects={"<percorso>"={trust_level="trusted"}}'` |
| B6 | Hook di Codex via `-c` | ⚠️ | Senza fiducia compare una **modale bloccante** "Hooks need review · 4 hooks are new or changed" (Review / Trust all and continue / Continue without trusting). Con "Continue without trusting" gli hook non girano. Con `--dangerously-bypass-hook-trust` (**usato solo nello scenario `CODEX_BYPASS_HOOK_TRUST=1`**) arrivano: SessionStart al primo prompt, con `session_id` = thread-id principale di notify; UserPromptSubmit; PermissionRequest (tool_name Bash, tool_input.command) ~8 ms prima del dialogo; Stop con last_assistant_message ~40 ms prima di notify. Dopo un rifiuto: nessuno Stop |
| C | Config globale invariata | ✅ Claude / ⚠️ Codex | `~/.claude/settings.json` resta `8eb54ad5…` per tutto lo spike. `~/.codex/config.toml`: i valori iniettati (notify, tui.notification*, hooks, projects) non vengono mai scritti. La **TUI però scrive il proprio stato di interfaccia**: il primo avvio riuscito ha aggiunto `[tui.model_availability_nux] "gpt-6.1-sol" = 1` (certo, diff delle chiavi); probabile anche `tui.screen_reader_detection_done` all'avvio del 13:11:18Z. Dopo aver aggiunto `-c 'tui.model_availability_nux={"gpt-6.1-sol"=99}'`, sei esecuzioni successive lasciano hash e chiavi invariati (finale `76a5b567…` → `76a5b567…`). Nello stesso periodo lo spike `codex-app-server` aggiungeva `[projects."…/blue-spike-codex-*"]`: i suoi cambi non dipendono da questo spike |

## Macchina a stati per Claude Code

Blue la ricava solo dagli hook `command` (o `http`, non entrambi). La chiave è `session_id`, che Blue sceglie con `--session-id`.

| Evento | Stato |
|---|---|
| (avvio, nessun hook) | `starting`. Se resta così, probabilmente c'è il dialogo di fiducia: si mostra "apri il terminale" |
| SessionStart | `idle` (pronta) |
| UserPromptSubmit, PreToolUse(≠AskUserQuestion), PostToolUse, PostToolUseFailure | `running` (dettaglio: tool_name) |
| PermissionRequest(tool ≠ AskUserQuestion) | `waiting:permission` (comando, descrizione) |
| PreToolUse / PermissionRequest(AskUserQuestion) | `waiting:question` |
| Notification permission_prompt | solo conferma, arriva 6 s dopo PermissionRequest; usarla se manca PermissionRequest |
| Notification idle_prompt | nessun cambio di stato (falso "in attesa": la sessione è già `done`) |
| Stop | `done` (last_assistant_message per l'anteprima) |
| StopFailure | `error` (campo `error`: rate_limit, authentication_failed…) |
| SessionEnd / uscita del PTY | `exited` |
| **Rifiuto o interruzione (Esc)** | nessun hook: serve un ripiego (vedi raccomandazioni) |

## Macchina a stati per Codex

| Segnale | Stato |
|---|---|
| Input del prompt nel PTY (o hook UserPromptSubmit se fidato) | `running` |
| OSC 9 che inizia con `Approval requested:` (o hook PermissionRequest) | `waiting:permission` |
| OSC 9 con altro testo, notify `agent-turn-complete` del thread principale, o hook Stop | `done` |
| notify di un altro thread-id (titolo) | da ignorare |
| Esc su un'approvazione, Ctrl-C | nessun segnale |
| Uscita del PTY | `exited` |

Senza hook Blue non conosce in anticipo il thread-id principale: Codex non ha un `--session-id`. Il criterio più pratico è usare OSC 9 come fonte primaria, che riguarda solo il thread principale, e notify come conferma, scartando gli input "Generate a concise, single-line task title…". Con gli hook fidati, il `session_id` di SessionStart risolve il problema.

## Insidie

- **Claude:** il dialogo di fiducia ha "No, exit" preselezionato, e finché non lo accetti non arriva nessun hook. Accettarlo scrive la cartella in `~/.claude.json` (`projects[…].hasTrustDialogAccepted`): lo spike ha lasciato 3 voci per cartelle temporanee `blue-s6-claude-*`.
- **Claude:** senza `DISABLE_AUTOUPDATER=1` la CLI si aggiorna da sola durante la sessione. Lo spike l'ha aggiornata da **2.1.316 a 2.1.319** (symlink `~/.local/bin/claude`, 14:06) prima che aggiungessi la variabile. Le esecuzioni successive girano su 2.1.319, con lo stesso comportamento.
- **Claude:** la Notification `permission_prompt` ha un ritardo di ~6 s, quindi lo stato immediato va preso da PermissionRequest. Gli hook PermissionRequest sono bloccanti e possono decidere: il server di Blue deve rispondere 200 **senza corpo**, e curl deve usare `-o /dev/null`, altrimenti l'output diventa una decisione.
- **Claude:** il token va nell'ambiente (`$BLUE_HOOK_TOKEN`) e non negli argomenti, che sono visibili con `ps`.
- **Codex:** `approval_policy="untrusted"` non è più supportato in 0.167 ed esce con un errore all'avvio. Per avere un'approvazione serve `-a on-request` con una sandbox che la richieda.
- **Codex:** `tui.notification_condition` ha come default `unfocused`. In un PTY senza eventi di focus conviene `always`, oppure Blue invia `CSI O`/`CSI I` (modo 1004) quando il pannello perde o prende il focus.
- **Codex:** lo spike usa `--no-daemon`, così gli override `-c` valgono per questo processo. Il comportamento con il server condiviso (`daemon_auto_start`) non è stato verificato.
- **Codex:** la TUI salva in `config.toml` lo stato dei propri avvisi (NUX dei modelli, rilevamento screen reader), come farebbe con un avvio manuale. Blue non può impedirlo in generale: solo caso per caso, con override `-c`.
- **Codex:** la fiducia degli hook viene salvata in `config.toml` (dalle stringhe del binario risulta `hooks.state.<id>.trusted_hash`, non verificato). Scegliere "Trust all" scriverebbe quindi nella configurazione globale.

## Raccomandazione per TerminalService

1. **Claude Code:** hook inline con `--settings`, un handler per evento (`http` dove supportato, `command`+curl per SessionStart e SessionEnd), `--session-id` generato da Blue, token nell'ambiente, server locale che risponde 200 vuoto e scarta i payload senza token valido.
2. **Ripiego per rifiuti e interruzioni:** quando lo stato è `waiting:*` e non arriva un hook, Blue legge la coda di `transcript_path` (da SessionStart). La voce `system/turn_duration` chiude ogni turno, anche interrotto. È un formato interno, quindi va trattato come euristica con l'etichetta "stato stimato". In aggiunta: input dell'utente nel PTY mentre lo stato è `waiting:permission` e dialogo scomparso → `running?`.
3. **Fiducia:** prima di avviare, Blue controlla `~/.claude.json` (solo `hasTrustDialogAccepted` per il cwd). Se la cartella non è fidata, la sessione nasce con l'etichetta "serve conferma nel terminale" invece di "in corso".
4. **Codex:** `-c` per notify, `tui.notifications=["agent-turn-complete","approval-requested"]`, `tui.notification_method="osc9"`, `tui.notification_condition="always"`, fiducia del progetto in forma tabella e `--no-daemon`. Lo stato viene da OSC 9 letto con `term.parser.registerOscHandler(9, …)` di xterm.js, più notify filtrato per thread. Gli hook di Codex non vanno usati finché la fiducia richiede la scrittura in `config.toml` o il bypass "dangerous"; si possono riconsiderare se Blue accetta di far fidare i propri hook una volta tramite `/hooks`.
5. Il piano va aggiornato (sezione S6): per Codex le approvazioni si leggono già da OSC 9, quindi gli hook non servono. Per entrambe le CLI va previsto lo stato "stimato" dopo un Esc.
