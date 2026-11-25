// Italian translations: resuming interrupted handoffs and delegations, plan limit, cross-review and project switches. Key = exact English text in the code.
const it: Record<string, string> = {
  // Handoff row: stop, resume and reassignment
  'Stop the handoff': 'Ferma il passaggio',
  'Hand off to another agent': 'Passa a un altro agente',
  'Resume with {agent}': 'Riprendi con {agent}',
  'Resume handoff': 'Riprendi',
  'Resume delegation': 'Riprendi',
  'Reassign…': 'Riassegna…',
  'The summary is saved, so {agent} can pick it up right away.': 'Il riassunto è salvato: {agent} può partire subito.',
  'The summary was not written yet. Ladder will ask {agent} for it again.': 'Il riassunto non era ancora scritto. Ladder lo chiederà di nuovo a {agent}.',

  // Handoff for plan limit
  'Continuing with {to}: {from} reached its limit': 'Si continua con {to}: {from} ha raggiunto il limite',
  'Continued with {to}: {from} reached its limit': 'Si è continuato con {to}: {from} ha raggiunto il limite',
  'Continued from {agent}: it reached its limit': 'Si continua da {agent}: ha raggiunto il limite',

  // Interrupted delegation
  'Delegation to {agent} interrupted': 'Delega a {agent} interrotta',
  'Delegation to {agent} resumed': 'Delega a {agent} ripresa',
  'Delegation to {agent} finished': 'Delega a {agent} conclusa',
  'Delegation to {agent} dismissed': 'Delega a {agent} chiusa',
  'Interrupted delegation to {agent}': 'Delega a {agent} interrotta',
  'Could not resume the delegation to {agent}': 'Non è stato possibile riprendere la delega a {agent}',
  'Resume it to restart the work of {agent} and get its result here.': 'Riprendila per far ripartire il lavoro di {agent} e ricevere qui il suo risultato.',
  'Open child session': 'Apri la sessione figlia',

  // Plan limit
  '5-hour limit': 'limite di 5 ore',
  'Weekly limit': 'limite settimanale',
  '{agent} reached its {window}': '{agent} ha raggiunto il {window}',
  'resets at {when}': 'si azzera {when}',
  'Continue with {agent}': 'Continua con {agent}',
  'Choose another agent': 'Scegli un altro agente',
  'Choose another agent…': 'Scegli un altro agente…',
  'Choose an agent…': 'Scegli un agente…',
  'No other agent is available right now.': 'Al momento non c’è un altro agente disponibile.',
  'Switched to {agent} automatically': 'Passato a {agent} in automatico',
  'Switched to {agent}': 'Passato a {agent}',
  'Switched to another agent': 'Passato a un altro agente',
  '{agent} is available again': '{agent} è di nuovo disponibile',
  'Go back': 'Torna indietro',
  'Go back to {agent}': 'Torna a {agent}',
  'Went back to {agent}': 'Si è tornati a {agent}',

  // Cross-review
  'Cross-review by {agent}': 'Revisione incrociata di {agent}',
  'Changes from the last turn': 'Modifiche dell’ultimo turno',
  'No issues': 'Nessun problema',
  'Minor issues': 'Problemi lievi',
  'Serious issues': 'Problemi gravi',
  'Sent to {agent} automatically': 'Inviato a {agent} in automatico',

  // Settings: personal project switches
  Off: 'Spento',
  'Agent switching and review in {project}': 'Cambio agente e revisione in {project}',
  'These two are personal: they are saved in {file}, kept out of git, and off by default.': 'Questi due sono personali: si salvano in {file}, restano fuori da git e sono spenti di default.',
  'Switch automatically when the plan limit is reached': 'Passa in automatico quando si raggiunge il limite del piano',
  'Ladder hands the work to this agent by itself. Off means it only proposes it.': 'Ladder affida il lavoro a questo agente da solo. Da spento si limita a proporlo.',
  'Cross-review after turns with changes': 'Revisione incrociata dopo i turni con modifiche',
  'This agent reads the diff, read-only, and its verdict shows in the chat. A serious one goes back to the agent on its own.': 'Questo agente legge il diff in sola lettura e il suo giudizio compare nella chat. Se è grave, torna da solo all’agente.'
}

export default it
