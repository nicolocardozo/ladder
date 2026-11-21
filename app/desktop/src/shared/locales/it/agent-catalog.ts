// Traduzioni italiane: catalogo degli agenti ACP (Impostazioni → Agenti), rilevamento del primo avvio e installazione dei binari.
// Chiave = testo inglese esatto del codice, valore = italiano.
const it: Record<string, string> = {
  // Catalogo.
  'Add an agent': 'Aggiungi un agente',
  Catalog: 'Catalogo',
  'Most used': 'I più usati',
  'More from the ACP registry': 'Altri dal registro ACP',
  'More from the ACP registry · {n}': 'Altri dal registro ACP · {n}',
  'Looking for agents on your Mac and reading the registry…': 'Cerco gli agenti sul tuo Mac e leggo il registro…',
  'No agent matches “{query}”.': 'Nessun agente corrisponde a “{query}”.',
  'The registry has no agents for this Mac.': 'Il registro non ha agenti per questo Mac.',
  Rescan: 'Cerca di nuovo',
  'Scan for installed agents again': 'Cerca di nuovo gli agenti installati',
  'The agent handles its own login. Binaries are only downloaded after you confirm, and are never updated on their own.':
    'L’accesso lo gestisce l’agente. I binari si scaricano solo dopo la tua conferma e non si aggiornano mai da soli.',

  // Stato di una voce.
  'Found on your Mac': 'Trovato sul tuo Mac',
  'Installed by Ladder': 'Installato da Ladder',
  'Available to download': 'Si può scaricare',
  'Not installed': 'Non installato',
  'Downloaded by Ladder · v{version}': 'Scaricato da Ladder · v{version}',
  'Binary from {host} · v{version}': 'Binario da {host} · v{version}',
  'Starts with npx on first use': 'Parte con npx al primo uso',
  'Starts with uvx on first use': 'Parte con uvx al primo uso',
  'Update to v{version}': 'Aggiornamento a v{version}',
  'Sign-in not checked yet': 'Accesso non ancora verificato',
  'Sign-in required': 'Richiede l’accesso',
  'Sign-in required: {methods}': 'Richiede l’accesso: {methods}',
  'Setup guide': 'Guida all’avvio',
  'Setup guide for {name}, opens in your browser': 'Guida all’avvio di {name}, si apre nel browser',

  // Azioni e conferma.
  'Add {name}': 'Aggiungi {name}',
  'Download and add': 'Scarica e aggiungi',
  'Download and add {name}': 'Scarica e aggiungi {name}',
  Update: 'Aggiorna',
  'Update {name}': 'Aggiorna {name}',
  'Cancel the download of {name}': 'Annulla il download di {name}',
  'Try downloading {name} again': 'Riprova a scaricare {name}',
  'Download cancelled.': 'Download annullato.',
  'Confirm download of {name}': 'Conferma il download di {name}',
  'Confirm update of {name}': 'Conferma l’aggiornamento di {name}',
  'Download {name} v{version}?': 'Scaricare {name} v{version}?',
  'Update {name} from v{from} to v{to}?': 'Aggiornare {name} da v{from} a v{to}?',
  Version: 'Versione',
  'Downloads from': 'Si scarica da',
  'Checksum from': 'Checksum da',
  'The ACP registry': 'Il registro ACP',
  'The GitHub release': 'La release di GitHub',
  None: 'Nessuna',
  'Ladder checks the checksum before it can start the agent, and never updates it on its own.':
    'Ladder verifica il checksum prima di poter avviare l’agente e non lo aggiorna mai da solo.',

  // Voci che Ladder non scarica (LAD-56): motivo in chiaro e link alla procedura del vendor.
  'Install from the official site': 'Installa dal sito ufficiale',
  'Download address not expected': 'Indirizzo di download non previsto',
  'The checksum of this version has changed': 'Il checksum di questa versione è cambiato',
  'Download too large': 'Download troppo grande',
  'Checksum not available now': 'Checksum non disponibile ora',
  'Ladder cannot read the checksum of {name} right now. Try again later.': 'Impossibile leggere ora il checksum di {name}. Riprova più tardi.',
  'The checksum is not available now. Try again later.': 'Il checksum non è disponibile ora. Riprova più tardi.',
  'Try again to read the checksum of {name}': 'Riprova a leggere il checksum di {name}',
  'The signature does not hold': 'La firma non regge',
  'Not signed by the developer Ladder expects': 'Non firmato dallo sviluppatore che Ladder si aspetta',
  'The download changed after you checked it': 'Il download è cambiato dopo che lo hai controllato',
  'Ladder expects {name} to be signed by its official developer, and this download is not, so Ladder did not install it.':
    'Ladder si aspetta che {name} sia firmato dallo sviluppatore ufficiale e questo download non lo è, quindi Ladder non l’ha installato.',
  'The registry changed this download after you checked it, so Ladder did not install it.':
    'Il registro ha cambiato questo download dopo che lo hai controllato, quindi Ladder non l’ha installato.',
  'Update to v{version} is available, but the checksum is not available now.': 'Aggiornamento alla v{version} disponibile, ma il checksum non è disponibile ora.',
  'macOS put the download in quarantine': 'macOS ha messo il download in quarantena',
  '{name} has no checksum Ladder can verify, so Ladder does not download it.':
    '{name} non ha un checksum che Ladder possa verificare, quindi Ladder non lo scarica.',
  'The archive of {name} is not on the address Ladder expects for it (not https, another domain, or a redirect elsewhere), so Ladder does not download it.':
    'L’archivio di {name} non sta sull’indirizzo che Ladder si aspetta (non è https, è un altro dominio o c’è un reindirizzamento altrove), quindi Ladder non lo scarica.',
  'Ladder already downloaded this version of {name} with a different checksum. The same version now comes with another one, so Ladder did not download it. Do not install it until the vendor explains the change.':
    'Ladder ha già scaricato questa versione di {name} con un checksum diverso. La stessa versione ora ne ha un altro, quindi Ladder non l’ha scaricata. Non installarla finché il vendor non spiega il cambio.',
  'The download of {name} is larger than Ladder allows (600 MiB archive, 2 GiB unpacked), so Ladder does not download it.':
    'Il download di {name} supera i limiti di Ladder (600 MiB l’archivio, 2 GiB estratto), quindi Ladder non lo scarica.',
  'The program of {name} is signed, but its signature does not hold, so Ladder did not install it.':
    'Il programma di {name} è firmato, ma la firma non regge, quindi Ladder non l’ha installato.',
  'macOS put the file of {name} in quarantine, so it would not start. Ladder does not remove the quarantine.':
    'macOS ha messo il file di {name} in quarantena e non partirebbe. Ladder non toglie la quarantena.',
  'Open the install guide': 'Apri la guida all’installazione',
  'Install guide for {name}, opens in your browser': 'Guida all’installazione di {name}, si apre nel browser',

  // Firma, dopo l'installazione: solo lo stato.
  'Signed by {signer}': 'Firmato da {signer}',
  'Signed, signer not read': 'Firmato, firmatario non letto',
  'team {team}': 'team {team}',
  'Signature intact, signer not verified': 'Firma integra, firmatario non verificato',
  'Ad hoc signature, signer unknown': 'Firmato ad hoc, firmatario sconosciuto',
  'Not signed': 'Non firmato',

  // Conferma riaperta da sola in una riga senza focus: si annuncia, il focus resta dov'è.
  'A confirmation for {name} is open. Check the details before you confirm.': 'Una conferma per {name} è aperta. Controlla i dettagli prima di confermare.',

  // Conferma: dimensione e checksum.
  Size: 'Dimensione',
  Unknown: 'Sconosciuta',
  'Checksum (SHA-256)': 'Checksum (SHA-256)',
  'Show full checksum': 'Mostra il checksum intero',
  'Show less': 'Mostra meno',
  'Copy checksum': 'Copia il checksum',
  'Checksum copied': 'Checksum copiato',
  'The registry now lists different details than the ones you saw. Check them again before you confirm.':
    'Il registro ora indica dati diversi da quelli che hai visto. Controllali di nuovo prima di confermare.',
  'Who signed the program is checked after the download, and Ladder shows it when it is done.':
    'Chi ha firmato il programma si controlla dopo il download e Ladder lo mostra a fine installazione.',

  // Accesso: lo fa l'agente, Ladder non tocca le credenziali.
  '{name} needs you to sign in': '{name} richiede l’accesso',
  'Sign in': 'Accedi',
  'Sign in to {name} with {method}': 'Accedi a {name} con {method}',
  'Stop waiting': 'Smetti di aspettare',
  'Waiting for {name} to finish signing in. It may open your browser.':
    'Aspetto che {name} finisca l’accesso. Potrebbe aprire il browser.',
  'Ladder does not support this sign-in method.': 'Questo metodo di accesso non è supportato da Ladder.',
  'Still not signed in. Try again.': 'Accesso non ancora riuscito. Riprova.',
  'Sign in from a terminal with the agent’s own command.': 'Accedi dal terminale con il comando dell’agente.',
  'Ladder never sees your credentials: the agent handles the sign-in.': 'Ladder non vede mai le tue credenziali: l’accesso lo gestisce l’agente.',

  // Primo avvio.
  'Other agents found on your Mac': 'Altri agenti trovati sul tuo Mac'
}

export default it
