# Blue

Workspace desktop per macOS in cui lavori su più repository insieme, con Claude Code, Codex e altri agenti di sviluppo in chat o in terminale.

Il piano di prodotto e architettura è in [`docs/piano-blue.html`](docs/piano-blue.html).

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
pnpm --filter @blue/desktop dev:web
```

Se Electron non parte perché manca il binario, lo scarica lo script `postinstall` dell’app; in alternativa:

```bash
node apps/desktop/node_modules/electron/install.js
```

## Stato

Fase 0: scaffold dell’app e prototipi tecnici. La finestra mostra sidebar ad albero, nuova chat e composer con dati d’esempio; le sessioni vere arrivano nella fase 1.
