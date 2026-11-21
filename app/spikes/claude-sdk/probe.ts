// S2 spike, side probes: (a) claude.ai connectors with/without disableClaudeAiConnectors, (b) effort mid-session.
// Usage: node probe.ts            (connectors disabled, as in run.ts)
//        CONNECTORS=1 node probe.ts  (default CLI behaviour, connectors loaded)
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { baseOptions, InputQueue, JsonlLog, makeTestRepo } from "./lib.ts";

const log = new JsonlLog("probe");
const input = new InputQueue();
const opts = baseOptions(makeTestRepo());
if (process.env.CONNECTORS) delete opts.settings;
const q = query({ prompt: input, options: { ...opts, effort: "medium" } });

const inits: Array<Record<string, unknown>> = [];
let results = 0;
const steps: Array<() => Promise<void>> = [
  async () => { await q.applyFlagSettings({ effortLevel: "high" }); input.push("Reply with exactly: ok"); },
  async () => { await q.setModel("sonnet"); input.push("Reply with exactly: ok"); },
  async () => { input.close(); },
];
input.push("Reply with exactly: ok");
for await (const m of q as AsyncIterable<SDKMessage>) {
  log.write("msg", m);
  if (m.type === "system" && m.subtype === "init") {
    const i = m as Record<string, unknown>;
    inits.push(i);
    log.note(`init: model=${i.model} effort=${JSON.stringify(i.effort)} per_turn_effort_active=${i.per_turn_effort_active} tools=${(i.tools as string[]).length} mcp=${JSON.stringify((i.mcp_servers as Array<{ name: string; status: string }>).map((s) => `${s.name}:${s.status}`))}`);
  }
  if (m.type === "result") {
    log.note(`result ${results + 1}: ${m.subtype}`);
    await steps[results++]?.();
  }
}
const init = await q.initializationResult().catch(() => null);
log.write("initializationResult", init);
log.note(`initializationResult keys: ${init ? Object.keys(init).join(",") : "n/a"}`);
