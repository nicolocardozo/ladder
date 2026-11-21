# Spike S4 · Checkpoint git con indice temporaneo

Domanda: Blue può fotografare lo stato di una cartella (file tracciati e non tracciati) prima e dopo ogni turno, per avere diff per turno e ripristini, senza toccare indice, working tree e branch dell’utente?

## Come si esegue

```bash
node run.ts                      # repo sintetici
node run.ts <repo> [<repo> …]    # anche tempi su cloni locali di repo reali (l'originale non viene toccato)
```

Risultati in `results/run.json`.

## Come funziona

`checkpoint.ts`:

1. copia l’indice dell’utente in un file temporaneo (`GIT_INDEX_FILE`), così git riusa le informazioni di stat;
2. `git add -A` sull’indice temporaneo: entrano anche i file non tracciati, restano fuori quelli ignorati;
3. `write-tree` e `commit-tree` con HEAD come genitore, identità “Blue”;
4. `update-ref refs/blue/<sessione>/<etichetta>`: il commit non sta su nessun branch.

Il ripristino salva prima lo stato attuale in un checkpoint di sicurezza, poi scrive i file del checkpoint con un indice temporaneo e toglie quelli nati dopo.

## Risultati (7/11/2026, MacBook arm64)

| Verifica | Esito |
|---|---|
| Indice, stato, stage, HEAD, branch e working tree dell’utente invariati | ✅ |
| File non tracciati inclusi, file ignorati esclusi | ✅ |
| Il ref privato non compare tra i branch | ✅ |
| Diff tra due checkpoint = solo le modifiche del turno (anche cancellazioni) | ✅ |
| Ripristino esatto, indice invariato, stato precedente salvato | ✅ |
| Pulizia dei ref di una sessione | ✅ |

| Tempi per checkpoint | read-tree | copia dell’indice |
|---|---|---|
| Sintetico, 5.000 file | 425 ms | 80 ms |
| acme-monorepo, 1.675 file | 265 ms | 72 ms |
| acme-vet, 2.701 file | 380 ms | 77 ms |

## Conclusioni per Blue

- Usare sempre la copia dell’indice: è 4–5 volte più veloce e resta sotto i 100 ms sui tuoi repo. Si può fare a ogni inizio e fine turno senza che si noti.
- In un worktree `rev-parse --absolute-git-dir` restituisce la cartella git del worktree, con il suo indice: lo stesso codice funziona.
- I commit di checkpoint restano raggiungibili finché esiste il ref. Quando una sessione si archivia, Blue cancella `refs/blue/<sessione>/*`; il normale `git gc` libera poi lo spazio.
- Da gestire in fase 2: file non tracciati molto grandi (un limite di dimensione oltre il quale il file viene escluso e segnalato) e repo senza commit iniziale (oggi `HEAD` è obbligatorio).
- I cloni usati per i tempi non contengono `node_modules` né build: nei repo reali sono ignorati, e git non entra nelle cartelle ignorate, quindi i tempi non dovrebbero cambiare molto. Da rimisurare dentro l’app.
