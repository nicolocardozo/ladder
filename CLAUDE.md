# Ladder

Workspace desktop per macOS in cui si lavora su più repository insieme con agenti di codice (Claude, Codex, agenti ACP). Sito pubblico su itsladder.dev.

## Parti

| Cartella | Cosa | Istruzioni |
|---|---|---|
| `app/desktop` | App Electron | `app/desktop/CLAUDE.md` |
| `website` | Sito Next.js | `website/CLAUDE.md` |
| `brand` | Temi e logo, fonte per app e sito | app: cambia `brand/themes.json`, poi `pnpm --filter @ladder/desktop sync-brand`; sito: va aggiornato a mano (vedi `website/CLAUDE.md`) |
| `app/spikes` | Prove tecniche, non in produzione | solo lettura |

Le istruzioni di una parte si caricano quando si legge un file di quella cartella. Prima di verificare o rivedere una modifica, leggi il CLAUDE.md della parte toccata.

L'app mobile (`app/mobile`, Expo) e il relay Cloudflare (`app/relay`) della milestone M6 sono in sviluppo sui branch `m6/*`, con i worktree in `.claude/worktrees/m6-*`, e non sono ancora in `development`. Quando entrano, ognuna avrà la sua riga qui e il suo CLAUDE.md. Prototipo: `docs/m6-mobile-prototype.html`.

## Comandi

```bash
pnpm install
pnpm --filter @ladder/desktop typecheck
pnpm --filter @ladder/desktop build
pnpm --filter @ladder/website build
```

## Documenti

- `app/PRODUCT.md`: utenti, scopo, regole di prodotto (catalogo agenti, download, accesso). Leggilo prima di cambiare un comportamento.
- `app/DESIGN.md`: sistema visivo dell'app. Leggilo prima di toccare l'interfaccia.
- `website/BRIEF.md`: decisioni del sito.
- `app/docs/backlog.md`, `app/docs/piano.html`: piano e fasi.
- `docs/`: note di lavoro (strategia di rilascio, richieste ad Anthropic).

## Agenti di progetto

`ui` (renderer), `host` (main e host), `web` (sito), `linear` (backlog). Verifica, revisione e ricerca le fanno `verifier`, `reviewer` e `researcher` del livello personale, leggendo questi file.

## Git

- Si lavora sul branch `development`. Commit e push solo quando l'utente lo chiede.
- Allineare `main`, solo su richiesta esplicita perché pubblica il sito in produzione: `git push origin development:main` e `git branch -f main development` (il secondo fallisce se `main` è aperto in un worktree).
- Messaggi di commit, titoli e descrizioni delle PR in inglese: titolo all'imperativo, breve, senza punto finale (es. `Add auto-updates from ladder-releases`); se serve, un corpo con elenco puntato di cosa cambia e perché.
- Altre sessioni lavorano spesso nella stessa cartella. Prima di una modifica su più file guarda `git status` per modifiche non tue; se un'altra sessione `ladder-*` è attiva sugli stessi file, chiedi e usa un worktree separato (`../ladder-<nome>`).

## Linear

Workspace "Ladder", team LAD, progetto P-LAD-1, tramite l'agente `linear`.
- "Sviluppa F5" vuol dire tutte le issue della milestone, in ordine, fino alla fine, non solo la prima.
- A fine issue: stato Done e un commento "Come testarla" in italiano, con passi concreti nell'app, cosa aspettarsi e casi limite. Done solo dopo l'ok dell'utente, se non l'ha già dato nella richiesta. Il testo del commento lo scrive chi delega e lo passa già pronto all'agente `linear`.
