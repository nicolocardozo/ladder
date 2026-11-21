# Product

## Register

product

## Users

Una persona sola, per ora: lo sviluppatore che lo costruisce e lo usa ogni giorno su un Mac da 13–14″ (finestra di riferimento 1440 × 900), con più repository aperti insieme. Lavora per ore con agenti di codice (Claude Code, Codex, agenti ACP) e passa spesso da un progetto all'altro. Il lavoro è a ondate: scrive una richiesta, l'agente lavora, intanto un altro agente in un altro progetto chiede un'approvazione. Usa tastiera e scorciatoie più del mouse. Dopo un periodo di prova personale Ladder potrebbe diventare open source per persone con lo stesso modo di lavorare.

## Product Purpose

Ladder è un workspace desktop per macOS in cui lavori su più repository insieme con agenti di codice: chat con l'agente al centro, file e diff a portata, terminale quando serve, e uno sguardo unico su chi ti sta aspettando in quale progetto. È "un'agmux migliore" nell'esperienza e nell'interfaccia.

Successo: in qualunque momento capisci a colpo d'occhio cosa sta succedendo in ogni progetto (chi lavora, con quale agente e modello, chi aspetta te) e intervieni in una o due azioni senza perdere il filo di quello che stavi scrivendo.

## Catalogo degli agenti

Oltre a Claude Code e Codex, Ladder parla con gli agenti del registro ACP, da Impostazioni → Agenti. Il catalogo mostra prima gli agenti più usati e dice cosa succederà: CLI già sul Mac, pacchetto che parte con npx o uvx al primo uso, oppure binario da scaricare.

