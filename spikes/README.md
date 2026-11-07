# Spike della fase 0

Prototipi da riga di comando che verificano le ipotesi tecniche del piano (`docs/piano.html`, sezione 4.10).
Ogni cartella è un pacchetto npm autonomo, fuori dal workspace pnpm, con versioni fissate e un README con risultati e conclusioni.

| Cartella | Verifica |
|---|---|
| `claude-sdk/` | S2 · Agent SDK: streaming, approvazioni, domande, interruzione, ripresa |
| `codex-app-server/` | S1 · Codex App Server: ciclo completo con login ChatGPT |
| `acp/` | S5 · client ACP generico con un agente reale |
| `terminal-hooks/` | S6 · stato delle sessioni terminale tramite hook |
| `git-checkpoint/` | S4 · checkpoint con indice temporaneo |

Gli script sono in TypeScript e girano con `node` (Node 24 rimuove i tipi da solo): niente enum, namespace o altra sintassi non cancellabile.
I repository di prova vengono creati in cartelle temporanee: nessuno spike tocca i progetti reali.
