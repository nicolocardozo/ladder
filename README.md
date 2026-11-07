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

Prossime fasi: Codex e agenti ACP (4), poi il passaggio tra agenti (5).

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
- `src/host`: host delle sessioni in un `utilityProcess`, con SQLite (`node:sqlite`), adapter Claude Code (Agent SDK), checkpoint e diff git (`git.ts`, `workspace.ts`), file (`files.ts`), terminali con node-pty e xterm headless (`terminals.ts`), worktree e porte (`worktrees.ts`), configurazione del progetto (`project-settings.ts`), GitHub con gh (`github.ts`), ricerca (`search.ts`) e prompt dei pulsanti (`prompts.ts`).
- `src/shared/protocol.ts`: tipi e messaggi tra host e interfaccia.
- `src/renderer`: React; lo stato arriva dall’host (`store/app-store.ts`), la chat è in `components/chat`, l’ispettore in `components/inspector`, i terminali in `components/terminal` e `lib/terminal-registry.ts`.

Per il debug:
- la pagina espone `window.__ladder` (`request`, `send`, `store`, `settings`);
- `LADDER_USER_DATA=<cartella>` usa un archivio separato;
- `LADDER_WORKTREES=<cartella>` sposta i worktree;
- `LADDER_EDITOR_TRACE=<file>` registra le aperture nell’editor invece di eseguirle, per le prove automatiche;
- `LADDER_NOTIFY_TRACE=<file>` registra notifiche e badge invece di mostrarli;
- `LADDER_GH=<eseguibile>` sostituisce gh, `LADDER_LINEAR_API=<url>` l’API di Linear e `LADDER_PR_POLL_MS` l’intervallo di lettura delle PR (90 s).

node-pty è l’unico modulo nativo: usa il prebuild N-API incluso (niente node-gyp), il `postinstall` rende eseguibile lo `spawn-helper` e nella build resta fuori dall’asar.
