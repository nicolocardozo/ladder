// Criterio 7 (e parte del 6): thread effimero; latenza del primo delta su un turno semplice,
// turn/steer durante un turno attivo, turn/interrupt su un comando lungo, turno successivo.
import { execFileSync } from "node:child_process";

import { RpcRequestError } from "./client.ts";
import { makeTempRepo, printStats, readState, recordCheck, runTurn, startServer, text } from "./util.ts";

const { model, effort } = readState();
if (!model || !effort) throw new Error("run `npm run probe` first (model selection)");

const repo = makeTempRepo("steer");
const s = await startServer({ logName: "steer" });
s.setRequestHandler((req) => ({ error: { code: -32601, message: `unexpected ${req.method}` } }));

const { thread } = await s.request("thread/start", {
  model,
  cwd: repo,
  approvalPolicy: "never", // niente approvazioni: qui interessano steer e interrupt
  sandbox: "workspace-write",
  ephemeral: true,
  serviceName: "blue-spike",
  config: { "tools.update_plan.enabled": true },
});
const threadId = thread.id;
console.log(`ephemeral thread ${threadId} (ephemeral=${thread.ephemeral}, path=${thread.path})`);
const turnOpts = { model, effort, serviceTierForTurn: "default" } as const;

// ---- Turno A: latenza del primo delta su una risposta semplice --------------------------------
const a = await runTurn(s, () => s.request("turn/start", { threadId, input: [text("Reply with exactly the word: ready")], ...turnOpts, summary: "detailed" }));
printStats("A (latency)", a);

// ---- Turno A2: ragionamento visibile (con low i summary sono rari; qui medium + detailed) ------
const a2 = await runTurn(s, () =>
  s.request("turn/start", {
    threadId,
    input: [text("Think it through step by step before answering: a train leaves at 14:35 and the trip takes 2 h 47 min. What time does it arrive? Reply with only the time.")],
    ...turnOpts,
    effort: "medium",
    summary: "detailed",
  }),
);
printStats("A2 (reasoning, effort medium)", a2);

// ---- Turno B: steer durante il turno attivo --------------------------------------------------
let steerResult = "";
let steerSent = false;
let wrongIdError = "";
const b = await runTurn(
  s,
  () =>
    s.request("turn/start", {
      threadId,
      input: [text("Write a numbered list of 40 different fruits, one per line, with a short description of each. Nothing else.")],
      ...turnOpts,
    }),
  {
    onEvent: (n, turnId) => {
      if (n.method === "item/agentMessage/delta" && !steerSent) {
        steerSent = true;
        void (async () => {
          // Precondizione sbagliata: deve fallire.
          try {
            await s.request("turn/steer", { threadId, expectedTurnId: "00000000-0000-0000-0000-000000000000", input: [text("ignored")] });
            wrongIdError = "accepted?!";
          } catch (e) {
            wrongIdError = e instanceof RpcRequestError ? `${e.rpc.code} ${e.rpc.message}` : String(e);
          }
          try {
            const r = await s.request("turn/steer", {
              threadId,
              expectedTurnId: turnId,
              input: [text("Change of plan: stop the list immediately. Your final reply must be only the word STEERED.")],
            });
            steerResult = `ok turnId=${r.turnId} (same=${r.turnId === turnId})`;
          } catch (e) {
            steerResult = `error ${e}`;
          }
          console.log(`  steer sent during active turn → ${steerResult}; wrong expectedTurnId → ${wrongIdError}`);
        })();
      }
    },
  },
);
printStats("B (steer)", b);
const steered = /STEERED/.test(b.finalMessage ?? "") || /STEERED/.test(b.agentText);
const fruitLines = (b.agentText.match(/^\s*\d+\./gm) ?? []).length;
console.log(`  numbered lines streamed before stop: ${fruitLines}/40; STEERED in output: ${steered}`);

