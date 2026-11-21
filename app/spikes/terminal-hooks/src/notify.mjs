// Programma `notify` di Codex: riceve il payload JSON come ultimo argomento e lo inoltra al server di Blue.
// Uso in config: notify = ["<node>", "<questo file>", "<url del server>"]  (Codex aggiunge il JSON in coda).
const [url, payload] = process.argv.slice(2);
if (!url || !payload) process.exit(0);
try {
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-blue-token': process.env.BLUE_HOOK_TOKEN ?? '' },
    body: payload,
    signal: AbortSignal.timeout(3000),
  });
} catch {
  // Blue non raggiungibile: nessun effetto su Codex.
}
