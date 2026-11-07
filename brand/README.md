# Ladder — Brand & logo kit

Il marchio è ricostruito dall’ultima prova approvata, riprodotta in
`reference/ladder-logo-approved.png`. I tre binari sono disegnati come poligoni
vettoriali e la scritta è tracciata dalla stessa immagine. Gli SVG sono
autonomi, con forme convertite in tracciati. Si possono usare senza font esterni.

| Percorso | Contenuto |
|---|---|
| `logo/svg/` e `logo/png/` | Simbolo, wordmark, composizione orizzontale e composizione verticale. Ogni forma è disponibile in iris Circuit, viola profondo, grafite, nero e bianco. I PNG hanno fondo trasparente. |
| `app-icon/svg/` | Master vettoriali delle icone Circuit, Mono Light e Mono Dark. |
| `app-icon/png/` | Versioni da 16, 24, 32, 48, 64, 128, 256, 512 e 1024 px. |
| `app-icon/macos/` | Icone ICNS, inclusa la versione principale `ladder-circuit.icns`. |
| `app-icon/windows/` | Icone ICO multirisoluzione. |
| `brand/` | Dodici temi con token semantici in JSON e CSS, più il prompt completo per Claude Code. |
| `reference/` | Logo approvato e tavole cromatiche di riferimento. |

## Riferimenti rapidi

- **Logo principale:** `logo/svg/ladder-horizontal-circuit.svg`.
- **Simbolo in UI:** `logo/svg/ladder-mark-circuit.svg` su superfici chiare.
  Su superfici scure usa `ladder-mark-white.svg`.
- **Icona macOS:** `app-icon/macos/ladder-circuit.icns`.
- **Tema Circuit:** iris `#5525CF`, viola profondo `#22123C`, citron
  `#ECFC7F`. L’icona usa il segno bianco su viola profondo.
- **Temi UI:** il selettore cambia i token del workspace. Il brand e l’icona
  di distribuzione mantengono Circuit.

I tre colori di ogni palette derivano da campioni delle tavole concettuali.
I colori semantici della UI sono stati scelti per l’uso sulle superfici
dell’app. I token di testo, focus e controllo sono stati verificati sulle
combinazioni di base. Verifica i componenti renderizzati nel prodotto dopo
l’integrazione.
