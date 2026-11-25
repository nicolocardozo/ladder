@AGENTS.md

# Sito

Sito pubblico di Ladder su itsladder.dev: Next.js (App Router, TypeScript), shadcn/ui, Tailwind 4, pacchetto `@ladder/website`. Pubblicato su Vercel da `main`. Pagine: `/`, `/agents`, `/changelog`, `/docs`, `/privacy`.

## Regole

- Le decisioni stanno in `BRIEF.md`; i prototipi in `prototype/` mostrano struttura, testi e animazioni già approvati. Nelle revisioni si segnalano i difetti rispetto al brief, non si propongono redesign.
- Colori Circuit copiati a mano in `src/app/globals.css` e tracciati del logo in `src/components/brand/logo-paths.ts`: `sync-brand` aggiorna solo l'app, quindi se cambia `brand/themes.json` o il logo vanno aggiornati qui a mano. Icone degli agenti da `@lobehub/icons-static-svg`.
- Server component di default; `"use client"` solo per le parti animate o interattive, caricate con `next/dynamic` se non servono al primo paint.
- Componenti React Bits solo quando il brief li nomina, con colori e densità del brand.
- Ogni animazione rispetta `prefers-reduced-motion` con uno stato statico leggibile.
- SEO: metadata per ogni pagina, testi reali nel markup, un solo h1, niente layout shift.
- Testi del sito in inglese, commenti nel codice in italiano.
- I download (`/download`, `/download/apple-silicon`, `/download/intel`) sono redirect in `next.config.ts` verso le release di `nicolocardozo/ladder-releases`.

## Verifica

1. `pnpm --filter @ladder/website build` senza errori. Gli avvisi di Next su Cache Components non sono errori.
2. Anteprima `ladder-website` (in `.claude/launch.json` alla radice del repo, porta 3100).
3. Screenshot a 1440×900 e 375×812 (preset mobile, poi ricarica) delle pagine toccate; se non sai cosa è cambiato, la home. Per le animazioni legate allo scroll, uno screenshot all'inizio e uno alla fine.
4. Console senza errori; nessuno scroll orizzontale: `[document.documentElement.scrollWidth, window.innerWidth]` devono essere uguali.
5. Con movimento ridotto la sezione resta leggibile.
6. Chiudi l'anteprima che hai aperto.
