// Italian translations: Ladder MCP server, agent-requested handoffs and delegations. Key = exact English text in the code.
const it: Record<string, string> = {
  // mcp__ladder__* tools in chat
  'another agent': 'un altro agente',
  'Delegates to {agent}: {task}': 'Delega a {agent}: {task}',
  'Delegates to {agent}': 'Delega a {agent}',
  'Hands off to {agent}': 'Passa a {agent}',
  'Lists available agents': 'Elenca gli agenti disponibili',
  'Reports the result': 'Riporta l’esito',

  // Agent-requested handoff row, outcome
  'Hands off to {agent} when this turn ends': 'Passa a {agent} quando questo turno finisce',
  '{from} asked to hand off to {to}': '{from} ha chiesto di passare a {to}',
  'Handed off by {agent}': 'Passata da {agent}',
  'Result from {agent}': 'Esito da {agent}',
  'Blocked': 'Bloccato',
  'Failed': 'Fallito',

  // Child header
  'Delegated by {title}': 'Delegata da {title}',
  'Open the session that delegated this work': 'Apri la sessione che ha delegato questo lavoro',

  // Settings: preferred project delegates
  'Preferred delegates of {project}': 'Delegati preferiti di {project}',
  'Preferred delegates': 'Delegati preferiti',
  'Agents the coordinator can hand a task to. The agent decides when and to whom; Ladder only lists them. They are read from the project’s files, so edit the file to change them.':
    'Agenti a cui il coordinatore può affidare un compito. Decide l’agente quando e a chi; Ladder si limita a elencarli. Si leggono dai file del progetto: per cambiarli modifica il file.',
  'No delegates set for this project.': 'Nessun delegato impostato per questo progetto.',
  'Edit {shared} (shared with the team) or {personal} (personal, kept out of git) in the project folder, and add one block per delegate:':
    'Modifica {shared} (condiviso con il team) o {personal} (personale, fuori da git) nella cartella del progetto, e aggiungi un blocco per ogni delegato:'
}
export default it
