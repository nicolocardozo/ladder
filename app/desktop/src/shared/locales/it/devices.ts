// Traduzioni italiane: Impostazioni → Dispositivi (telefoni, QR, password, log) e indicatore nella barra in alto (LAD-51). Chiave = testo inglese esatto del codice.
const it: Record<string, string> = {
  // Sezione e accesso
  Devices: 'Dispositivi',
  'Follow your sessions and answer requests from your phone. Agents keep running on this Mac.': 'Segui le sessioni e rispondi alle richieste dal telefono. Gli agenti continuano a lavorare su questo Mac.',
  'Phone access': 'Accesso dal telefono',
  'Access from your phone': 'Accesso dal telefono',
  'See sessions, approve requests and send messages from your phone. Everything is end-to-end encrypted through a relay that can’t read it. Agents keep running on this Mac.':
    'Vedi le sessioni, approva le richieste e invia messaggi dal telefono. Tutto è cifrato da un capo all’altro attraverso un relay che non può leggerlo. Gli agenti continuano a lavorare su questo Mac.',
  'Allow Full access from phone': 'Consenti l’accesso completo dal telefono',
  'Lets a paired phone switch a session to Full access, where the agent runs commands without asking. Turn it off to keep phones at Edit or below.':
    'Permette a un telefono abbinato di passare una sessione ad Accesso completo, dove l’agente esegue i comandi senza chiedere. Spegnilo per tenere i telefoni a Modifica o meno.',

  // Telefoni abbinati
  'Paired phones': 'Telefoni abbinati',
  'No phones yet.': 'Ancora nessun telefono.',
  'These phones can reach this Mac.': 'Questi telefoni possono collegarsi a questo Mac.',
  'Connect a phone': 'Collega un telefono',
  'Connect a phone to follow your sessions and answer requests from it.': 'Collega un telefono per seguire le sessioni e rispondere alle richieste da lì.',
  iPhone: 'iPhone',
  'Android phone': 'Telefono Android',
  'Phone name': 'Nome del telefono',
  'Rename {name}': 'Rinomina {name}',
  'Last seen {time}': 'Visto {time}',
  'Never connected': 'Mai collegato',
  '{platform} · Paired {date}': '{platform} · abbinato il {date}',
  Revoke: 'Revoca',
  'Revoke {name}': 'Revoca {name}',
  '{name} is disconnected right away and can’t reconnect. To use it again, pair it with a new code.': '{name} viene scollegato subito e non può ricollegarsi. Per usarlo di nuovo, abbinalo con un codice nuovo.',

  // Abbinamento
  'Open Ladder on your phone and scan this code.': 'Apri Ladder sul telefono e inquadra questo codice.',
  'QR code to connect a phone to {mac}': 'Codice QR per collegare un telefono a {mac}',
  'Creating a code…': 'Creo un codice…',
  'This code is no longer valid.': 'Questo codice non vale più.',
  Mac: 'Mac',
  'Key fingerprint': 'Impronta della chiave',
  'Expires in {time}': 'Scade tra {time}',
  'No longer valid': 'Non più valido',
  'Your phone shows the same fingerprint before it connects. If they differ, don’t connect.': 'Il telefono mostra la stessa impronta prima di collegarsi. Se sono diverse, non collegarti.',
  'Your phone will also ask for the password you set in Settings.': 'Il telefono chiederà anche la password che hai impostato nelle Impostazioni.',
  'Refresh code': 'Nuovo codice',
  '{name} is connected': '{name} è collegato',
  'It can now see your sessions and answer requests.': 'Ora può vedere le sessioni e rispondere alle richieste.',
  Done: 'Fatto',

  // Password
  'Require a password to pair': 'Chiedi una password per l’abbinamento',
  'A password is set. It’s asked only when pairing a new phone, on top of the code.': 'Una password è impostata. Si chiede solo quando abbini un telefono nuovo, oltre al codice.',
  'Off. Anyone who scans the code on this screen can pair a phone. A password is asked only when pairing a new phone.':
    'Spenta. Chiunque inquadri il codice su questo schermo può abbinare un telefono. Una password si chiede solo quando abbini un telefono nuovo.',
  'Change password': 'Cambia password',
  'Set password': 'Imposta password',
  'Password removed.': 'Password tolta.',
  'Password changed.': 'Password cambiata.',
  'Password set.': 'Password impostata.',
  '{min} to {max} characters. Phones already paired keep working.': 'Da {min} a {max} caratteri. I telefoni già abbinati continuano a funzionare.',
  'New password': 'Nuova password',
  Password: 'Password',

  // Attività
  'Phone activity': 'Attività dal telefono',
  'The latest things done from a phone: answers, messages and stops.': 'Le ultime cose fatte da un telefono: risposte, messaggi e stop.',
  'Nothing yet. What you do from a phone shows up here.': 'Ancora niente. Quello che fai da un telefono compare qui.',
  'Show more': 'Mostra altro',

  // Avanzate
  Advanced: 'Avanzate',
  'Relay address': 'Indirizzo del relay',
  'Leave it empty to use the default relay. Change it only if you host your own. The relay can’t read your sessions.': 'Lascialo vuoto per usare il relay predefinito. Cambialo solo se ne ospiti uno tuo. Il relay non può leggere le sessioni.',
  'Enter an address like wss://relay.example.com.': 'Inserisci un indirizzo come wss://relay.example.com.',
  'Use wss://. Plain ws:// only works for localhost.': 'Usa wss://. ws:// semplice funziona solo con localhost.',
  'The address must start with wss://.': 'L’indirizzo deve iniziare con wss://.',
  'Mac key fingerprint': 'Impronta della chiave del Mac',
  'Not created yet': 'Non ancora creata',
  'Regenerate key': 'Rigenera la chiave',
  'Creates a new key for this Mac. Use it if a phone is lost or you think someone else paired.': 'Crea una chiave nuova per questo Mac. Usala se perdi un telefono o pensi che si sia abbinato qualcun altro.',
  'Every paired phone is disconnected and must pair again with a new code. This can’t be undone.': 'Ogni telefono abbinato viene scollegato e deve abbinarsi di nuovo con un codice nuovo. Non si può annullare.',
  'Key regenerated. All phones were disconnected.': 'Chiave rigenerata. Tutti i telefoni sono stati scollegati.',

  // Barra in alto e chat
  '{n} phones connected': '{n} telefoni collegati',
  'from {device}': 'da {device}',
  'from phone': 'dal telefono'
}
export default it