// ---- Turno C: interrupt su un comando lungo con output progressivo ----------------------------
let interruptAt = 0;
let interruptSent = false;
let outputDeltas = 0;
const c = await runTurn(
  s,
  () =>
    s.request("turn/start", {
      threadId,
      input: [text("Run this exact shell command and wait for it to finish: `for i in $(seq 1 60); do echo tick $i; sleep 1; done`. Then say done.")],
      ...turnOpts,
    }),
  {
    onEvent: (n, turnId) => {
      if (n.method === "item/commandExecution/outputDelta") {
        outputDeltas++;
        process.stdout.write(`  out: ${JSON.stringify(n.params.delta)}\n`);
      }
      const longRunning = n.method === "item/commandExecution/outputDelta" && outputDeltas >= 3;
      const startedCmd = n.method === "item/started" && n.params.item.type === "commandExecution";
      if (!interruptSent && (longRunning || startedCmd)) {
        interruptSent = true;
        // Dopo l'avvio del comando aspetta qualche secondo di output, poi interrompe.
        setTimeout(() => {
          interruptAt = Date.now();
          void s.request("turn/interrupt", { threadId, turnId }).then(
            (r) => console.log(`  turn/interrupt → ${JSON.stringify(r)}`),
            (e) => console.log(`  turn/interrupt error ${e}`),
          );
        }, longRunning ? 0 : 4000);
      }
    },
    timeoutMs: 120_000,
  },
);
printStats("C (interrupt)", c);
const interruptLatency = interruptAt ? Date.now() - interruptAt : -1;
const pgrep = () => {
  try {
    return execFileSync("pgrep", ["-f", "seq 1 60"]).toString().trim().split("\n").join(",");
  } catch {
    return "";
  }
};
await new Promise((r) => setTimeout(r, 2000));
const leftover = pgrep();
console.log(`  interrupt → turn/completed in ≤${interruptLatency} ms; processes still running 2 s after interrupt: ${leftover || "none"}`);
let lateDeltas = 0;
s.on("item/commandExecution/outputDelta", (p) => {
  if (p.turnId === c.turnId) lateDeltas++;
});

// ---- Turno D: il thread funziona ancora dopo l'interrupt ---------------------------------------
const d = await runTurn(s, () => s.request("turn/start", { threadId, input: [text("Reply with exactly: after-interrupt-ok")], ...turnOpts }));
printStats("D (after interrupt)", d);

// Steer senza turno attivo: deve fallire.
let idleSteer = "";
try {
  await s.request("turn/steer", { threadId, expectedTurnId: d.turnId, input: [text("late")] });
  idleSteer = "accepted?!";
} catch (e) {
  idleSteer = e instanceof RpcRequestError ? `${e.rpc.code} ${e.rpc.message}` : String(e);
}
console.log(`  steer with no active turn → ${idleSteer}`);

recordCheck(
  "6b-first-delta",
  a.firstAgentDeltaMs !== null,
  `turno semplice: primo item/agentMessage/delta dopo ${a.firstAgentDeltaMs} ms, completato in ${a.durationMs} ms; ` +
    `outputDelta su comando lungo=${c.counts["item/commandExecution/outputDelta"] ?? 0}; reasoning summary deltas (A,A2,B,C,D)=${[a, a2, b, c, d].map((t) => t.counts["item/reasoning/summaryTextDelta"] ?? 0).join(",")} ` +
    `(A2 effort medium: ${a2.counts["item/reasoning/summaryTextDelta"] ?? 0} summary, ${a2.counts["item/reasoning/textDelta"] ?? 0} raw, risposta ${JSON.stringify(a2.finalMessage)})`,
);
recordCheck(
  "7a-steer",
  steerResult.startsWith("ok") && steered && b.completed?.status === "completed",
  `turn/steer con expectedTurnId → ${steerResult}; output contiene STEERED=${steered} (righe di elenco prima dello stop: ${fruitLines}/40); ` +
    `expectedTurnId sbagliato → ${wrongIdError}; steer senza turno attivo → ${idleSteer}; nessun nuovo turn/started (turn/started=${b.counts["turn/started"] ?? 0})`,
);
recordCheck(
  "7b-interrupt",
  c.completed?.status === "interrupted" && d.completed?.status === "completed" && /after-interrupt-ok/.test(d.finalMessage ?? ""),
  `turn/interrupt durante il comando → status=${c.completed?.status} (≤${interruptLatency} ms), comando: ${c.items.filter((i) => i.type === "commandExecution").map((i) => i.status).join(",") || "n/a"}; ` +
    `processo ancora vivo 2 s dopo: ${leftover ? "sì" : "no"}; turno successivo → ${d.completed?.status} "${d.finalMessage}"`,
);

console.log(`  outputDelta of the interrupted turn received after turn/completed: ${lateDeltas}`);
console.log(`\nall methods received: ${JSON.stringify(Object.fromEntries(s.counts))}`);
await s.close();
const afterClose = pgrep();
console.log(`processes still running after app-server exit: ${afterClose || "none"}`);
recordCheck("7c-interrupt-cleanup", !afterClose, `dopo interrupt il comando resta vivo (${leftover ? "sì" : "no"}) e manda ancora outputDelta (${lateDeltas}); alla chiusura dell'app-server: ${afterClose ? "ancora vivo" : "terminato"}`);
