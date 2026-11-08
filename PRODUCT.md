# Product

## Register

product

## Users

Una persona sola, per ora: lo sviluppatore che lo costruisce e lo usa ogni giorno su un Mac da 13–14″ (finestra di riferimento 1440 × 900), con più repository aperti insieme. Lavora per ore con agenti di codice (Claude Code, Codex, agenti ACP) e passa spesso da un progetto all'altro. Il lavoro è a ondate: scrive una richiesta, l'agente lavora, intanto un altro agente in un altro progetto chiede un'approvazione. Usa tastiera e scorciatoie più del mouse. Dopo un periodo di prova personale Ladder potrebbe diventare open source per persone con lo stesso modo di lavorare.

## Product Purpose

Ladder è un workspace desktop per macOS in cui lavori su più repository insieme con agenti di codice: chat con l'agente al centro, file e diff a portata, terminale quando serve, e uno sguardo unico su chi ti sta aspettando in quale progetto. È "un'agmux migliore" nell'esperienza e nell'interfaccia.

Successo: in qualunque momento capisci a colpo d'occhio cosa sta succedendo in ogni progetto (chi lavora, con quale agente e modello, chi aspetta te) e intervieni in una o due azioni senza perdere il filo di quello che stavi scrivendo.

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

- Contrasto WCAG AA su tutti i dodici temi: 4,5:1 per il testo, 3:1 per bordi dei controlli, focus e indicatori (verificato da `apps/desktop/scripts/check-contrast.mjs`).
- Nessun testo sotto i 12 px.
- Ogni stato distinguibile in scala di grigi (forma, icona, etichetta), anche nei temi Mono.
- Movimento ridotto rispettato: animazioni brevi e sostituite da stati statici con `prefers-reduced-motion`.
- Navigazione completa da tastiera, focus sempre visibile.
