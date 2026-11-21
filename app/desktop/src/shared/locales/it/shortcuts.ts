// Traduzioni italiane: scorciatoie (Impostazioni → Shortcuts, palette e comandi nuovi). Chiave = testo inglese esatto del codice.
const it: Record<string, string> = {
  // Sezione e palette
  Shortcuts: 'Scorciatoie',
  'Keyboard shortcuts': 'Scorciatoie da tastiera',
  'Start from the shortcuts of VS Code or Cursor and change any of them. Your changes are saved in keybindings.json, in the same format as VS Code.':
    'Parti dalle scorciatoie di VS Code o di Cursor e cambia quelle che vuoi. Le modifiche stanno in keybindings.json, nello stesso formato di VS Code.',
  'Search by command or key…': 'Cerca per comando o tasto…',
  'Search shortcuts': 'Cerca nelle scorciatoie',
  'Shortcut preset': 'Preset di scorciatoie',
  'Open keybindings.json': 'Apri keybindings.json',
  'Reset all': 'Ripristina tutte',
  'Only the shortcuts Ladder comes with.': 'Solo le scorciatoie di Ladder.',
  'Adds the shortcuts of {editor} that Ladder doesn’t have: {list}. Your own changes stay on top.':
    'Aggiunge le scorciatoie di {editor} che Ladder non ha: {list}. Le tue modifiche restano sopra.',
  'Remove all your changes? The current file is kept as keybindings.json.bak.': 'Togliere tutte le tue modifiche? Il file attuale resta come keybindings.json.bak.',
  'No shortcuts match “{query}”.': 'Nessuna scorciatoia corrisponde a “{query}”.',

  // Avvisi sul file
  'keybindings.json can’t be read': 'keybindings.json non si legge',
  'Ladder keeps the last shortcuts that worked and leaves the file as it is until you fix it or reset all.':
    'Ladder tiene le ultime scorciatoie che funzionavano e non tocca il file finché non lo correggi o le ripristini tutte.',
  '{n} entry of keybindings.json is ignored': '{n} voce di keybindings.json è ignorata',
  '{n} entries of keybindings.json are ignored': '{n} voci di keybindings.json sono ignorate',
  'Ignored entries stay in the file.': 'Le voci ignorate restano nel file.',

  // Righe e registrazione
  'Add shortcut': 'Aggiungi scorciatoia',
  'Change shortcut for {command}': 'Cambia la scorciatoia di {command}',
  'Remove the shortcut of {command}': 'Togli la scorciatoia di {command}',
  'Remove shortcut': 'Togli la scorciatoia',
  'Reset {command} to default': 'Riporta {command} al predefinito',
  'Press keys…': 'Premi i tasti…',
  'Press the new shortcut for {command}. Esc cancels.': 'Premi la nuova scorciatoia per {command}. Esc annulla.',
  'That key can’t be used': 'Questo tasto non si può usare',
  'Needs ⌘, ⌃ or ⌥': 'Serve ⌘, ⌃ o ⌥',
  'Shortcut conflict': 'Conflitto di scorciatoie',
  '{shortcut} is already assigned to {commands}.': '{shortcut} è già assegnata a {commands}.',
  Replace: 'Sostituisci',

  // Gruppi
  Navigation: 'Navigazione',
  'Sessions and tabs': 'Sessioni e tab',
  Panels: 'Pannelli',
  'Editor and message box': 'Editor e campo messaggio',
  App: 'App',

  // Nomi dei comandi
  'Search in project': 'Cerca nel progetto',
  'Show or hide sidebar': 'Mostra o nascondi la sidebar',
  'Go to project {n}': 'Vai al progetto {n}',
  'Focus the column on the left': 'Sposta il focus sulla colonna a sinistra',
  'Focus the column on the right': 'Sposta il focus sulla colonna a destra',
  'Next tab': 'Tab successiva',
  'Previous tab': 'Tab precedente',
  'Reopen closed tab': 'Riapri la tab chiusa',
  'Move tab left': 'Sposta la tab a sinistra',
  'Move tab right': 'Sposta la tab a destra',
  'Close tab': 'Chiudi la tab',
  'Stop the running session': 'Ferma la sessione in corso',
  'Save file': 'Salva il file',
  'Change permission level': 'Cambia il livello di permesso',
  'Stop the reply from the message box': 'Ferma la risposta dal campo messaggio',
  'Open Settings': 'Apri le impostazioni',
  'Close window': 'Chiudi la finestra'
}

export default it
