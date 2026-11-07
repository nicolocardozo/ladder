// Criterio 10: metodi distinti osservati nei log JSONL di results/ e proposta di mappatura
// verso gli eventi normalizzati di Blue. Non avvia app-server.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { RESULTS_DIR } from "./client.ts";
import { recordCheck } from "./util.ts";

/** Mappatura proposta: metodo Codex → evento Blue (null = non inoltrato alla UI). */
const MAPPING: Record<string, string | null> = {
  "turn/started": "turn.started",
  "item/agentMessage/delta": "message.delta",
  "item/completed:agentMessage": "message.completed (phase: commentary | final_answer)",
  "item/started:agentMessage": "message.started (apre il blocco; può restare orfano dopo steer)",
  "item/started:reasoning": "reasoning (apertura)",
  "item/completed:reasoning": "reasoning (chiusura, summary[] completo)",
  "item/reasoning/summaryTextDelta": "reasoning (delta)",
  "item/reasoning/summaryPartAdded": "reasoning (nuova sezione)",
  "item/reasoning/textDelta": "reasoning (raw, se il modello lo espone)",
  "item/started:commandExecution": "tool.started (kind: command)",
  "item/completed:commandExecution": "tool.completed (status: completed | failed | declined)",
  "item/started:fileChange": "tool.started (kind: edit)",
  "item/completed:fileChange": "tool.completed (kind: edit)",
  "item/started:userMessage": null,
  "item/completed:userMessage": "message.user (eco, anche per l'input di turn/steer)",
  "item/commandExecution/outputDelta": "tool.output",
  "item/commandExecution/requestApproval": "request.opened (kind: command)",
  "item/fileChange/requestApproval": "request.opened (kind: edit)",
  "item/permissions/requestApproval": "request.opened (kind: permissions)",
  "item/tool/requestUserInput": "question.opened",
  "serverRequest/resolved": "request.resolved",
  "turn/diff/updated": "diff.updated",
  "turn/plan/updated": "plan.updated",
  "thread/tokenUsage/updated": "usage",
  "account/rateLimits/updated": "limits",
  "turn/completed": "turn.completed | turn.failed | turn.interrupted (da turn.status)",
  error: "turn.error (willRetry=true: retrying, non terminale)",
  "thread/status/changed": "session.status (activeFlags: waitingOnApproval → “Richiede te”)",
  "thread/started": "session.meta",
  "thread/name/updated": "session.meta (titolo)",
  "account/updated": "account.status",
  "mcpServer/startupStatus/updated": "diagnostics",
  deprecationNotice: "diagnostics (log)",
  warning: "diagnostics (log)",
  configWarning: "diagnostics (log)",
  "thread/settings/updated": "session.settings (modello/effort/policy effettivi; solo con experimentalApi)",
  "turn/moderationMetadata": null,
  "thread/goal/cleared": null,
  "remoteControl/status/changed": null,
};

interface LogRec {
  dir: string;
  msg: { id?: unknown; method?: string; params?: { item?: { type?: string } } };
}

const notif = new Map<string, number>();
const requests = new Map<string, number>();
const itemTypes = new Map<string, number>();
const files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".jsonl"));
for (const f of files) {
  for (const line of readFileSync(path.join(RESULTS_DIR, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as LogRec;
    if (rec.dir !== "<-" || typeof rec.msg.method !== "string") continue;
    const m = rec.msg.method;
    const isRequest = rec.msg.id !== undefined && rec.msg.id !== null;
    (isRequest ? requests : notif).set(m, ((isRequest ? requests : notif).get(m) ?? 0) + 1);
    if ((m === "item/started" || m === "item/completed") && rec.msg.params?.item?.type) {
      const k = `${m}:${rec.msg.params.item.type}`;
      itemTypes.set(k, (itemTypes.get(k) ?? 0) + 1);
    }
  }
}

const rows: { method: string; kind: string; count: number; blue: string }[] = [];
const blueFor = (k: string) => (k in MAPPING ? (MAPPING[k] ?? "— (ignorato)") : "?? da classificare");
for (const [m, n] of [...requests].sort()) rows.push({ method: m, kind: "server→client request", count: n, blue: blueFor(m) });
for (const [m, n] of [...notif].sort()) {
  if (m === "item/started" || m === "item/completed") continue;
  rows.push({ method: m, kind: "notification", count: n, blue: blueFor(m) });
}
for (const [k, n] of [...itemTypes].sort()) rows.push({ method: k, kind: "notification (item)", count: n, blue: blueFor(k) });

console.log(`log files: ${files.join(", ")}\n`);
const w = Math.max(...rows.map((r) => r.method.length));
for (const r of rows) console.log(`${r.method.padEnd(w)}  ${String(r.count).padStart(4)}  ${r.kind.padEnd(22)}  → ${r.blue}`);
writeFileSync(path.join(RESULTS_DIR, "methods.json"), JSON.stringify(rows, null, 2) + "\n");

const unmapped = rows.filter((r) => r.blue.startsWith("??"));
recordCheck(
  "10-event-mapping",
  unmapped.length === 0,
  `${notif.size} notifiche distinte, ${requests.size} tipi di richiesta dal server, ${itemTypes.size} combinazioni item/tipo; non classificati: ${unmapped.map((r) => r.method).join(", ") || "nessuno"}`,
);
