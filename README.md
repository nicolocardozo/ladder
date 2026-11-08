# Ladder

Workspace desktop per macOS in cui lavori su più repository insieme, con Claude Code, Codex e altri agenti di sviluppo in chat o in terminale.

Il piano di prodotto e architettura è in [`docs/piano.html`](docs/piano.html).

## Struttura

| Cartella | Contenuto |
|---|---|
| `apps/desktop` | App Electron con React, TypeScript, Tailwind v4 e shadcn/ui (base Base UI) |
| `spikes/` | Prototipi della fase 0, pacchetti npm autonomi fuori dal workspace |
| `docs/` | Piano, rapporto della fase 0 e documenti di lavoro |

## Avvio

Serve Node 24 e pnpm.

```bash
pnpm install
```

```bash
pnpm dev
```

`pnpm dev` apre l’app Electron. Per provare solo l’interfaccia nel browser, su `http://localhost:5199`:

```bash
pnpm --filter @ladder/desktop dev:web
```

Se Electron non parte perché manca il binario, lo scarica lo script `postinstall` dell’app; in alternativa:

```bash
node apps/desktop/node_modules/electron/install.js
```

## Stato

Fase 1 completata. Funziona:

- progetti reali (si aggiungono scegliendo la cartella) e sessioni Claude Code con il tuo login, nella sidebar con il loro stato;
- chat con streaming, riepilogo dell’attività, blocchi di codice con copia, riferimenti ai file che si aprono in Cursor alla riga giusta, file modificati per turno (checkpoint git);
- approvazioni e domande con scorciatoie, coda dei messaggi modificabile, stop, modello, effort e quattro livelli di permesso (⇧Tab);
- `@` per citare i file del progetto, immagini incollate, trascinate o scelte con `+`;
- menu delle sessioni (rinomina, segna come da leggere, archivia, apri in Cursor o nel Finder), ⌘K per cercare sessioni, progetti e azioni, ⌘B per la sidebar, ⌘[ e ⌘] per tornare indietro e avanti, ⌘⇧A per la prossima sessione che ti aspetta;
- tab per progetto (⌘1…⌘9, ⌘W), bozze, posizione di lettura e ripresa delle sessioni dopo il riavvio.

Fase 1.5 completata: identità Circuit e dodici temi, scelti in Impostazioni → Aspetto (⌘,). Il tema vale per tutta l’app, si salva in `settings.json` nella cartella dati e si applica prima del primo paint; un valore sconosciuto torna a Circuit.

Fase 2 completata: file, diff e terminale.

- Ispettore a destra (icona nella barra o ⌘⌥1, ⌘⌥2, ⌘⌥3):
  - **Modifiche**: per turno, per sessione o non committate, in vista unificata o affiancata. Puoi commentare le righe e inviare i commenti all’agente in un solo messaggio. Puoi ripristinare un file o tutto, e annullare il ripristino.
  - **File**: albero con stato git e turno che ha toccato il file, viewer con evidenziazione e “Aggiungi alla chat” sulla selezione.
  - **Cronologia**: checkpoint, ripristini e commit in un’unica linea del tempo.
- Riferimenti ai file:
  - nella chat, un clic apre il file nel viewer e ⌥clic lo apre nell’editor del progetto (Cursor o VS Code, da scegliere accanto ad “Apri in…”);
  - ⌘P apre un file per nome, anche con `percorso:riga`.
