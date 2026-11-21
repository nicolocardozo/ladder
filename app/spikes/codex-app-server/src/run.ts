// Criteri 4–6: thread/start in un repo temporaneo, turno con modifica file e comandi,
// approvazioni (una accettata, una rifiutata), conteggio dello streaming.
// Alla fine uccide il processo con SIGKILL: resume.ts riparte da lì (criterio 8).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ServerRequest } from "../generated/stable/index.ts";
import type { CommandExecutionApprovalDecision, FileChangeApprovalDecision } from "../generated/stable/v2/index.ts";
import { makeTempRepo, printStats, readState, recordCheck, runTurn, startServer, text, writeState } from "./util.ts";

const state = readState();
if (!state.model || !state.effort) throw new Error("run `npm run probe` first (model selection)");
const { model, effort } = state;

const repo = makeTempRepo("run");
console.log(`temp repo: ${repo}`);

const s = await startServer({ logName: "run" });

// ---- 4. thread/start ----------------------------------------------------------------------
const started = await s.request("thread/start", {
  model,
  cwd: repo,
  approvalPolicy: "untrusted",
  sandbox: "workspace-write",
  ephemeral: false, // persistente: serve per il test di ripresa
  serviceName: "blue-spike",
  // In 0.167.0 lo strumento update_plan (→ turn/plan/updated) è spento di default.
  config: { "tools.update_plan.enabled": true },
});
const threadId = started.thread.id;
console.log(`thread/start → ${threadId} model=${started.model} effort=${started.reasoningEffort} approval=${JSON.stringify(started.approvalPolicy)} sandbox=${started.sandbox.type} cwd=${started.cwd} tier=${started.serviceTier} source=${JSON.stringify(started.thread.source)}`);
await s.request("thread/name/set", { threadId, name: "blue-spike S1 lifecycle" });
recordCheck(
  "4-thread-start",
  started.cwd === repo && started.sandbox.type === "workspaceWrite" && started.approvalPolicy === "untrusted",
  `thread ${threadId}, cwd=${started.cwd}, sandbox=${started.sandbox.type}, approvalPolicy=${JSON.stringify(started.approvalPolicy)}, model=${started.model}`,
);
writeState({ repo, threadId, createdFile: "blue-spike.txt" });

// ---- 5. Approvazioni ---------------------------------------------------------------------
interface ApprovalRecord {
  requestId: string | number;
  method: string;
  itemId: string;
  command?: string | null;
  reason?: string | null;
  decision: string;
  atMs: number;
  resolvedAtMs?: number;
}
const approvals: ApprovalRecord[] = [];
const t0 = Date.now();
let declinedOnce = false;

s.setRequestHandler((req: ServerRequest) => {
  if (req.method === "item/commandExecution/requestApproval") {
    const cmd = req.params.command ?? "";
    // Si rifiuta il primo `git add`, si accetta tutto il resto.
    const decision: CommandExecutionApprovalDecision = !declinedOnce && /git\s+add/.test(cmd) ? "decline" : "accept";
    if (decision === "decline") declinedOnce = true;
    approvals.push({ requestId: req.id, method: req.method, itemId: req.params.itemId, command: cmd, reason: req.params.reason, decision, atMs: Date.now() - t0 });
    console.log(`  ⇢ ${req.method} ${JSON.stringify(cmd)} → ${decision}`);
    return { result: { decision } };
  }
  if (req.method === "item/fileChange/requestApproval") {
    const decision: FileChangeApprovalDecision = "accept";
    approvals.push({ requestId: req.id, method: req.method, itemId: req.params.itemId, reason: req.params.reason, decision, atMs: Date.now() - t0 });
    console.log(`  ⇢ ${req.method} item=${req.params.itemId} → ${decision}`);
    return { result: { decision } };
  }
  console.log(`  ⇢ unexpected server request ${req.method}`);
  return { error: { code: -32601, message: `not supported by spike: ${req.method}` } };
});
s.on("serverRequest/resolved", (p) => {
  const a = approvals.find((x) => x.requestId === p.requestId);
  if (a) a.resolvedAtMs = Date.now() - t0;
  console.log(`  ⇠ serverRequest/resolved ${p.requestId}`);
});

const prompt = [
  "This is an automated integration test in a throwaway git repo. Follow these steps exactly, in order:",
  "1. Use your planning tool (update_plan) to record a 3-step plan for steps 2-4.",
  "2. Create a file named `blue-spike.txt` containing exactly the line `hello from blue`. Use your file editing tool (apply_patch), not the shell.",
  "3. Run the shell command `git add blue-spike.txt`. If it is declined, do not retry it and do not work around it; go on to step 4.",
  "4. Run the shell command `for i in 1 2 3; do echo tick $i; sleep 1; done`.",
  "Finally reply with one short sentence saying which steps succeeded and which were declined.",
].join("\n");

