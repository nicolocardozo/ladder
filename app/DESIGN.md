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

Strategia **Restrained**: neutri tinti verso il viola di Circuit e un accento sotto il 10% della superficie. I temi cambiano i valori, non i ruoli. I valori qui sotto sono quelli di Circuit, il tema iniziale; la fonte di verità resta `brand/themes.json`.

### Primary
- **Iris segnale** (#AC97FF): focus, selezione attiva, pulsante principale, punto delle risposte da leggere. Mai decorativo.
- **Iris marchio** (#5525CF) e **Viola profondo** (#22123C): solo l'icona dell'app nel Dock. Nell'interfaccia il logo prende l'accento del tema (Iris segnale in Circuit), tranne quello inciso degli stati vuoti, che resta tono su tono.

### Neutral
- **Tela Circuit** (#181424): fondo della conversazione.
- **Sidebar Circuit** (#1A1427): secondo strato neutro per sidebar e barre.
- **Superficie Circuit** (#211A30): card, composer, menu, ispettore.
- **Inchiostro** (#F7F4FF) e **Inchiostro tenue** (#A9A6B2): testo principale e secondario.
- **Filo** (#4A4357): linee di separazione, usate di rado.

### Named Rules
**La regola del codice.** Nei temi Mono l'interfaccia resta in bianco e nero, ma codice, diff e terminale hanno colori propri (blocco `syntax` di `brand/themes.json`).

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
- **Body** (400, 15/24): testo del composer e dei testi lunghi. Nella conversazione la dimensione dipende dal font della chat: 15/24 con le sans (predefinito), 14/23 con le monospaziate.
- **Label** (500 o 400, 13/18): tutta l'interfaccia: righe della sidebar, tab, pulsanti, menu, ispettore.
- **Caption** (400, 12/16): metadati, età, scorciatoie, badge, seconde righe.
- **Code** (400, 12/20): codice, diff, comandi, terminale.

### Named Rules
**La regola del font della chat.** Solo la conversazione (`.chat-md` e la bolla dell'utente) usa `--font-chat`, scelto in Impostazioni → Aspetto e riflesso da `prefs.chatFont` su `<html data-chat-font>`: sans di sistema (predefinito, SF Pro su macOS, 15/24), monospazio di sistema (14/23), Mona Sans (15/24) o Monaspace Neon (14/23). I blocchi di codice restano `font-mono` 12 px e si distinguono dallo sfondo. Il resto dell'app non cambia. È l'unica eccezione alla regola dei sei passi: i 14 px della chat monospazio (scelta facoltativa) non sono un passo della scala e vengono da `--chat-size`. Nella vista compatta solo i messaggi intermedi stanno a 13 px; risposte finali e bolla utente restano a `--chat-size`. Il report nel dialogo dei sotto-agenti è markdown della chat e segue lo stesso font.

**La regola della larghezza della chat.** Il testo (risposte, bolla dell'utente, passaggi) sta in una colonna centrata il cui limite è in pixel: 820 px (Comoda, predefinita), 1100 px (Ampia) o tutta la vista (Piena), da Impostazioni → Aspetto e `prefs.chatWidth` su `<html data-chat-width>` (`--chat-measure`). La zona che scorre è un container (`container-type: inline-size`) e la colonna è `min(spazio utile, limite)`, con margini di 24 px (12 px in vista compatta): vale uguale per una colonna stretta, un monitor normale, un ultrawide e per due colonne affiancate, senza breakpoint. I blocchi larghi (blocchi di codice, tabelle, output degli strumenti, card dei comandi da approvare) usano `.chat-wide`: con Comoda escono dalla colonna fino a `min(1100px, spazio utile)`, centrati sul testo; con Ampia (1100 px) coincidono con il testo, e non causano mai scroll orizzontale; con Piena riempiono la colonna. Dentro liste e citazioni non escono. Le tabelle piccole restano larghe quanto la colonna di testo, centrate; le grandi crescono fino al blocco largo. L'output degli strumenti dentro i passaggi (`.chat-wide-sym`) sta con 21 px di rientro per lato nella colonna e, quando esce, è centrato sul testo. La zona che scorre riserva sempre il gutter della barra (`scrollbar-gutter: stable`) e composer e note aggiungono lo stesso spazio a destra, così restano sull'asse del testo. Il composer e le note sopra di lui usano la stessa colonna (`.chat-measure.chat-bleed`), poco più larga del testo di 16 px per lato (meno nelle viste strette): il testo scritto nel composer (padding 16 px) cade sullo stesso filo della chat. La bolla dell'utente sta all'82% della colonna e non supera 100 ch del font della chat. Il font dell'app torna nei figli con `.chat-reset`: il font della chat serve solo a misurare i `ch` (bolla dell'utente). La stima d'altezza delle righe (`chatColumn` in `chat/turns.ts`) ricava i caratteri per riga dalla stessa colonna in pixel e dalle metriche del font, quindi cambia con larghezza della vista, impostazione e font.

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
- **Card dei file modificati:** chiusa per default è una sola riga d'intestazione da 22 px (freccia, conteggio e +/−, come la riga per agente), con "Review" come bottone separato a destra. L'elenco dei file compare solo da aperto, con superficie e raggio 10 px, righe da circa 26 px.
- Mai card dentro card.

### Inputs / Fields
- **Composer:** superficie, raggio 16 px, filo tenue che diventa iris al 50% col focus; testo 15 px; barra dei controlli in basso con chip da 28 px.
- **Campi:** 32 px, raggio 6 px, filo dei controlli, focus con anello iris da 2 px.

### Navigation
- **Sidebar:** 264 px. Si apre un progetto alla volta, quello selezionato (fondo tenue e peso 500); gli altri mostrano solo i badge. Sotto stanno le sessioni vive, da leggere o con una bozza e le ultime 5 ferme, poi la riga "All sessions · N", che al passaggio apre una seconda sidebar da 320 px sopra la chat (un clic la tiene aperta). I gruppi creati da te stanno sopra la lista, un livello più a destra. Senza simbolo di stato il titolo parte dal bordo; i titoli lunghi scorrono al passaggio. Righe di sessione su due livelli: titolo (13 px) ed età a destra; sotto, icona del provider, modello e attività o branch (12 px tenue). Lo stato a sinistra in uno slot da 16 px. Selezione con fondo di selezione, raggio 8 px.
- **Account:** in fondo alla sidebar, a sinistra dell'ingranaggio: iniziale in un cerchio neutro da 28 px, email (13 px) e piani degli agenti (12 px tenue). Apre Impostazioni → Abbonamenti.
- **Barra in alto:** 44 px: a sinistra `progetto / branch`, poi le tab e poche azioni, con il pulsante "Files"; le tab mostrano icona del provider e titolo, e lo stato quando non è a riposo.

### Primo avvio
Una sola schermata centrata, larga al massimo 560 px, con il logo (simbolo e nome, 56 px di altezza, a sinistra e nell'accento del tema) sopra il titolo in 24 px peso 600 e una frase tenue in 14 px. Sotto, le righe dei collegamenti; in fondo la nota "puoi farlo dopo" in 12 px tenue e un solo pulsante: "Skip for now" fantasma, che diventa primario (iris) con "Continue" quando almeno un agente è collegato. La stessa lista sta in Impostazioni → Abbonamenti.

### Righe dei collegamenti
Lista con filo di 1 px e raggio 8 px, una riga per servizio (Claude, ChatGPT / Codex, GitHub), spaziatura 16 px in orizzontale e 14 px in verticale. A sinistra il segno del servizio; al centro nome (14 px, peso 500), eventuale piano in un chip con filo e lo stato in 12 px con icona da 12 px: "Connected" in menta, "Signing in…" tenue con anello che gira, "Problem" in rosa con avviso, "Not signed in" tenue con cerchio tratteggiato. Sotto, in 12 px tenue, account o scopo; gli errori in rosa con ruolo alert, tranne un annullamento voluto, che resta tenue. A destra bottoni piccoli (28 px): "Sign in" secondario (e "Try again" dopo un errore), "Cancel" durante l'accesso, "Switch account" e "Sign out" fantasmi quando è collegato. I bottoni restano disattivi finché l'host non risponde e il focus passa all'azione principale che subentra. "Switch account" chiede sempre conferma; "Sign out" solo per Claude, il cui accesso è condiviso con Claude Code. La conferma è un riquadro tenue dentro la riga (raggio 6 px, testo 12 px): il focus va su "Cancel", Esc chiude solo la conferma e riporta il focus al bottone che l'ha aperta. Durante lo scaricamento dello strumento una barra da 4 px, a pillola, nel colore `running` del tema (lo stesso "in corso" degli agenti; citron solo in Circuit), con byte e percentuale in cifre tabulari sotto; se la dimensione è ignota la barra pulsa a due quinti. Iris resta riservato a focus, selezione e pulsante principale.

### Catalogo degli agenti
In Impostazioni → Agenti, sotto "I tuoi agenti": "Most used" (curati) e "More from the ACP registry" dietro una ricerca, in liste con filo di 1 px e raggio 8 px come le righe dei collegamenti. Ogni riga ha segno, nome (14 px, peso 500), descrizione in 12 px tenue e una riga di origine ("Binary from {host} · v{version}", "Starts with npx on first use"). A destra un solo bottone piccolo (28 px): "Add" per CLI rilevate e pacchetti npx/uvx, "Download and add" per i binari, "Update" quando c'è una versione nuova e il download è noto, "Cancel" durante lo scaricamento, "Try again" dopo un errore. Mai un download senza conferma: il riquadro tenue dentro la riga (raggio 6 px, 12 px) mostra nome, versione, host di provenienza e da dove viene il checksum (registro ACP o release GitHub), poi "Download and add" e "Cancel". Il focus va su "Cancel", Esc chiude solo il riquadro e riporta il focus al bottone che l'ha aperto. Le voci il cui download non ha un checksum verificabile restano non disponibili, senza bottone, con il motivo in 12 px tenue: Ladder non le scarica. Se l'host non dà i dati di download, "Update" non compare. Quando un agente viene tolto da "I tuoi agenti" la riga torna "Add" subito. Le barre di avanzamento sono quelle dei collegamenti.

**Sicurezza e accesso (LAD-56).** Il riquadro di conferma (stesso riquadro tenue, raggio 6 px, 12 px) ha una tabella a due colonne: versione, host di provenienza, dimensione ("Unknown" se ignota; unità binarie KiB, MiB, GiB, come i limiti; si sale d'unità quando il valore arrotondato arriva a 1024, quindi 1048575 byte sono "1 MiB") e checksum SHA-256 con la sua origine. Il riquadro si offre solo con checksum noto e nessun blocco: mai una riga "checksum ignoto". Il checksum si legge abbreviato (primi 8 e ultimi 8 caratteri) con "Show full checksum" che lo apre a gruppi di 8 e un "Copy checksum" (il nome accessibile è il testo, l'esito "Checksum copied" si annuncia a parte) che copia sempre l'intero. Con checksum non noto, o `checksum-unavailable`, la nota tenue dice "Checksum not available now" con "Try again" (bottone `outline` piccolo) che rilegge il catalogo e nessun link al sito. Se l'host rifiuta perché versione, checksum o host sono cambiati, l'errore resta nella riga e la conferma si riapre da sola con i dati nuovi e una nota in colore attenzione; vale anche per l'errore `checksum-changed` (promessa rifiutata o evento), per cui la riga dice "The download changed after you checked it" e "Try again" riapre la conferma solo dopo la rilettura (disabilitato finché legge), mai con lo sha vecchio. Se la rilettura la rende non confermabile, resta solo la nota di blocco giusta. Un errore di installazione non resta in eterno, ma lo supera solo l'utente o una versione nuova: la rilettura lo toglie se riguarda un'altra versione del registro (sempre), o se ha un codice non definitivo (`no-checksum` per un 404 momentaneo, `host` per un redirect) e la voce non ha blocchi, ma in questo secondo caso solo dopo una lettura MANUALE (Rescan, "Try again" di una nota). La rilettura nata dal rifiuto stesso, o da un altro evento, non lo toglie mai: il catalogo controlla solo l'URL del registro e non vede ciò che l'host ha visto al download, quindi un redirect verso un host non ammesso o un checksum momentaneo rifiutato da start() restano visibili con la nota e "Try again". Il codice dell'errore arriva con l'evento `agent.install`, che parte prima del rifiuto: la promessa rifiutata porta solo il messaggio e non sovrascrive l'evento. Il testo grezzo dell'errore (riga rossa senza codice) non si mostra mentre la conferma riaperta o la nota di blocco sono visibili, né durante la rilettura che segue un rifiuto: niente lampeggio e niente testo ripetuto accanto alla conferma. Firma, team, quarantena, troppo grande e `checksum-conflict` sono definitivi: restano finché la versione del registro è la stessa. Un `checksum-conflict` (promessa rifiutata o evento: stesso stato) è un avviso in colore attenzione, senza "Try again" e senza riaprire la conferma. Una conferma che si riapre da sola sposta il focus su Cancel solo se era già nella riga; se la riga è appena comparsa (ricerca che la mostra, gruppo che si apre) il focus resta dov'è, per esempio sul campo di ricerca mentre si scrive, e la conferma si annuncia con un `role="status"` ("A confirmation for … is open. Check the details before you confirm."). Le conferme da riaprire stanno in una mappa per agente (due rifiuti vicini non si cancellano); per una riga nel gruppo "More from the ACP registry" chiuso il gruppo si apre, così la riga si monta e riapre subito la conferma. Una conferma aperta che cambia sotto gli occhi mostra la stessa nota in colore attenzione. L'host si mostra com'è: `github.com/proprietario/repository` per GitHub. Con un aggiornamento disponibile ma checksum non leggibile ora, sotto la riga c'è una nota tenue ("Update to v… is available, but the checksum is not available now") con "Try again". La barra di avanzamento di un agente scrive i byte in KiB, MiB, GiB come la conferma; quella dei collegamenti resta in MB. Le voci che Ladder non scarica mostrano sotto la descrizione una nota tenue (riquadro `bg-muted`, raggio 6 px, 12 px) con titolo in peso 500, la spiegazione e "Open the install guide" (link con icona, aperto con `openExternal` solo se https), senza bottone di download; un conflitto di checksum è invece un avviso (bordo e icona in colore attenzione, annunciato come alert). Se la CLI è già rilevata resta "Add". La firma sta nella riga dell'agente installato e a fine installazione, in 12 px tenue con icona: "Signed by …", "Signature intact, signer not verified" (senza nome, stessa icona dell'ad hoc), "Ad hoc signature, signer unknown", "Not signed", mai parole come "safe" o "trusted"; un errore di firma, di team o di quarantena è la stessa nota, annunciata, e non offre "Try again". `team` (curato con sviluppatore fissato, download non firmato, ad hoc o di un altro team) ha testo e titolo suoi ("Not signed by the developer Ladder expects"), mai "la firma non regge", che è solo di `signature`; il team atteso non si mostra perché il contratto non lo porta. L'accesso di un agente già aggiunto che lo chiede è un riquadro tenue sotto la riga: un bottone piccolo per ogni metodo di tipo agent ("Sign in", poi "Try again" dopo un errore), che resta al suo posto con `aria-disabled` mentre si aspetta (stato annunciato), per i metodi da terminale un testo senza bottone e per quelli non supportati nome, "Ladder does not support this sign-in method." e la descrizione, senza bottone. "Stop waiting" invia l'annullamento all'host e lo stato resta "required", pronto per un nuovo "Sign in". Un'ultima riga in 12 px debole ricorda che Ladder non vede le credenziali.

### Altri agenti trovati sul tuo Mac
Nel primo avvio, sotto le righe dei collegamenti e a distanza di 24 px: sezione "Other agents found on your Mac" con titolo in 12 px peso 600 tenue e "Hide" fantasma a destra. Elenca solo CLI già installate e rilevate, ognuna con "Add". "Hide" la nasconde solo per la sessione in corso: al prossimo avvio ricompare se c'è ancora qualcosa da aggiungere.

### Agent Mark (Signature Component)
Icona del provider monocromatica (Claude Code, Codex, icona dell'agente ACP dal registro, altrimenti iniziale) in 12–16 px, sempre accanto al nome del modello quando c'è spazio. Dice chi lavora senza aprire la sessione: sidebar, tab, intestazione, "In attesa", ⌘K, menu degli agenti, composer.

### Logo inciso
Negli stati vuoti delle chat il logo è solo simbolo, centrato e grande (112 px di altezza), scavato nella superficie: riempimento appena più scuro del fondo, ombra interna in alto, filo chiaro di 1 px sotto. Tre valori derivati da `--background` (`.ladder-engraved` in `globals.css`), così vale per ogni tema. Decorativo: nascosto alle tecnologie assistive.

### File nelle tab
Un file modificabile è una tab accanto alle chat: icona, nome e un punto al posto della × finché ci sono modifiche non salvate. L'editor usa il passo Code (12/20) e i colori del codice del tema. Sopra il testo una barra da 32 px con il percorso, "Save" solo quando serve e l'apertura in Cursor; gli avvisi (agente al lavoro, file cambiato su disco) stanno in una riga sotto, mai in un dialogo. Il dialogo c'è solo per chiudere con modifiche non salvate.

### Effort
Nel menu del modello: etichetta con il livello tra parentesi e un cursore a pillola da 100 px con una tacca per ogni livello che il modello accetta. La parte piena è nell'accento, il cursore nel colore del testo. Si clicca, si trascina o si usano le frecce sinistra e destra.

### Badge Default
Marca il modello (nel menu del composer) e il livello di effort con cui parte una sessione che non li ha scelti: componente `default-badge.tsx`, 16 px di altezza, raggio 4 px, 12 px tenue su fondo `foreground/10`, a destra del nome. Il tooltip dice la fonte: "Default from Ladder settings (project)" o "(all projects)", oppure "Default of Claude Code". Senza scelta, il composer mostra il modello e il livello effettivi (predefinito di Ladder, poi dell'agente), mai "Default model" se il nome è noto; "Reset to default" in fondo alla sezione toglie la scelta esplicita. Nelle impostazioni, dove c'è "Inherit", si vede il nome effettivo.

### Scorciatoie e badge
Le scorciatoie usano un solo componente (`ui/kbd.tsx`): un tasto per simbolo, 18 px, carattere di sistema, fondo leggero nel colore del testo. Il conteggio delle richieste è una pillola ambra chiara con icona e numero; quello da leggere è un punto iris con il numero accanto. Niente punti esclamativi.

### Coda dei messaggi
Sopra il composer, un'intestazione in 12 px tenue con l'icona dell'orologio: "Sends when the turn ends" (peso 500) e dopo il punto mediano il motivo, per esempio "3 agents working". A sessione ferma dice invece "Waiting · send a message to continue", perché i messaggi non partono da soli. Ogni riga è tratteggiata, con il testo che si modifica con un clic; a destra "Send into turn" (solo se l'agente lo permette) e "Send now" come bottoni di testo da 20 px in 12 px tenue, poi la ×. "Send now" ferma il turno: lo dice il suggerimento, nessuna conferma.

Limiti d'uso del piano (`composer/usage-button.tsx`, `composer/usage-banner.tsx`): nessun tetto di sessioni attive, solo avvisi vicino ai limiti. Con una finestra del profilo in uso a 80% o più, `limited`, o `warning` quando la percentuale manca (l'uso extra, senza reset, non conta), l'icona dell'uso diventa un triangolo di avviso (forma diversa, non solo colore: ambra, rosso a limite esaurito) con aria-label che dice la finestra, e il popover si apre con una riga tenue (12 px, fondo `attention/10` o `destructive/10`) che dice quale finestra è vicina al limite e quando si azzera, in ora locale. Sotto soglia l'icona resta quella del grafico e non c'è riga. Il bannerino sopra il composer compare solo da 95% o a limite esaurito, anche in vista compatta: riga da 12 px, raggio 8 px, filo e fondo `attention` (o `destructive`), con il nome del profilo se l'agente ne ha più d'uno e la × da 20 px. Chiuso, resta chiuso finché la finestra non si azzera (localStorage per agente, profilo, finestra e reset al minuto; condiviso fra le colonne; senza reset vale solo in memoria). Icona e bannerino si spengono da soli al reset. In chat non si duplica niente: Claude manda già la sua nota. **Pannello dei limiti (LAD-82).** Il popover (w-80, intestazione fissa e lista che scorre fino a `min(60vh, 440px)` con la barra minimale di sempre) si chiama "Plan limits": sotto il titolo, in 12 px tenue, "Updated … ago" del dato più vecchio fra gli abbonamenti mostrati (o "Updating…", o "Update failed · …"), e a destra il bottone da 24 px "Refresh all usage" che rilegge tutti in parallelo (`agents.usage` per ogni agente e profilo nativo; all'apertura solo quelli più vecchi di 60 secondi o mai letti). Il bottone resta al suo posto mentre legge (`aria-disabled`, `aria-busy`, icona che gira) e l'esito si annuncia in una regione `role="status"` nascosta. La lista ha un abbonamento per voce (`li` con intestazione `h3`): logo dell'agente (14 px), nome "piano · profilo" (il profilo solo se l'agente ne ha più d'uno) come bottone che apre Impostazioni → Subscriptions sulla sua riga (con `focusConnection(…, { highlight: true })`: la riga scorre in vista, prende il focus e si evidenzia per 1,8 secondi con `bg-accent/60`; il nome non è un bottone per gli agenti ACP, che dicono "Usage isn't available for this agent."), "N sessions in use" in 12 px tenue quando ce n'è almeno una (stesso agente e profilo, sessioni `running`, `starting` o `waiting` più quelle ferme con sotto-agenti ancora al lavoro, perché consumano lo stesso piano; `sessionsInUse` in `lib/usage-accounts.ts`), poi le finestre con `UsageRow` compatto. L'account della sessione aperta sta per primo, poi Claude e Codex nell'ordine delle Impostazioni, un profilo dopo l'altro. Un abbonamento vicino al limite (stessa soglia di `usageAlert`) ha il triangolo di avviso accanto al nome (ambra, rosso a limite esaurito, con aria-label che dice la finestra); la frase tenue sotto l'intestazione, l'icona nel composer e il bannerino restano solo per l'account della sessione aperta. Un abbonamento senza dati dice "No usage data yet…" con un bottone da 24 px che rilegge solo lui; "Update failed" compare solo se la richiesta fallisce, e una lettura vuota non si ripete a ogni apertura prima di 60 secondi. L'account della sessione aperta c'è sempre, anche se il suo profilo è stato rimosso. In Impostazioni → Subscriptions il blocco dei limiti di ogni profilo è sempre aperto (non a scomparsa) e mostra le finestre del piano (5 ore e settimanale, non quelle per modello) con le stesse sessioni in uso e lo stesso segno d'avviso sopra di esse.

### Messaggio inserito nel turno
Un messaggio dell'utente entrato nel turno in corso porta sotto il testo, allineata a destra, la riga "Sent into the turn": 12 px tenue con una freccia che rientra a capo (12 px). Nei turni riassunti resta visibile dopo il riepilogo. L'output dell'agente non si perde mai: se arriva quando non c'è un turno aperto (per esempio un sotto-agente in background che finisce a sessione ferma), Ladder apre un turno per mostrarlo, che conta come gli altri.

### Invio durante un turno
Il tasto di invio fa ciò che dice l'impostazione (inserisce nel turno o accoda); con ⌥ (Alt) in più fa l'altra azione, e da fermo ⌥ non ha effetto. Il pulsante e il segnaposto dicono "Send into turn" o "Queue" secondo ciò che accade davvero, e il suggerimento mostra entrambe le combinazioni con `Kbd`.

### Agent Map
Badge nella barra in basso del composer, a destra dello spazio flessibile e prima dell'indicatore del contesto, solo quando la sessione ha avviato sotto-agenti: 28 px, raggio 6 px, 12 px tenue, nessun bordo a riposo. In corso: anello citron e "N running"; nessuno in corso: icona grigia e "N agents"; con errori si aggiunge un punto rosa da 6 px. Nelle colonne strette resta il solo numero. Apre un popover largo al massimo 34 rem: in cima "Agents" e il riepilogo; oltre 15 agenti, sotto una riga con ricerca e due filtri (tipo, stato) da 28 px. La lista è virtualizzata (`@tanstack/react-virtual`, righe a altezza fissa) e ordinata in sezioni: in corso, poi con errori o fermati, poi i completati in un gruppo chiuso "86 completed". I figli stanno sotto il genitore, rientrati di 14 px, con un chevron per comprimerli; un figlio in corso tiene il genitore fra gli agenti in corso. Con un filtro attivo la lista è piatta. Riga da 44 px: stato in uno slot da 16 px, compito in 13 px e durata a destra in cifre tabulari; sotto, in 12 px tenue, tipo, modello (se non noto quello della sessione con "inherited"), effort e "background", e a destra i token. Frecce su e giù spostano il focus fra le righe; un clic apre il dialogo e chiude il popover. Nella sidebar basta il conteggio: "2 agents" in fondo alla seconda riga.

Fine dei sotto-agenti in background (`agentsNotice`): la sessione ferma ha uno stato proprio, nella sidebar, in "All sessions", nell'inbox tra le risposte da leggere e nei tab. Agenti finiti: punto iris dell'"unread" e nota "Subagents finished" in tenue. Con errori: triangolo rosso e nota "1 subagent failed" in rosso, nessun ambra (l'ambra resta per ciò che ti blocca). Si azzera aprendo la sessione o guardandola con la finestra in primo piano. In chat il turno aperto dall'agente, senza messaggio dell'utente, inizia con una riga di sistema (icona bot da 14 px e "Started by the agent after background agents finished", 14 px tenue, come le righe dei comandi).

### Grafico dei sotto-agenti (LAD-81)
Il popover dell'Agent Map ha due viste, "Graph" e "List", scelte da un selettore a due segmenti nell'intestazione (fondo `muted`, segmenti da 20 px, raggio 6 px, 12 px; quello attivo ha il fondo di selezione, `aria-pressed`). La scelta resta in `localStorage` (`ladder.agentMapView`). Senza scelta il grafico è la vista fino a 12 agenti e la lista oltre; la vista e il limite dei 40 si decidono una volta all'apertura del popover e non cambiano sotto il cursore (se gli agenti superano 40 a popover aperto resta il grafico fino alla prossima apertura). Oltre 40 agenti il grafico non si propone: il segmento "Graph" resta ma spento (`aria-disabled`, tenue, tooltip "The graph is available up to 40 agents. Use the list.") e la vista è la lista, che ha ricerca e filtri come prima. Nella vista a grafico un bottone "Expand" da 24 px con icona da 14 px sta a destra del selettore.

Il grafico ha la sessione in cima ("This session" con il conteggio) e un nodo per agente sui livelli sotto, i figli sotto il genitore. Ogni livello è una sola riga, mai a capo: se il grafico è più largo del popover scorre in orizzontale (barra minimale dell'app) e il nodo che prende il focus da tastiera viene portato in vista. Il layout è calcolato a mano (`lib/agent-graph.ts`, nessuna libreria): larghezza di ogni nodo misurata sul titolo con il font vero (da 124 a 188 px, il titolo si tronca), i fratelli centrati sotto il genitore. Il nodo è una pillola da 44 px alta, raggio 8 px, fondo `muted` al 60% e filo di 1 px (`ring`): in corso filo citron, con errore filo rosa, gli altri neutri. Riga alta: segno di stato in uno slot da 16 px (anello che gira, spunta menta, croce rosa, quadrato tenue come nella lista), compito in 13 px, durata a destra in cifre tabulari; sotto, in 12 px tenue, il tipo. Al passaggio del mouse e al focus un tooltip mostra titolo intero, tipo, modello, token, strumenti e, se in corso, l'attività. I collegamenti sono curve di Bézier da 1,5 px dal bordo basso del genitore a quello alto del figlio, colorate per stato in colore pieno, senza trasparenza (con l'opacità il verde scendeva a 2,4:1 sul fondo dei temi chiari, pieno resta sopra 4,8:1): citron pieno in corso, menta pieno completato, rosa a puntini corti con errore, grigio a tratti lunghi se fermato; i collegamenti vanno solo fra livelli adiacenti e non attraversano mai un nodo; il colore non è mai l'unico segnale, restano il segno di stato e il tratto. Con tema chiaro e scuro i colori vengono dai token (`running`, `success`, `destructive`, `muted-foreground`).

Tastiera e accessibilità: `role="tree"` e `role="treeitem"` con `aria-level`, `aria-posinset`, `aria-setsize` e un nome che dice titolo, tipo, stato e durata; niente `aria-expanded`, non c'è nulla da espandere. Le frecce sono spaziali, non quelle di un albero classico, perché è un grafico, e lo dice l'`aria-description` del tree. Un solo punto di tabulazione; frecce su e giù vanno a genitore e primo figlio, sinistra e destra ai fratelli, Home e End al primo e all'ultimo; Invio o clic apre il dialogo di dettaglio (con ↑↓ per passare agli altri agenti), che chiude il popover. La lista resta l'alternativa completa.

"Expand" apre un dialogo quasi a tutto schermo (la finestra meno 24 px per lato): intestazione con "Agent graph", il riepilogo e a destra i bottoni da 28 px "Zoom out", la percentuale, "Zoom in", "Fit to view" e "Close"; sotto, l'area del grafico e un piè da 36 px con i comandi. Rotella o due dita spostano la vista; lo zoom (da 30% a 250%, attorno al puntatore) va con il pinch del trackpad (rotella con ctrl), ctrl o ⌘ e rotella e i bottoni, così il trackpad non zooma per sbaglio; i tasti `+`, `-` e `0` fanno lo stesso; trascinamento con il puntatore (si cattura solo oltre 4 px, così un clic su un nodo resta un clic). All'apertura il grafico è inquadrato per intero (mai oltre 100%); se per starci la scala scenderebbe sotto il 60% si ferma al 60%, centrato sulla sessione, e il resto si raggiunge spostando la vista e con le frecce il nodo che prende il focus viene portato in vista. La vista non esce mai del tutto dal riquadro, con qualunque gesto (trascinamento, rotella, pinch, pulsanti, tasti): resta in vista almeno una parte (80 px) del grafico e almeno un nodo; se non succede, la vista torna verso il centro. La percentuale si annuncia solo dopo un clic sui pulsanti di zoom. Con più di 40 agenti il dialogo non disegna il grafico ma rimanda alla lista; senza agenti dice "No agents yet". Il riquadro non scorre da solo: la vista è il transform, scritto direttamente senza rifare il render dei nodi. Esc chiude e il focus torna al badge; aprendo il dettaglio di un agente il dialogo si chiude e il focus passa al dettaglio.

### Sessione in attesa degli agenti
Coordinatore fermo e sotto-agenti ancora in corso (`run` idle, `subagentCounts.running > 0`): non è "da leggere" e non ti aspetta. In sidebar, tab e "All sessions" il simbolo è il bot da 12 px nel colore `running` (forma propria, nessun anello che gira) e la nota è "Waiting for N agents"; vale più dell'avviso degli agenti già finiti e della risposta da leggere, finché qualcuno lavora. In chat, sotto l'ultimo turno, una riga da 22 px con lo spinner discreto e "Waiting for N background agents" (`role="status"`, 14 px tenue). Sparisce da sola quando gli agenti finiscono o parte un turno.

### Fine degli agenti con il coordinatore fermo
Riga `agents-finished` in fondo al turno, mai dentro il riepilogo. "waiting": bot da 14 px, "N background agents finished" (con "· N failed" in rosa), a destra "Continue" (secondario, 28 px, spento mentre la richiesta è in volo, errore in rosa sotto) e sotto, in 12 px tenue, che l'agente non è ripartito da solo. "continued": freccia che rientra e "Continued". "resumed": "The agent picked up after N background agents finished", nascosta se esiste già la riga "Started by the agent" del turno aperto dall'agente. "dismissed": non si vede.

### Turno fermo senza chiedere
Con `stallHint` attivo, la fine di un turno senza modifiche, comandi, agenti né domande ha una riga tenue con l'icona pausa (14 px): "Stopped without asking anything · Tell it to keep going", e il pulsante di testo "Write “Continue”" (12 px, iris) che mette "Continue" (tradotto nella lingua dell'interfaccia) nel composer senza inviarlo.

### Dettaglio del sotto-agente
Dialogo largo 680 px, alto al massimo l'82% della finestra, senza padding proprio (le zone ne hanno uno loro) e con un piè da 36 px separato da un filo: intestazione con stato, titolo (17 px, peso 600, due righe al massimo) e sotto, in 12 px tenue, stato, tipo e "background"; a destra i bottoni da 28 px "Previous agent", "Next agent" e "Close". Il corpo scorre da solo: griglia di dati (modello, effort, token, strumenti, durata) con etichette in 12 px tenue, poi attività corrente, prompt in un riquadro tenue di 176 px al massimo, report con il markdown della chat in versione compatta, elenco degli strumenti usati in righe da 24 px. Etichette di sezione in frase, 12 px, peso 600. Mentre l'agente lavora il dettaglio si ricarica al più una volta ogni 900 ms. Freccia su e giù passano all'agente precedente o successivo nell'ordine del popover, ma solo se il focus non è su un'area scorrevole (corpo, prompt, elenco degli strumenti): lì scorrono; con ⌥ cambiano agente da qualunque punto. Il piè ricorda `↑↓`, `⌥↑↓` e la posizione. Esc chiude e il focus torna dove era (badge o riga in chat). Per i turni vecchi, senza dati dell'agente, il dialogo parte da titolo e stato della riga di chat e completa con ciò che risponde l'host.

### Riga del sotto-agente in chat
Una sola riga da 22 px come le altre righe degli strumenti: icona del bot, "titolo · tipo · modello" (tipo e modello in tono sfumato), durata in monospazio e stato (anello, spunta, croce). Niente prompt e report espansi: un clic apre il dialogo di dettaglio. Il legame con l'agente è il `toolId` o l'id uguale a quello della riga; senza `SubagentInfo` (turni vecchi) la riga usa il suo stato e il dialogo chiede il dettaglio con l'id della riga.

### Barra di scorrimento
Una sola, in `globals.css`, per tutta l'app: binario trasparente, pollice arrotondato di 6 px (bordo trasparente da 2 px e `background-clip: padding-box`) nel colore del testo al 16%, 32% al passaggio e 44% al trascinamento, quindi uguale in chiaro e scuro. Si usa solo `::-webkit-scrollbar`: da Chromium 121 `scrollbar-width` e `scrollbar-color` la disattivano, perciò nessun'altra regola le imposta. Per nascondere la barra c'è la classe `no-scrollbar`; la ScrollArea della sidebar disegna la sua e nasconde quella nativa.

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
