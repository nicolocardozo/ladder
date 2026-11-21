# Sito di Ladder: brief

Fonte unica per chi sviluppa il sito. Gli agenti leggono questo file invece di farsi ripetere le decisioni.

## Riferimenti

- Prototipi in `prototype/`: `v2.html` (sezioni a schede 4+1, frase centrale) e `v3.html` (hero a riquadro, schede a tamburo). I file `*-src.html` sono i sorgenti; `python3 build.py v3-src.html v3.html` inserisce logo e icone da `brand/` e `app/desktop/node_modules`.
- Ispirazioni: hero e ritmo di [rbp-shader-template](https://rbp-shader-template.vercel.app/), sezione prodotto di [rbp-genai-template](https://rbp-genai-template.vercel.app/#product), nav di [Efferd hero-4](https://efferd.com/view/hero-4). Animazioni e componenti di quei siti vengono da React Bits.
- Brand: `brand/themes.json` (tema Circuit), `brand/logo/svg/`, icone degli agenti da `@lobehub/icons-static-svg`. UI reale dell'app: `app/desktop/src/renderer`, `app/DESIGN.md`.

## Principi

- Pagina bianca. Il colore forte sta nella finestra di Ladder in tema Circuit (viola scuro), che crea contrasto.
- Le animazioni raccontano cose che Ladder fa davvero: agenti al lavoro, richieste che aspettano, approvazioni, worktree, limiti del piano. Niente effetti decorativi senza significato.
- Niente etichette di sezione tipo "01 / 02 · The problem", niente sottolineature decorative.
- `prefers-reduced-motion`: ogni animazione ha uno stato statico leggibile.
- Testi in inglese.

## Sezioni, in ordine

### 1. Hero
- Riquadro a tutta larghezza con margine, **raggio 0**, fondo chiaro a puntini (Dot Grid di React Bits o equivalente); i puntini vicino al cursore si accendono.
- Header sopra il riquadro: **logo senza sfondo a sinistra**, **nav compatta a destra** nello stile della nav della v2 (bianca sfocata, bordo sottile, link in frase, Download scuro).
- Stato iniziale: claim grande a sinistra, sottotitolo piccolo in basso a sinistra, download in basso a destra, invito a scorrere.
- Allo scroll il claim si rimpicciolisce e si sposta in alto **su due righe**: "Every agent, every repo," / "one calm window." (seconda riga in iris). La finestra di Ladder sale dal basso, dritta e grande.
- La finestra **non deve apparire con la chat vuota**: quando arriva c'è già una conversazione in corso (richiesta, letture, sotto-agenti), poi la demo prosegue (richiesta di approvazione da un altro progetto, notifica, ⏎, fine lavoro).
- Finestra: ricostruzione fedele della UI reale (sidebar con New chat, Waiting, progetti e sessioni; tab con icona dell'agente; composer con uso, agente, permessi).

### 2. Frase sul problema
- Come nella v2: frase grande, testo al centro della pagina; le parole si accendono allo scroll, l'ultima frase in iris.
- **Sotto la frase**: [Ghost Fibers di React Bits](https://reactbits.dev/backgrounds/ghost-fibers), su fondo bianco, in un colore che non litighi con la parte viola del testo (grigio ardesia o neutro freddo). Verificare se è un componente Pro e la licenza.

### 3. Funzioni: le 5 schede della v2
- Griglia 2×2 + una scheda larga sotto, come nella v2: Waiting, sotto-agenti, worktree, limiti del piano, catalogo agenti con sha256. Ogni scheda ha una mini-schermata Circuit animata.
- Il tamburo a tre livelli della v3 (stile GenAI) è da decidere: non sostituisce queste schede.

### 4. Agenti supportati
- Come il riferimento fornito ("Works with your tools"): titolo, sottotitolo, tabella a 3 colonne di celle con icona e nome dell'agente, ultima cella "+N more" con freccia. Su fondo bianco, bordi sottili.
- Agenti: Claude Code, Codex, Gemini CLI, OpenCode, Goose, Qwen Code, Amp, Cline, Kimi CLI e "+N more" dal registro ACP.

### 5. Chiusura e footer
- Riquadro con claim e download, **raggio 0**, **colori invertiti**: fondo viola scuro (Circuit) con i puntini, testo chiaro.
- **Solo il logo di Ladder**, senza il riquadro tipo icona di app.
- Footer semplice sotto.

## Stack
- **Next.js** (App Router, TypeScript), **shadcn/ui**, **Tailwind 4**. Pacchetto `@ladder/website` nel workspace pnpm (`website/`).
- Pagine renderizzate sul server o statiche (SSG); le parti animate sono client component isolati, così l'HTML arriva completo ai motori di ricerca.
- Componenti React Bits installati come sorgenti nel progetto (registro shadcn), adattati al brand.
- Font con `next/font` (Mona Sans, Monaspace Neon o JetBrains Mono), immagini con `next/image`.

## SEO
- Metadata API di Next per titolo, descrizione, canonical, Open Graph e Twitter card; immagine OG generata con `next/og`.
- `sitemap.ts`, `robots.ts`, `manifest.ts`, favicon dal simbolo del logo.
- JSON-LD `SoftwareApplication` (macOS, categoria DeveloperApplication, prezzo) e `Organization`.
- Un solo `h1`, gerarchia dei titoli pulita, testi reali nel markup (le demo animate non sostituiscono il testo).
- Core Web Vitals: hero leggero al primo caricamento, animazioni caricate dopo (`next/dynamic`), niente layout shift, canvas solo quando visibili.
- Pagine da prevedere oltre alla home: changelog, docs, agenti supportati, privacy. Ognuna con metadata propri.

## Domande aperte
- Dominio, link di download (release firmata) e GitHub pubblico o no.
- Tamburo a tre livelli: dove usarlo, se usarlo.
- Deploy: Vercel è la scelta naturale con Next.js.
