---
name: Ladder
description: Workspace desktop per macOS per lavorare su più repository con agenti di codice.
colors:
  circuit-canvas: "#181424"
  circuit-sidebar: "#1A1427"
  circuit-surface: "#211A30"
  circuit-ink: "#F7F4FF"
  circuit-ink-muted: "#A9A6B2"
  circuit-hairline: "#4A4357"
  circuit-control-border: "#6C6777"
  iris-signal: "#AC97FF"
  iris-brand: "#5525CF"
  deep-violet: "#22123C"
  citron-running: "#ECFC7F"
  amber-waiting: "#FDBB69"
  mint-success: "#8CE9B7"
  rose-error: "#FDA4AE"
  circuit-selection: "#362D50"
typography:
  display:
    fontFamily: "Mona Sans Variable, -apple-system, sans-serif"
    fontSize: 26px
    fontWeight: 600
    lineHeight: 32px
    letterSpacing: -0.02em
  headline:
    fontFamily: "Mona Sans Variable, -apple-system, sans-serif"
    fontSize: 21px
    fontWeight: 600
    lineHeight: 28px
    letterSpacing: -0.015em
  title:
    fontFamily: "Mona Sans Variable, -apple-system, sans-serif"
    fontSize: 17px
    fontWeight: 600
    lineHeight: 24px
    letterSpacing: -0.01em
  body:
    fontFamily: "Mona Sans Variable, -apple-system, sans-serif"
    fontSize: 15px
    fontWeight: 400
    lineHeight: 24px
  label:
    fontFamily: "Mona Sans Variable, -apple-system, sans-serif"
    fontSize: 13px
    fontWeight: 500
    lineHeight: 18px
  caption:
    fontFamily: "Mona Sans Variable, -apple-system, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
  code:
    fontFamily: "Monaspace Neon, ui-monospace, SF Mono, monospace"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 20px
rounded:
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
spacing:
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "5": 20px
  "6": 24px
  "8": 32px
components:
  button-primary:
    backgroundColor: "{colors.iris-signal}"
    textColor: "{colors.circuit-canvas}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: 32px
    padding: 0 12px
  button-secondary:
    backgroundColor: "{colors.circuit-surface}"
    textColor: "{colors.circuit-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: 32px
    padding: 0 12px
  chip:
    backgroundColor: "{colors.circuit-surface}"
    textColor: "{colors.circuit-ink-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: 28px
    padding: 0 8px
  composer:
    backgroundColor: "{colors.circuit-surface}"
    textColor: "{colors.circuit-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.xl}"
    padding: 12px 16px
  session-row:
    textColor: "{colors.circuit-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 6px 8px
  request-card:
    backgroundColor: "{colors.circuit-surface}"
    textColor: "{colors.circuit-ink}"
    rounded: "{rounded.lg}"
    padding: 14px 16px
---

# Design System: Ladder

## 1. Overview

**Creative North Star: "La sala di controllo silenziosa"**

Ladder è una stanza in cui si tengono d'occhio più lavori insieme senza che niente alzi la voce. Si vede a colpo d'occhio chi sta lavorando, con quale agente e modello, e chi aspetta te; il resto sta un passo indietro. La conversazione con l'agente è il contenuto: larga, leggibile, con molta aria. Navigazione, barre e pannelli sono più piccoli, più tenui e più densi.

L'aspetto viene dalla finestra agenti di Cursor: fondo scuro, poche azioni in alto, superfici che si distinguono per tono e non per linee. La precisione viene dalla tipografia: una famiglia sola, una scala corta, pesi che fanno la gerarchia. L'identità Circuit resta nei dettagli: iris per il focus e le scelte, citron solo per il lavoro in corso, ambra solo per ciò che ti blocca.

Non deve sembrare: l'interfaccia affollata di agmux, il SaaS da dashboard con card identiche e numeri giganti, la prima versione di Ladder con dodici dimensioni di testo, maiuscoletti spaziati e bordi ovunque.

