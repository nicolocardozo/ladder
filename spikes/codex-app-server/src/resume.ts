// Criterio 8: dopo il SIGKILL di run.ts, nuovo processo app-server, thread/list e thread/resume,
// poi un turno che chiede quale file è stato creato.
import type { Thread, ThreadListParams, ThreadSourceKind } from "../generated/stable/v2/index.ts";
import { printStats, readState, recordCheck, runTurn, startServer, text } from "./util.ts";

const state = readState();
if (!state.threadId || !state.repo || !state.model || !state.effort) throw new Error("run `npm run run` first");
const { threadId, repo, model, effort } = state;

const s = await startServer({ logName: "resume" });
s.setRequestHandler((req) => ({ error: { code: -32601, message: `unexpected ${req.method}` } }));

// ---- thread/list: con e senza sourceKinds --------------------------------------------------
async function find(label: string, params: ThreadListParams): Promise<Thread | undefined> {
  const res = await s.request("thread/list", { limit: 50, ...params });
  const hit = res.data.find((t) => t.id === threadId);
  console.log(`thread/list ${label}: ${res.data.length} threads, target ${hit ? `found (source=${JSON.stringify(hit.source)}, name=${JSON.stringify(hit.name)}, status=${hit.status.type})` : "NOT found"}`);
  return hit;
}
const byDefault = await find("default sourceKinds, cwd filter", { cwd: repo });
const kinds: ThreadSourceKind[][] = [["appServer"], ["vscode"], ["cli", "vscode", "exec", "appServer"]];
const byKind: Record<string, boolean> = {};
for (const k of kinds) byKind[k.join("+")] = Boolean(await find(`sourceKinds=${k.join("+")}, cwd filter`, { cwd: repo, sourceKinds: k }));
const bySearch = await find("sourceKinds=all, searchTerm 'blue-spike'", { sourceKinds: ["cli", "vscode", "exec", "appServer"], searchTerm: "blue-spike" });

// thread/read prima del resume: stato su disco, senza caricarlo.
const read = await s.request("thread/read", { threadId, includeTurns: false });
console.log(`thread/read before resume: status=${read.thread.status.type}, path=${read.thread.path ? "(set)" : null}, name=${read.thread.name}`);

// ---- thread/resume ----------------------------------------------------------------------------
// La reidratazione completa è deprecata (deprecationNotice): excludeTurns + thread/turns/list.
const resumed = await s.request("thread/resume", { threadId, excludeTurns: true });
console.log(
  `thread/resume (excludeTurns) → turns in payload=${resumed.thread.turns.length}, model=${resumed.model}, effort=${resumed.reasoningEffort}, ` +
    `approval=${JSON.stringify(resumed.approvalPolicy)}, sandbox=${resumed.sandbox.type}, cwd=${resumed.cwd}, status=${resumed.thread.status.type}`,
);
const page = await s.request("thread/turns/list", { threadId, itemsView: "full", sortDirection: "asc", limit: 20 });
const turns = page.data;
for (const t of turns) console.log(`  turn ${t.id} ${t.status}: ${t.items.map((i) => i.type).join(", ")}`);

const st = await runTurn(s, () =>
  s.request("turn/start", {
    threadId,
    input: [text("Earlier in this conversation you created a file. What is its exact filename? Reply with just the filename, nothing else. Do not run any tools.")],
    model,
    effort,
    serviceTierForTurn: "default",
  }),
);
printStats("resume turn", st);
const remembered = (st.finalMessage ?? "").includes(state.createdFile ?? "blue-spike.txt");

recordCheck(
  "8a-resume",
  remembered && turns.length >= 1 && st.completed?.status === "completed",
  `processo precedente ucciso con SIGKILL; nuovo app-server → thread/resume ${threadId}: ${turns.length} turni ripristinati, ` +
    `approvalPolicy dopo resume=${JSON.stringify(resumed.approvalPolicy)}, risposta="${st.finalMessage}"`,
);
recordCheck(
  "8b-thread-list",
  Boolean(byKind["appServer"] || byKind["vscode"] || byDefault),
  `con cwd: default sourceKinds → ${byDefault ? "trovato" : "non trovato"}; ${Object.entries(byKind).map(([k, v]) => `${k} → ${v ? "trovato" : "non trovato"}`).join("; ")}; ` +
    `searchTerm → ${bySearch ? "trovato" : "non trovato"}; source registrato=${JSON.stringify(byDefault?.source ?? read.thread.source)}`,
);

console.log(`\nall methods received: ${JSON.stringify(Object.fromEntries(s.counts))}`);
await s.close();