- Terminale (⌃`): xterm.js con node-pty nell’host, schede per progetto. I terminali restano vivi cambiando progetto e dopo un riavvio la shell riparte nella stessa cartella. `@terminal` nel composer allega l’output di un terminale al messaggio.
- Sessioni terminale: `claude`, `codex` o qualunque comando, scelti nella nuova chat. Lo stato arriva così:
  - da `claude`, tramite hook iniettati per processo, quindi compare in “In attesa” quando chiede un permesso;
  - da `codex`, tramite le notifiche della TUI;
  - per gli altri comandi è stimato.
- `.ladder/settings.toml` del progetto (più `settings.local.toml` personale, escluso da git tramite `.git/info/exclude`):
  - worktree con setup, file da copiare e comando di archivio;
  - azioni `[[run]]` come pulsanti nella barra, nel terminale della sessione;
  - un blocco di porte per cartella in `LADDER_PORT`: 4100 per il primo progetto, poi 4200 e così via, con un blocco a parte per ogni worktree.

```toml
[worktree]
setup   = "pnpm install --frozen-lockfile"
copy    = [".env.local"]
archive = "docker compose down"

[[run]]
name    = "dev"
command = "pnpm dev --port $LADDER_PORT"
default = true
```

I worktree nascono in `~/Developer/.ladder/worktrees/<progetto>/<slug>` su un branch `ladder/<slug>`.

Fase 3 completata: più progetti insieme e merge.

- **In attesa** (sidebar): le richieste di tutti i progetti con le loro azioni, poi gli errori e le risposte da leggere.
  - Approvi o rispondi senza lasciare la sessione che hai davanti: la bozza e il cursore restano dove erano.
  - Le modifiche oltre 40 righe si approvano dalla sessione, dopo averle lette.
  - ⌘⇧A porta alla richiesta più vecchia con il focus su Approva; ⌘[ ti riporta indietro con il cursore al suo posto.
- **Notifiche di macOS**:
  - approvazioni e domande arrivano subito, tranne se stai guardando quella sessione; se sei nel suo progetto compare un avviso nella barra delle tab, con “Vai”;
  - un errore, una notifica per sessione;
  - le risposte pronte solo per turni oltre un minuto, se non sei nel progetto, raccolte per progetto (“acme-vet: 2 risposte pronte”).

  Il clic apre la sessione sull’elemento, e aprire una sessione ritira le sue notifiche. Il badge del Dock conta le richieste e gli errori non ancora visti. “Non disturbare per 1 ora” si attiva dal menu Ladder, da ⌘K o dalle Impostazioni.
- **Mentre eri via**: tornando su un progetto dopo più di 30 minuti, una riga riassume risposte, richieste ed errori arrivati nel frattempo.
- **Concluse**: le sessioni ferme da 3 giorni, senza niente da leggere e senza bozza, scendono in un gruppo chiuso.
- **⌘K**: cerca anche nel testo delle conversazioni, nei comandi e nei file toccati, in tutti i progetti e senza badare agli accenti.
- **Limite di sessioni attive** (Impostazioni → Agenti, 3 per Claude Code): oltre il limite la sessione aspetta “In coda” e parte da sola appena c’è posto.
- **⌘⇧N**: nuova sessione da una issue o una PR di GitHub, da una issue di Linear o da un branch. Il prompt è già scritto e il worktree è sul branch giusto.
- **Merge** (⌘⌥4):
  - stato del branch, PR, CI e commenti di review;
  - i conflitti con la base sono calcolati senza toccare la cartella;
  - “Crea PR”, “Correggi la CI”, “Risolvi i conflitti” e “Invia i commenti” mandano all’agente un prompt che puoi modificare prima.

  Sulla riga della sessione compare lo stato della PR: unita, CI fallita, conflitti. Quando la PR viene unita, la sessione nel worktree si archivia e il worktree, se è pulito, si toglie; il branch resta.

GitHub passa dalla CLI `gh` con il suo login: Ladder non conserva token. Linear usa una chiave API personale, salvata cifrata nel portachiavi di macOS (Impostazioni → Integrazioni).

I prompt dei pulsanti si cambiano in `.ladder/settings.toml`, con un percorso o con il testo stesso:

```toml
[prompts]
create_pr = ".ladder/prompts/pr.md"
fix       = ".ladder/prompts/fix.md"
```

I nomi sono `create_pr`, `fix`, `conflicts`, `comments`, `issue`, `pull_request` e `review`. Le variabili si scrivono come `{{branch}}`, `{{base}}`, `{{pr}}`, `{{checks}}`, `{{conflicts}}`, `{{comments}}`, `{{ref}}`, `{{title}}`, `{{url}}` e `{{body}}`.

Fase 4 completata: Codex e altri agenti.

- **Codex** in chat, con l’adapter nativo sull’App Server:
  - approvazioni con le decisioni di Codex: Approva, Consenti per la sessione, Rifiuta (il motivo del rifiuto arriva al turno in corso);
  - testo, comandi e modifiche in streaming, modello ed effort a ogni turno, interruzione anche con un comando ancora in corso, ripresa del thread dopo un riavvio;
  - account, modelli e limiti d’uso in Impostazioni → Agenti.

  Ladder usa il Codex installato: la CLI nel `PATH`, l’app Codex o quello delle estensioni per Cursor e VS Code. Non ne porta una copia, perché il binario pesa circa 350 MB.
- **Agenti ACP** (Agent Client Protocol): Impostazioni → Agenti → “Aggiungi un agente ACP”, dal registro ufficiale (npx o uvx) o con un comando scritto a mano. Non serve codice per agente:
  - modello e modalità vengono dalle sue opzioni;
  - le richieste di permesso mostrano le opzioni con i nomi dell’agente;
  - il diff del turno lo calcola Ladder da git.
- **Nuova chat**: un menu sceglie l’agente, con i modelli, l’effort e i permessi di ciascuno. Propone l’ultimo usato nel progetto.
- **Regole di progetto** in `.ladder/settings.toml`: agenti ammessi, agente proposto e livello di permesso massimo.

  ```toml
  [agents]
  allowed = ["claude-code", "codex"]
  default = "claude-code"
  permissions_max = "edit"
  ```

- **Chiedi una review a…** nel pannello Modifiche: un altro agente rilegge le modifiche in sola lettura, con il prompt `review` del progetto. I suoi commenti arrivano nel diff, pronti da inviare all’agente che ha scritto il codice.

Fase 4.5, revisione dell’interfaccia: approvata l’8/11 (da riguardare dopo il periodo di prova).

- **Caratteri**: Mona Sans per l’interfaccia, Monaspace Neon per codice, diff e terminale, inclusi nell’app (OFL).
- **Scala**: sei passi da 12 a 26 px (`text-xs`…`text-2xl` in `globals.css`), al posto delle dimensioni scritte a mano.
- **Pulizia**: niente maiuscoletti spaziati né barre laterali colorate, meno linee, nessun titolo ripetuto.
- **Chi lavora**: segno del provider e modello ovunque compaia una sessione (sidebar su due righe, tab, intestazione, “In attesa”, ⌘K, menu, composer).
- `PRODUCT.md` e `DESIGN.md` nella radice del repository descrivono personalità, principi e sistema visivo: valgono per ogni modifica all’interfaccia.
- **Lingua**: l’inglese è la lingua predefinita, l’italiano si sceglie in Settings → Appearance → Language. Il testo nel codice è inglese dentro `t()` e `plural()` (`src/shared/i18n.ts`); le traduzioni italiane stanno in `src/shared/locales/it/`, con la frase inglese come chiave. Anche host e menu seguono la lingua scelta, e i prompt predefiniti per gli agenti esistono in tutte e due.
- **Mappa degli agenti**: quando una sessione avvia sotto-agenti (Agent/Task di Claude Code, `spawnAgent` di Codex) sopra il composer compare il chip “N agents”; apre un albero con stato, durata, modello, token e strumenti di ciascuno. La riga della sessione nella sidebar dice quanti ne stanno lavorando.

Prossime fasi: il passaggio tra agenti (5) e i piani eseguibili (6). L’open source (7) viene dopo un periodo di prova nell’uso quotidiano.

## Brand e temi

- `brand/themes.json` è la fonte dei token dei dodici temi; `brand/themes.css` è il riferimento per le variabili.
- `pnpm --filter @ladder/desktop sync-brand` rigenera dal JSON e dagli SVG in `logo/svg/` i file usati dall’app: `themes.generated.css`, `src/shared/themes.generated.ts` e i tracciati del logo.
- `node apps/desktop/scripts/check-contrast.mjs` verifica il contrasto di ogni tema: 4,5:1 per il testo, 3:1 per focus, bordi dei controlli e indicatori.
- Icone in `app-icon/` (la build usa `app-icon/macos/ladder-circuit.icns`), logo in `logo/`, tavole in `reference/`.

## Build da installare

```bash
pnpm --filter @ladder/desktop dist
```

Crea `apps/desktop/dist/mac-arm64/Ladder.app` con l’icona Circuit (`app-icon/macos/ladder-circuit.icns`), firmata solo per questo Mac: trascinala in Applicazioni.

## Architettura in breve

- `src/main`: finestre, menu, dialoghi; avvia l’host e gli passa una MessagePort per finestra. Notifiche e badge del Dock (`attention.ts`), link `ladder://`, Linear (`linear.ts`).
- `src/host`: host delle sessioni in un `utilityProcess`, con SQLite (`node:sqlite`), adapter Claude Code (Agent SDK), checkpoint e diff git (`git.ts`, `workspace.ts`), file (`files.ts`), terminali con node-pty e xterm headless (`terminals.ts`), worktree e porte (`worktrees.ts`), configurazione del progetto (`project-settings.ts`), GitHub con gh (`github.ts`), ricerca (`search.ts`) e prompt dei pulsanti (`prompts.ts`). Gli agenti: interfaccia comune in `agents/common.ts`, Claude Code in `claude/`, Codex sull’App Server in `codex/`, agenti ACP in `acp/`, review in `review.ts`.
- `src/shared/protocol.ts`: tipi e messaggi tra host e interfaccia.
- `src/renderer`: React; lo stato arriva dall’host (`store/app-store.ts`), la chat è in `components/chat`, l’ispettore in `components/inspector`, i terminali in `components/terminal` e `lib/terminal-registry.ts`.

Per il debug:
- la pagina espone `window.__ladder` (`request`, `send`, `store`, `settings`);
- `LADDER_USER_DATA=<cartella>` usa un archivio separato;
- `LADDER_LOCALE=en|it` sceglie la lingua iniziale di un profilo nuovo (poi vale quella salvata);
- `LADDER_WORKTREES=<cartella>` sposta i worktree;
- `LADDER_EDITOR_TRACE=<file>` registra le aperture nell’editor invece di eseguirle, per le prove automatiche;
- `LADDER_NOTIFY_TRACE=<file>` registra notifiche e badge invece di mostrarli;
- `LADDER_GH=<eseguibile>` sostituisce gh, `LADDER_LINEAR_API=<url>` l’API di Linear e `LADDER_PR_POLL_MS` l’intervallo di lettura delle PR (90 s);
- `LADDER_CODEX=<binario>` indica quale Codex usare e `LADDER_ACP_REGISTRY=<url>` sostituisce il registro ACP.

node-pty è l’unico modulo nativo: usa il prebuild N-API incluso (niente node-gyp), il `postinstall` rende eseguibile lo `spawn-helper` e nella build resta fuori dall’asar.