**Key Characteristics:**
- Una famiglia sans (Mona Sans) in quattro pesi e una monospaziata gemella (Monaspace Neon) per codice, diff e terminale.
- Sei passi di testo, il più piccolo a 12 px.
- Superfici a toni, linee sottili solo dove separano zone di lavoro.
- Lo stato si legge senza aprire: forma, etichetta e icona del provider con il modello.

## 2. Colors

Strategia **Restrained**: neutri tinti verso il viola di Circuit e un accento sotto il 10% della superficie. I dodici temi cambiano i valori, non i ruoli. I valori qui sotto sono quelli di Circuit, il tema iniziale; la fonte di verità resta `brand/themes.json`.

### Primary
- **Iris segnale** (#AC97FF): focus, selezione attiva, pulsante principale, punto delle risposte da leggere. Mai decorativo.
- **Iris marchio** (#5525CF) e **Viola profondo** (#22123C): solo l'icona dell'app nel Dock. Nell'interfaccia il logo prende l'accento del tema (Iris segnale in Circuit).

### Neutral
- **Tela Circuit** (#181424): fondo della conversazione.
- **Sidebar Circuit** (#1A1427): secondo strato neutro per sidebar e barre.
- **Superficie Circuit** (#211A30): card, composer, menu, ispettore.
- **Inchiostro** (#F7F4FF) e **Inchiostro tenue** (#A9A6B2): testo principale e secondario.
- **Filo** (#4A4357): linee di separazione, usate di rado.

### Named Rules
**La regola dei tre segnali.** Citron significa "in corso", ambra significa "ti aspetta", rosa significa "errore". Nessun altro uso, e sempre insieme a una forma e a un'etichetta.

**La regola del filo.** Una linea solo dove separa due zone di lavoro (sidebar, conversazione, ispettore, terminale). Dentro una zona si separa con lo spazio e il tono.

## 3. Typography

**Sans:** Mona Sans Variable (GitHub, OFL), con il carattere di sistema come riserva.
**Mono:** Monaspace Neon (GitHub Next, OFL), disegnata per stare con Mona Sans.

**Character:** neo-grotesca nitida, leggermente tecnica, calma ai corpi piccoli. La monospaziata ha la stessa altezza x e lo stesso tono, così codice e testo convivono senza attrito.

### Hierarchy
- **Display** (600, 26/32, -0.02em): titolo della nuova chat e degli stati vuoti. Raro.
- **Headline** (600, 21/28, -0.015em): titolo delle sezioni delle impostazioni e dei dialoghi.
- **Title** (600, 17/24, -0.01em): titolo della sessione, intestazioni dei pannelli.
- **Body** (400, 15/24): testo della conversazione e del composer, misura massima 68ch.
- **Label** (500 o 400, 13/18): tutta l'interfaccia: righe della sidebar, tab, pulsanti, menu, ispettore.
- **Caption** (400, 12/16): metadati, età, scorciatoie, badge, seconde righe.
- **Code** (400, 12/20): codice, diff, comandi, terminale.

### Named Rules
**La regola dei sei passi.** Ogni testo usa uno dei sei passi della scala, che in Tailwind sono `text-xs` (caption, 12), `text-sm` (label, 13), `text-base` (body, 15), `text-lg` (title, 17), `text-xl` (headline, 21) e `text-2xl` (display, 26), definiti in `globals.css`. Il codice usa `font-mono` con `text-xs`. Niente dimensioni scritte a mano, niente sotto i 12 px.

**La regola del maiuscolo.** Niente maiuscoletti spaziati. Le etichette di sezione sono in frase, 12 px, peso 600, tono tenue.

## 4. Elevation

Piatto per default, a toni: sidebar, tela e superfici si distinguono per luminosità. Le ombre esistono solo per ciò che galleggia sopra il lavoro (menu, popover, dialoghi, palette), e sono ampie e morbide, mai dure.

### Shadow Vocabulary
- **Galleggiante** (`0 1px 2px rgb(0 0 0 / .2), 0 12px 32px rgb(0 0 0 / .32)` sui temi scuri, opacità dimezzate sui chiari): menu, popover, dialoghi.

### Named Rules
**La regola del piatto.** Una superficie a riposo non ha ombra. L'ombra dice "questo sta sopra e se ne andrà".

## 5. Components

### Buttons
- **Forma:** raggio 6 px, altezza 32 px (28 px nelle barre e nelle card compatte), testo 13 px peso 500.
- **Primario:** fondo iris, testo scuro. Uno per vista al massimo.
- **Secondario:** fondo superficie, filo di 1 px del colore dei controlli; hover un tono più chiaro.
- **Fantasma:** senza fondo né bordo, testo tenue; hover con fondo di selezione leggero. Per le azioni nelle barre.
- **Scorciatoia:** il tasto sta dentro il pulsante in 12 px, tono tenue.

### Chips
Contesto della nuova chat (progetto, branch, cartella, agente) e scelte del composer: 28 px, raggio 6 px, 13 px, icona da 14 px, nessun bordo a riposo.

### Cards / Containers
- **Card della richiesta:** superficie, raggio 12 px, filo ambra al 45%, intestazione con icona e nome della richiesta in ambra, in frase. Nessuna barra laterale.
- **Card dei file modificati:** superficie, raggio 10 px, righe da 32 px.
- Mai card dentro card.

### Inputs / Fields
- **Composer:** superficie, raggio 16 px, filo tenue che diventa iris al 50% col focus; testo 15 px; barra dei controlli in basso con chip da 28 px.
- **Campi:** 32 px, raggio 6 px, filo dei controlli, focus con anello iris da 2 px.

### Navigation
- **Sidebar:** 264 px. Righe di sessione su due livelli: titolo (13 px) ed età a destra; sotto, icona del provider, modello e attività o branch (12 px tenue). Lo stato a sinistra in uno slot da 16 px. Selezione con fondo di selezione, raggio 8 px.
- **Barra in alto:** 44 px, solo tab e poche icone; le tab mostrano icona del provider e titolo, e lo stato quando non è a riposo.

### Agent Mark (Signature Component)
Icona del provider monocromatica (Claude Code, Codex, icona dell'agente ACP dal registro, altrimenti iniziale) in 12–16 px, sempre accanto al nome del modello quando c'è spazio. Dice chi lavora senza aprire la sessione: sidebar, tab, intestazione, "In attesa", ⌘K, menu degli agenti, composer.

### Agent Map
Chip "N agents" (28 px, fantasma) sopra il composer, allineato a destra, solo quando la sessione ha avviato sotto-agenti; l'anello citron dice che qualcuno lavora ancora. Apre un popover con un albero: in cima la sessione principale con il suo segno, sotto i sotto-agenti, ogni livello rientrato con un filo verticale da 1 px. Ogni riga: stato in uno slot da 16 px (anello, spunta menta, croce rosa, quadrato tenue), compito in 13 px, durata in 12 px a destra in cifre tabulari; sotto, in 12 px tenue, l'attività corrente e poi tipo, modello, token e strumenti. Nella sidebar basta il conteggio: "2 agents" in fondo alla seconda riga.

## 6. Do's and Don'ts

### Do:
- **Do** usare solo i sei passi della scala e il passo del codice.
- **Do** separare con lo spazio e il tono prima che con una linea.
- **Do** mostrare provider e modello ovunque compaia una sessione.
- **Do** dare a ogni stato forma ed etichetta oltre al colore.
- **Do** tenere la conversazione entro 68ch, con molta aria intorno.

### Don't:
- **Don't** scrivere dimensioni di testo a mano o sotto i 12 px.
- **Don't** usare maiuscoletti spaziati per le etichette.
- **Don't** usare barre laterali colorate su card e righe: si usa un filo intero, un fondo tinto o un'icona.
- **Don't** usare citron, ambra o rosa fuori dai loro tre significati.
- **Don't** mettere card dentro card o ombre su superfici a riposo.
- **Don't** ripetere il titolo della sessione in due barre diverse.
