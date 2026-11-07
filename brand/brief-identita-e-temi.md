# Prompt per Claude Code — identità e temi di Ladder

Lavora nel repository di Ladder, il workspace desktop macOS in cui passo rapidamente tra progetti attivi e gestisco sessioni grafiche con Claude Code e Codex, anche coordinate nello stesso task. Integra l’identità e il sistema di temi nel codice esistente. Leggi prima la struttura del progetto e riusa le sue convenzioni. Se il progetto è ancora in pianificazione, restituisci un piano concreto che rispetti questo brief.

## Identità fissa del prodotto

**Ladder** è il nome del prodotto. **Circuit** è la direzione del brand e il tema iniziale. Usa iris **#5525CF** per il marchio principale su fondo chiaro, viola profondo **#22123C** per la tile dell’icona e superfici di marca, citron **#ECFC7F** per un accento operativo mirato, avorio lavanda **#F7F4FF** per il testo chiaro del brand e bianco **#FFFFFF** per il marchio nell’icona fornita. Usa il citron con parsimonia, per esempio per uno stato in corso o un dettaglio di marca. Mantieni Circuit come identità dell’app, dell’icona macOS e delle superfici di marca anche quando cambia il tema del workspace.

Il logo definitivo è l’ultima variante approvata con tre barre angolari e separate, attacchi leggermente sfalsati a sinistra, riga superiore che termina poco prima della centrale e terza barra corta con taglio a 45°. Usa direttamente gli SVG e i file icona allegati. Il wordmark negli SVG è in tracciati. Per il marchio in UI usa le versioni con contrasto appropriato e il simbolo a piccole dimensioni. Le dieci tavole sono riferimenti per i colori e il tono.

Per l’interfaccia usa una sans sobria e leggibile, privilegiando il font di sistema su macOS, e una monospace per codice e diff. Mantieni una chat grafica, una sidebar dei progetti, stati riconoscibili tra progetti e un composer che si adatta a Claude Code, Codex o alla sessione orchestrata. Prendi agmux come riferimento funzionale e la chat Codex come riferimento di leggibilità. Per le approvazioni usa superfici neutre e, se serve, una barretta interna verticale e dritta. Distingui lettura, richiesta di intervento e lavoro in corso anche con testo o icone. [agmux](https://www.agmux.dev/)

## Temi disponibili

Usa tutti e dodici i temi. Le prime tre colonne cromatiche riportano i colori delle tavole, con valori campionati e normalizzati per l’uso nel prodotto. Le colonne UI sono le basi operative. L’accento UI può differire dal colore campionato per garantire leggibilità.

| Tema | Aspetto | Palette (primario / secondario / accento) | Sfondo | Superficie | Sidebar | Testo | Accento UI |
|---|---|---|---|---|---|---|---|
| Night Shift | Scuro | `#0D1623` / `#2C9EFE` / `#BCC2CC` | `#101822` | `#172230` | `#0D1623` | `#EDF4FD` | `#2C9EFE` |
| Signal Red | Chiaro | `#491011` / `#E53F2A` / `#F7ECDA` | `#FCF7EF` | `#FFFFFF` | `#F7ECDA` | `#321514` | `#A62920` |
| Fieldnotes | Chiaro | `#39411B` / `#D8E01A` / `#F4E8D0` | `#FCF8ED` | `#FFFDF8` | `#F4E8D0` | `#292E1A` | `#556314` |
| Azure Ink | Chiaro | `#000D8A` / `#9ACBFA` / `#D5E7FB` | `#F2F7FE` | `#FFFFFF` | `#D5E7FB` | `#161C3D` | `#143BB0` |
| Kiln | Chiaro | `#4F2921` / `#E1966A` / `#F4E7D5` | `#FCF6ED` | `#FFFDF8` | `#F4E7D5` | `#382019` | `#A34528` |
| Deep Current | Scuro | `#0C2F32` / `#C2FDE7` / `#DFE9EA` | `#102729` | `#173437` | `#0C2F32` | `#E6F6F2` | `#89E9C8` |
| Circuit | Scuro | `#5525CF` / `#22123C` / `#ECFC7F` | `#181424` | `#211A30` | `#1A1427` | `#F7F4FF` | `#AC97FF` |
| Copperwire | Chiaro | `#442314` / `#C1FDFE` / `#F8884C` | `#FAF3EB` | `#FFFCF8` | `#F2E6DA` | `#352318` | `#216771` |
| Blue Hour | Scuro | `#443F7C` / `#CEC7F8` / `#FD8783` | `#22223A` | `#2A2A49` | `#242441` | `#F3F0FF` | `#CEC7F8` |
| Candor | Chiaro | `#165125` / `#D3E9F3` / `#FEC055` | `#F5F8F5` | `#FFFFFF` | `#E7F0E7` | `#1B3021` | `#196035` |
| Mono Light | Chiaro | `#000000` / `#FFFFFF` / `#D4D4D4` | `#FFFFFF` | `#FAFAFA` | `#F1F1F1` | `#121212` | `#161616` |
| Mono Dark | Scuro | `#FFFFFF` / `#000000` / `#808080` | `#0B0B0B` | `#151515` | `#080808` | `#F5F5F5` | `#F5F5F5` |

## Implementazione e criteri di accettazione

- Usa `brand/themes.json` come fonte dei token e `brand/themes.css` come riferimento per le variabili. Adatta l’import all’architettura esistente. Le viste consumano token semantici per superfici, testo, bordi, focus, selezione, codice e stati.
- Aggiungi un selettore in **Impostazioni → Aspetto**, con nome, anteprima e indicazione chiaro/scuro. Circuit è il default al primo avvio. Persiste la scelta a livello di app e applicala prima del primo paint, così il cambio progetto e il riavvio conservano il tema. Il cambio tema aggiorna chat, navigazione, pannelli, dialoghi, editor e diff.
- **Mono Light** è bianco con testo e marchi UI scuri. **Mono Dark** è nero con testo e marchi UI chiari. Mantieni entrambi interamente in scala di grigi, inclusi code block, diff e indicatori. Usa label, icone, simboli `+` e `−` e differenze di peso per rendere gli stati leggibili.
- Per gli stati, mostra la risposta da leggere nella sidebar, l’esecuzione in corso con uno stato discreto e l’approvazione con un’indicazione esplicita che apre la sessione corretta. Il colore accompagna sempre almeno un altro segnale. Verifica contrasto di testo, focus, selezione, controlli e stato attivo su tutti i temi. Come obiettivo usa 4,5:1 per testo normale e 3:1 per bordi di controllo e focus dove applicabile.
- Usa il lockup orizzontale negli spazi larghi e il solo simbolo nei punti compatti. Per il packaging macOS usa `app-icon/macos/ladder-circuit.icns`. Se la pipeline richiede PNG usa il master da 1024 px. Le varianti monocromatiche sono disponibili per superfici con esigenze specifiche.
- Verifica almeno Circuit, Blue Hour, un tema chiaro, Mono Light e Mono Dark su una sessione normale, un diff e una richiesta di approvazione. Testa la persistenza, il cambio immediato di tema e il fallback a Circuit se il valore salvato è sconosciuto.
- Al termine elenca file modificati, modalità di selezione, asset usati e verifiche eseguite.
