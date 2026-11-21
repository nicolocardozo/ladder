// Traduzioni italiane: profili di sessione (LAD-60). Chiave = testo inglese esatto del codice, valore = italiano.
const it: Record<string, string> = {
  // lib/session-presets.ts: elenco di ciò che il profilo non ha più (dopo "Ladder adjusted:") e errori del nome
  'agent (no longer available)': 'agente (non più disponibile)',
  'account (no longer available)': 'account (non più disponibile)',
  'model (no longer offered)': 'modello (non più offerto)',
  'effort (not supported by the model)': 'effort (non supportato dal modello)',
  'permissions (above the project maximum)': 'permessi (sopra il massimo del progetto)',
  'worktree (not a git project)': 'worktree (il progetto non è git)',
  '“{name}” no longer fits here, so Ladder adjusted: {items}.': '“{name}” non va più bene qui, quindi Ladder ha corretto: {items}.',
  worktree: 'worktree',
  'Give the profile a name.': 'Dai un nome al profilo.',
  'A session profile named “{name}” already exists.': 'Esiste già un profilo di sessione chiamato “{name}”.',

  // preset-dialog.tsx
  'Edit session profile': 'Modifica il profilo di sessione',
  'Save as session profile': 'Salva come profilo di sessione',
  'Agent, account, model, effort and permissions you can start a new chat with in one click.': 'Agente, account, modello, effort e permessi con cui avviare una nuova chat con un clic.',
  Name: 'Nome',
  'e.g. Quick review': 'es. Revisione veloce',
  'Note (optional)': 'Nota (facoltativa)',
  'What it is for, in a sentence or two': 'A cosa serve, in una o due frasi',
  Account: 'Account',
  'Project account': 'Account del progetto',
  'Default effort': 'Effort predefinito',
  'Work in a new worktree': 'Lavora in un nuovo worktree',
  'Starting prompt (optional)': 'Prompt iniziale (facoltativo)',
  'Appears in the composer as a draft; it never sends by itself': 'Compare nel composer come bozza; non parte mai da solo',
  'You can keep up to {n} profiles. Delete one to add another.': 'Puoi tenere al massimo {n} profili. Eliminane uno per aggiungerne un altro.',
  'Save changes': 'Salva le modifiche',
  'Save profile': 'Salva il profilo',
  'Account no longer available': 'Account non più disponibile',
  'This profile no longer exists, so it can’t be saved. Close this window and start again.': 'Questo profilo non esiste più, quindi non si può salvare. Chiudi la finestra e ricomincia.',

  // settings-presets.tsx
  'Session profiles': 'Profili di sessione',
  'New profile': 'Nuovo profilo',
  'Saved combinations of agent, account, model, effort and permissions. Pick one in the new chat, or from ⌘K, to start with a click. Save one from any session menu too.': 'Combinazioni salvate di agente, account, modello, effort e permessi. Scegline una nella nuova chat, o da ⌘K, per partire con un clic. Puoi salvarne una anche dal menu di una sessione.',
  'No profiles yet.': 'Ancora nessun profilo.',
  'Default for {project}': 'Predefinito di {project}',
  'Actions for {name}': 'Azioni per {name}',
  'Use as default for {project}': 'Usa come predefinito di {project}',
  'Stop using it as default for {project}': 'Non usarlo più come predefinito di {project}',
  Delete: 'Elimina',

  // main-views.tsx: nuova chat
  Profile: 'Profilo',
  'No profile': 'Nessun profilo',
  'Start from your defaults': 'Parti dai tuoi predefiniti',
  'Project default': 'Predefinito del progetto',
  'Manage profiles…': 'Gestisci i profili…',
  'Your draft stays as it is; the starting prompt of “{name}” was not added.': 'La tua bozza resta com’è; il prompt iniziale di “{name}” non è stato aggiunto.',

  // session-menu.tsx e command-palette.tsx
  'Save as profile…': 'Salva come profilo…',
  'New chat with {profile}': 'Nuova chat con {profile}',
  'Save session as profile…': 'Salva la sessione come profilo…'
}
export default it
