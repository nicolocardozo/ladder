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

Prossime fasi: “In attesa” e notifiche (3), Explorer, diff e terminale (2), Codex e agenti ACP (4).

## Build da installare

```bash
pnpm --filter @ladder/desktop dist
```

Crea `apps/desktop/dist/mac-arm64/Ladder.app`, firmata solo per questo Mac: trascinala in Applicazioni. L’icona si rigenera con `node apps/desktop/scripts/make-icon.mjs`.

## Architettura in breve

- `src/main`: finestre, menu, dialoghi; avvia l’host e gli passa una MessagePort per finestra.
- `src/host`: host delle sessioni in un `utilityProcess`, con SQLite (`node:sqlite`), adapter Claude Code (Agent SDK) e checkpoint git.
- `src/shared/protocol.ts`: tipi e messaggi tra host e interfaccia.
- `src/renderer`: React; lo stato arriva dall’host (`store/app-store.ts`), la chat è in `components/chat`.

Per il debug, la pagina espone `window.__ladder` (`request`, `send`, `store`) e l’app accetta `LADDER_USER_DATA=<cartella>` per usare un archivio separato.
