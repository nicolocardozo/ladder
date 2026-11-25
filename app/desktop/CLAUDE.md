# App desktop

Electron per macOS (electron-vite, TypeScript, node:sqlite), pacchetto `@ladder/desktop`. I comandi qui sotto si lanciano dalla radice del repo con `pnpm --filter @ladder/desktop …`, salvo dove è scritto "da `app/desktop`".

## Struttura

```
src/main/      processo main: finestre, menu, aggiornamenti, notifiche
src/host/      lavoro con gli agenti: Claude (Agent SDK), Codex (app-server), ACP, login e limiti, SQLite, git e worktree, file, terminale
src/preload/   ponte tra main e renderer
src/renderer/  interfaccia: React 19, Tailwind 4, shadcn su Base UI, stato in zustand (src/renderer/src/store/app-store.ts)
src/shared/    contratto host-renderer (protocol.ts), i18n, cataloghi italiani (locales/it)
scripts/       postinstall, brand, rilascio
```

Il contratto tra host e renderer è `src/shared/protocol.ts`: cambia solo quando serve davvero, e host e renderer lo usano allo stesso modo.

## Regole

- Le variabili `ANTHROPIC_*` e `CLAUDE*` ereditate non passano mai ai processi figli: l'ambiente parte sempre da `cleanEnv()` (`src/shared/env.ts`). Ladder poi aggiunge di proposito le sue, per esempio `CLAUDE_CONFIG_DIR` in `claudeEnv` (`src/host/claude/environment.ts`) per i profili non predefiniti. Il terminale ha un filtro suo, più ampio (`src/host/terminals.ts`).
- Mai leggere, stampare, loggare o copiare credenziali, token o contenuti del Portachiavi.
- Testi per l'utente in inglese dentro `t('…')` (l'inglese è la lingua di partenza), con la voce nel catalogo italiano in `src/shared/locales/it`. La chiave è il testo inglese esatto: se cambi il testo inglese, cambia anche la chiave, o la traduzione sparisce senza errori. Un file di catalogo nuovo va registrato in `locales/it/index.ts`.
- Niente trattini lunghi nei testi.
- Interfaccia: prima leggi `app/DESIGN.md` e riusa i componenti in `src/renderer/src/components` (`ui/`, `composer/`, `chat/`). Colori a token, elementi raggiungibili da tastiera, `aria-label` sui bottoni a icona, focus visibile.
- API degli agenti: la fonte prima sono i tipi installati in `node_modules` (`@anthropic-ai/claude-agent-sdk/*.d.ts` alla versione fissata in `package.json`, lo schema dell'app-server di Codex). Gli adapter dipendono da campi che cambiano tra versioni; il web viene dopo.
- Casi limite da tenere presenti, in sviluppo e in revisione: agente non disponibile, richieste concorrenti, sessione chiusa a metà, listener o processi che restano vivi.
- Commenti brevi in inglese (il repo diventa pubblico): spiegano il perché o un comportamento non ovvio, senza riferimenti a issue Linear o fasi. Il codice più vecchio ha ancora commenti in italiano, in traduzione.

## Verifica

1. `pnpm --filter @ladder/desktop typecheck`.
2. `pnpm --filter @ladder/desktop build` se la modifica tocca host o main.
3. Modifiche visibili: anteprima `ladder-web` (in `.claude/launch.json` alla radice del repo, porta 5199, pagina `/preview.html`). Se la 5199 è già occupata da un vite di questo progetto, usa quello e non riavviarlo. L'anteprima non avvia l'host: i dati vengono dalle fixture in `src/renderer/src/dev/fixtures.ts` e dalle anteprime in `src/renderer/src/dev/`. Parametri utili: `?lang=it` per le traduzioni, `?view=connections|agents|terminals|new` per le altre viste. Per uno stato particolare, dalla console: `const { useApp } = await import('/src/store/app-store.ts'); useApp.setState({...})` (percorso relativo alla radice di vite, `src/renderer`).
4. Prova l'interazione chiesta, tastiera compresa; console senza errori; tema chiaro e scuro se cambiano i colori. Uno screenshot dello stato finale.
5. Ciò che passa dall'host (agenti veri, login, git, terminale) non si vede nell'anteprima: si prova nell'app di sviluppo con un profilo di prova, `LADDER_USER_DATA=<cartella> LADDER_WORKTREES=<cartella> pnpm --filter @ladder/desktop dev`. Il main non si ricarica a caldo: dopo modifiche a host o main si riavvia.
6. Nel resoconto, cosa non hai potuto verificare e perché.

## Rilascio

Solo su richiesta dell'utente.
1. Versione in `app/desktop/package.json`, commit.
2. L'utente lancia `pnpm --filter @ladder/desktop release:mac`: build, firma e notarizzazione per arm64 e x64. `--arch=arm64|x64` e `--dmg-only` servono solo a rifare una build fallita: per pubblicare servono entrambe le architetture.
3. Da `app/desktop`: `node scripts/publish-release.mjs` pubblica DMG, zip e `latest-mac.yml` su `nicolocardozo/ladder-releases`.
4. Tag `vX.Y.Z` sul repo, push.
5. Controlla `/download/apple-silicon` e `/download/intel` sul sito (dimensione del file).