const st = await runTurn(
  s,
  () =>
    s.request("turn/start", {
      threadId,
      input: [text(prompt)],
      model,
      effort,
      summary: "detailed",
      serviceTierForTurn: "default",
    }),
  {
    onEvent: (n) => {
      if (n.method === "turn/started") console.log(`  turn/started ${n.params.turn.id}`);
      if (n.method === "turn/plan/updated") console.log(`  plan: ${n.params.plan.map((p) => `[${p.status}] ${p.step}`).join(" | ")}`);
      if (n.method === "item/commandExecution/outputDelta") process.stdout.write(`  out: ${JSON.stringify(n.params.delta)}\n`);
    },
  },
);
printStats("turn 1 (file + commands + approvals)", st);

// Richieste del server viste nel log (per la timeline completa).
const logLines = readFileSync(s.logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { t: number; dir: string; msg: Record<string, unknown> });
const ordered = logLines
  .filter((l) => l.dir === "<-" || l.dir === "->")
  .map((l) => {
    const m = l.msg;
    if (l.dir === "<-" && typeof m.method === "string" && "id" in m) return `${l.t}ms ← request ${m.method} id=${m.id}`;
    if (l.dir === "->" && !("method" in m) && "result" in m) return `${l.t}ms → reply id=${m.id} ${JSON.stringify(m.result)}`;
    if (l.dir === "<-" && m.method === "serverRequest/resolved") return `${l.t}ms ← serverRequest/resolved ${JSON.stringify((m.params as { requestId: unknown }).requestId)}`;
    if (l.dir === "<-" && (m.method === "item/started" || m.method === "item/completed")) {
      const it = (m.params as { item: { type: string; id: string; status?: string } }).item;
      if (it.type === "commandExecution" || it.type === "fileChange") return `${l.t}ms ← ${m.method} ${it.type} [${it.status}]`;
    }
    return null;
  })
  .filter(Boolean);
console.log("\napproval timeline:");
for (const l of ordered) console.log(`  ${l}`);

// ---- Verifiche sul disco ---------------------------------------------------------------
const filePath = path.join(repo, "blue-spike.txt");
const fileOk = existsSync(filePath) && readFileSync(filePath, "utf8").includes("hello from blue");
const staged = execFileSync("git", ["ls-files", "--stage", "blue-spike.txt"], { cwd: repo }).toString().trim();
console.log(`\nfile exists with content: ${fileOk}; staged in git index: ${staged ? "yes" : "no"}`);

const accepted = approvals.filter((a) => a.decision === "accept");
const declined = approvals.filter((a) => a.decision === "decline");
const resolvedAll = approvals.every((a) => a.resolvedAtMs !== undefined);
const declinedItem = declined[0] ? st.items.find((i) => i.type === "commandExecution" && i.status === "declined") : undefined;
const afterDecline = declined[0] ? approvals.some((a) => a.atMs > declined[0]!.atMs && a.decision === "accept") || st.items.some((i) => i.type === "commandExecution" && i.status === "completed") : false;
recordCheck(
  "5-approvals",
  accepted.length > 0 && declined.length > 0 && resolvedAll && fileOk && !staged && st.completed?.status === "completed" && afterDecline,
  `${approvals.length} richieste (${approvals.map((a) => `${a.method.split("/")[1]}:${a.decision}`).join(", ")}); serverRequest/resolved per tutte=${resolvedAll}; ` +
    `file creato=${fileOk}; git add rifiutato → non in index=${!staged}; item declined=${Boolean(declinedItem)}; il turno continua dopo il rifiuto=${afterDecline}; turn status=${st.completed?.status}`,
);

const c = st.counts;
const reasoning = (c["item/reasoning/summaryTextDelta"] ?? 0) + (c["item/reasoning/textDelta"] ?? 0);
recordCheck(
  "6-streaming",
  (c["item/agentMessage/delta"] ?? 0) > 0 && (c["item/commandExecution/outputDelta"] ?? 0) > 0 && (c["turn/diff/updated"] ?? 0) > 0 && (c["thread/tokenUsage/updated"] ?? 0) > 0,
  `agentMessage/delta=${c["item/agentMessage/delta"] ?? 0}, reasoning deltas=${reasoning} (summary=${c["item/reasoning/summaryTextDelta"] ?? 0}, raw=${c["item/reasoning/textDelta"] ?? 0}), ` +
    `commandExecution/outputDelta=${c["item/commandExecution/outputDelta"] ?? 0}, turn/diff/updated=${c["turn/diff/updated"] ?? 0}, turn/plan/updated=${c["turn/plan/updated"] ?? 0}, ` +
    `thread/tokenUsage/updated=${c["thread/tokenUsage/updated"] ?? 0}, account/rateLimits/updated=${s.counts.get("account/rateLimits/updated") ?? 0}; primo delta dopo ${st.firstDeltaMs} ms; turno ${st.durationMs} ms`,
);

console.log(`\nall methods received: ${JSON.stringify(Object.fromEntries(s.counts))}`);

// ---- Crash simulato: SIGKILL, senza chiusura ordinata ------------------------------------
const exit = await s.kill("SIGKILL");
console.log(`\napp-server killed: ${JSON.stringify(exit)} — now run \`npm run resume\``);