- **Niente scaricamenti a sorpresa.** Un binario si scarica solo dopo una conferma che mostra nome, versione, host di provenienza, dimensione (in KiB, MiB o GiB, le unità dei limiti) e checksum (sha256 completo, copiabile). La conferma non esiste senza un checksum noto. Il checksum si verifica prima di poter avviare l'agente e Ladder manda all'host versione, checksum e host che l'utente ha visto: se il registro nel frattempo cambia uno dei tre (anche dopo il dialog: l'host risponde `checksum-changed`), il download si ferma, Ladder rilegge il catalogo e la conferma si riapre con i dati nuovi, mai con quelli vecchi; se la voce non è più confermabile, la riga dice perché. Per le release GitHub l'host mostrato è `github.com/proprietario/repository`, e quello esatto viaggia con il comando. Ladder non aggiorna mai un agente da sola: l'aggiornamento è un'altra conferma, identica alla prima.
- **Senza checksum, non si scarica, e Ladder non ne inventa.** Non usa checksum dichiarati dal vendor fuori dal registro. Le voci senza un checksum verificabile restano non disponibili, con il motivo scritto e il link alla procedura del vendor ("Install from the official site"), come una release senza digest. Se il checksum non si riesce a leggere ora, la voce dice "Checksum not available now" con "Try again" che rilegge il catalogo, senza link e senza download. Se un agente scaricato ha un aggiornamento ma il suo checksum non si legge ora, la riga lo dice ("Update to v… is available, but the checksum is not available now") con "Try again". Se la CLI è già sul Mac si aggiunge lo stesso.
- **Host fissati.** Ladder scarica solo dall'indirizzo atteso per quell'agente. Un indirizzo diverso, un archivio troppo grande o una versione già scaricata che si ripresenta con un checksum diverso non si scaricano: il motivo è scritto in chiaro e il conflitto di checksum è un avviso visibile. Un errore di installazione non sparisce in silenzio: resta visibile con "Try again" (anche un redirect verso un host non ammesso o un checksum momentaneamente assente) finché l'utente non rilegge a mano con Rescan o il registro non pubblica una versione nuova; allora la riga torna "Download and add"; firma, team, quarantena e conflitto restano finché il registro non pubblica un'altra versione.
- **La firma si mostra dopo l'installazione.** La conferma precede il download, quindi la firma del programma (firmato da chi, firma integra ma firmatario non verificato, ad hoc o non firmato) si legge a fine installazione e resta nella riga dell'agente. Ladder descrive lo stato e non dice mai che un programma è "sicuro". Per gli agenti curati con uno sviluppatore fissato in Ladder (OpenCode, Kiro, Junie) un download non firmato, firmato ad hoc o da un altro sviluppatore non si installa: Ladder dice che non è firmato dallo sviluppatore che si aspetta (senza dire che la firma "non regge", che è un'altra cosa) e non offre "Try again". Una firma che non regge blocca l'installazione; se macOS mette il file in quarantena, Ladder lo spiega e non toglie la quarantena.
- **L'accesso non passa mai da Ladder.** Se un agente chiede di accedere, Ladder mostra i metodi che l'agente dichiara e, per quelli che l'agente gestisce da sé, un bottone che glielo chiede. Non vede né salva credenziali. Per i metodi da terminale scrive solo di accedere dal terminale con il comando dell'agente, senza inventarlo; per quelli che Ladder non sa fare dice che non sono supportati, senza bottone. "Stop waiting" ferma davvero l'accesso: lo stato torna a richiesto subito e un nuovo "Sign in" funziona.
- **Primo avvio.** Sotto i collegamenti compare "Other agents found on your Mac" con le CLI già installate, da aggiungere con un clic. "Hide" le nasconde solo per la sessione: non è una scelta che Ladder ricorda.

## Brand Personality

Preciso, calmo, essenziale. L'interfaccia sparisce dietro il lavoro: poco rumore, gerarchia netta, la conversazione in primo piano. La sicurezza viene dalla cura dei dettagli, non dalla decorazione. L'identità è Circuit (iris, viola profondo, citron usato con parsimonia per il lavoro in corso), ma il colore accompagna e non domina.

Riferimento principale: la finestra agenti di Cursor (struttura scura ed essenziale, molta aria intorno alla conversazione). Riferimenti secondari: la chat di Codex per la leggibilità, Linear per la nitidezza della tipografia piccola e le superfici con pochi bordi, Raycast per la rifinitura macOS.

## Anti-references

- L'interfaccia di agmux: molte modalità sovrapposte, superfici affollate, stati affidati solo al colore.
- L'aspetto "economico e datato" della prima versione di Ladder: una dozzina di dimensioni di testo diverse e tutte piccole, etichette in maiuscoletto spaziato, bordi e linee ovunque, barre in alto affollate, titoli ripetuti.
- Il SaaS generico da dashboard: card identiche in griglia, numeri giganti con gradiente, glassmorphism.
- Pannelli modali come prima risposta: prima l'inline e il progressivo.

## Design Principles

1. **Il lavoro al centro.** La conversazione e il codice sono il contenuto; navigazione, barre e pannelli stanno un passo indietro per peso, colore e densità.
2. **Lo stato si legge senza aprire.** Chi lavora, con quale agente e modello, chi aspetta te: visibile da sidebar, tab e "In attesa", sempre con forma ed etichetta oltre al colore.
3. **Una sola grammatica.** Stessi pulsanti, chip, menu, card e stati in ogni vista; una scala tipografica corta e spazi su una griglia, così l'insieme sembra pensato e non accumulato.
4. **Calma che si guadagna.** Meno linee e più spazio, meno colore e più gerarchia di peso; il colore forte solo per ciò che ti blocca o va storto.
5. **Tastiera prima.** Ogni azione frequente ha una scorciatoia visibile e il focus va sempre dove serve.

## Accessibility & Inclusion

- Contrasto WCAG AA su tutti i temi: 4,5:1 per il testo, 3:1 per bordi dei controlli, focus e indicatori (verificato da `app/desktop/scripts/check-contrast.mjs`).
- Nessun testo sotto i 12 px.
- Ogni stato distinguibile in scala di grigi (forma, icona, etichetta), anche nei temi Mono.
- Movimento ridotto rispettato: animazioni brevi e sostituite da stati statici con `prefers-reduced-motion`.
- Navigazione completa da tastiera, focus sempre visibile.
