// Traduzioni italiane: collegamenti (Claude, ChatGPT / Codex, GitHub), primo avvio e Impostazioni → Abbonamenti.
// Chiave = testo inglese esatto del codice, valore = italiano.
const it: Record<string, string> = {
  // Primo avvio e sezione Abbonamenti.
  'Connect your subscriptions': 'Collega i tuoi abbonamenti',
  'Ladder works with the plans you already pay for. Signing in opens your browser, and you come back here connected. No Terminal needed.':
    'Ladder funziona con i piani che già paghi. L’accesso apre il browser e torni qui già collegato. Non serve il Terminale.',
  'You can do this later in Settings → Subscriptions.': 'Puoi farlo anche dopo, in Impostazioni → Abbonamenti.',
  Continue: 'Continua',
  'Skip for now': 'Salta per ora',
  Subscriptions: 'Abbonamenti',
  'Sign in with the plans you already pay for. Ladder opens your browser and you come back connected, without installing anything or using the Terminal.':
    'Accedi con i piani che già paghi. Ladder apre il browser e torni collegato, senza installare niente né usare il Terminale.',
  'GitHub is connected from Subscriptions: Ladder signs in with your browser and keeps no tokens of its own.':
    'GitHub si collega da Abbonamenti: Ladder fa l’accesso dal browser e non conserva token propri.',
  'Open Subscriptions': 'Apri Abbonamenti',

  // Righe dei collegamenti.
  'Runs Claude Code sessions with your Claude subscription.': 'Fa lavorare le sessioni di Claude Code con il tuo abbonamento Claude.',
  'Runs Codex sessions with your ChatGPT plan.': 'Fa lavorare le sessioni di Codex con il tuo piano ChatGPT.',
  'Issues, pull requests and CI in “New session from…” and the Merge panel.': 'Issue, pull request e CI in “Nuova sessione da…” e nel pannello Merge.',
  '{tool} isn’t installed. Ladder downloads it, then opens your browser to sign in.': '{tool} non è installato. Ladder lo scarica, poi apre il browser per l’accesso.',
  Connected: 'Collegato',
  'Not signed in': 'Non collegato',
  'Signing in…': 'Accesso in corso…',
  Problem: 'Problema',
  'Signed in as {account}': 'Collegato come {account}',
  'Signed in': 'Collegato',
  'Sign in': 'Accedi',
  'Try again': 'Riprova',
  'Sign out': 'Esci',
  'Switch account': 'Cambia account',
  'Sign in to {name}': 'Accedi a {name}',
  'Sign out of {name}': 'Esci da {name}',
  'Switch account on {name}': 'Cambia account su {name}',
  'Cancel signing in to {name}': 'Annulla l’accesso a {name}',
  Confirm: 'Conferma',
  'Signing out also signs out the Claude Code CLI you use in the Terminal: they share the same login.':
    'Uscendo esci anche dalla CLI di Claude Code che usi nel Terminale: condividono lo stesso login.',
  'Switching account signs you out first, then opens the sign-in. If you cancel the sign-in you stay signed out, and the Claude Code CLI you use in the Terminal too: they share the same login.':
    'Cambiando account esci prima, poi si apre l’accesso. Se annulli l’accesso resti scollegato, e lo stesso vale per la CLI di Claude Code che usi nel Terminale: condividono lo stesso login.',
  'Switching account signs you out first, then opens the sign-in. If you cancel the sign-in you stay signed out.':
    'Cambiando account esci prima, poi si apre l’accesso. Se annulli l’accesso resti scollegato.',
  'Installed on your Mac': 'Installato sul tuo Mac',
  'Included with Ladder': 'Incluso in Ladder',
  'Downloaded by Ladder': 'Scaricato da Ladder',

  // Download e accesso in corso.
  'Downloading {tool}…': 'Scarico {tool}…',
  'Verifying the download…': 'Verifico il download…',
  'Installing…': 'Installo…',
  'Waiting for you to finish in the browser…': 'In attesa che tu finisca nel browser…',
  'Finishing…': 'Concludo…',
  'Download progress': 'Avanzamento del download',
  '{done} of {total}': '{done} di {total}',
  'Enter this code on the page:': 'Inserisci questo codice nella pagina:',
  'Copy code': 'Copia il codice',
  'Code copied': 'Codice copiato',
  'Reopen the page': 'Riapri la pagina',
  'Copy link': 'Copia il link',
  'Link copied': 'Link copiato',

  // Composer, menu degli agenti e pannello Merge.
  'Not signed in. Click to sign in.': 'Non collegato. Clicca per accedere.',
  'Sign in to {name} to start a session.': 'Accedi a {name} per avviare una sessione.',
  '{name} isn’t signed in. Sign in to start a session.': '{name} non è collegato. Accedi per avviare una sessione.',
  'Signing in to {name}…': 'Accesso a {name} in corso…',
  'Show the sign in to {name}': 'Mostra l’accesso a {name}',
  Show: 'Mostra',
  'Connect GitHub to see the PR and its checks here.': 'Collega GitHub per vedere qui la PR e i suoi controlli.',
  'Connect GitHub': 'Collega GitHub',

  // Profili: più account per agente (Impostazioni → Abbonamenti, progetto, nuova chat, sidebar).
  'Something went wrong. Try again.': 'Qualcosa è andato storto. Riprova.',
  'Usage limits': 'Limiti d’uso',
  'Refresh usage of {name}': 'Aggiorna i limiti di {name}',
  'Account name': 'Nome dell’account',
  'Work, Personal…': 'Lavoro, Personale…',
  Create: 'Crea',
  'Add {name} account': 'Aggiungi un account {name}',
  'Options for {name}': 'Opzioni di {name}',
  'Remove account': 'Rimuovi l’account',
  'Remove “{name}”? Its idle and archived sessions move to the default account, and their conversation restarts as a new one (the transcript stays in Ladder). The account’s folder and its sign-in stay on your Mac.':
    'Rimuovere “{name}”? Le sue sessioni ferme e archiviate passano all’account predefinito e la loro conversazione riparte da una nuova (la trascrizione resta in Ladder). La cartella dell’account e il suo accesso restano sul tuo Mac.',
  'Account: {name}': 'Account: {name}',
  'Account for {agent}': 'Account per {agent}',
  '{agent} account': 'Account {agent}',
  'New sessions in this project use it. Existing sessions keep theirs.': 'Le nuove sessioni di questo progetto lo usano. Quelle esistenti tengono il loro.'
}

export default it
