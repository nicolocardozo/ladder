// Parte del criterio 6: con effort low gpt-6-luna quasi non produce ragionamento
// (reasoningOutputTokens = 0). Un solo turno con effort high mostra i delta di ragionamento.
import { makeTempRepo, printStats, readState, recordCheck, runTurn, startServer, text } from "./util.ts";

const { model } = readState();
if (!model) throw new Error("run `npm run probe` first (model selection)");
const s = await startServer({ logName: "reasoning" });
s.setRequestHandler((req) => ({ error: { code: -32601, message: `unexpected ${req.method}` } }));
const { thread } = await s.request("thread/start", { model, cwd: makeTempRepo("reasoning"), approvalPolicy: "never", sandbox: "read-only", ephemeral: true, serviceName: "blue-spike" });

let reasoningTokens = 0;
s.on("thread/tokenUsage/updated", (p) => (reasoningTokens = p.tokenUsage.total.reasoningOutputTokens));
const summaries: string[] = [];
s.on("item/reasoning/summaryTextDelta", (p) => summaries.push(p.delta));

const st = await runTurn(s, () =>
  s.request("turn/start", {
    threadId: thread.id,
    input: [text("Four people (A, B, C, D) sit in a row. A is not at either end. B is immediately right of C. D is not next to A. Give one valid left-to-right order, or say that none exists. Reply with only the answer. Do not run tools.")],
    model,
    effort: "high",
    summary: "detailed",
    serviceTierForTurn: "default",
  }),
);
printStats("reasoning (effort high)", st);
console.log(`  reasoning summary deltas: ${JSON.stringify(summaries)}; reasoningOutputTokens=${reasoningTokens}`);
recordCheck(
  "6c-reasoning",
  (st.counts["item/reasoning/summaryTextDelta"] ?? 0) > 0,
  `effort high: summaryPartAdded=${st.counts["item/reasoning/summaryPartAdded"] ?? 0}, summaryTextDelta=${st.counts["item/reasoning/summaryTextDelta"] ?? 0} ` +
    `(${JSON.stringify(summaries)}), textDelta raw=${st.counts["item/reasoning/textDelta"] ?? 0}, reasoningOutputTokens=${reasoningTokens}; primo delta ${st.firstDeltaMs} ms, primo testo ${st.firstAgentDeltaMs} ms`,
);
await s.close();
