// S2 spike, main scenario: one query() with streaming input, many turns, in one process.
// Covers criteria 1-6, 8, 9. Writes results/run-*.jsonl, results/summary-*.json, results/last-session.json.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, PermissionResult, SDKMessage, SDKResultMessage, Query } from "@anthropic-ai/claude-agent-sdk";
import { baseOptions, Census, cleanEnv, InputQueue, JsonlLog, LAST_SESSION_FILE, makeTestRepo, MODEL, RESULTS_DIR, sleep, assistantText } from "./lib.ts";

const HOLD_MS = Number(process.env.HOLD_MS ?? 65_000);
const ONLY = process.env.ONLY?.split(",") ?? null; // e.g. ONLY=stream,approvals
const want = (step: string) => !ONLY || ONLY.includes(step);

const log = new JsonlLog("run");
const census = new Census();
const input = new InputQueue();
const cwd = makeTestRepo();
const results: Record<string, { pass: boolean | null; evidence: string }> = {};
const record = (id: string, pass: boolean | null, evidence: string) => {
  results[id] = { pass, evidence };
  log.note(`${pass === null ? "INFO" : pass ? "PASS" : "FAIL"} ${id}: ${evidence}`);
};

// ---- permission policy, swapped per step ----
type Policy = (toolName: string, input: Record<string, unknown>, opts: Parameters<CanUseTool>[2]) => Promise<PermissionResult>;
const allowAll: Policy = async (_t, inp) => ({ behavior: "allow", updatedInput: inp });
let policy: Policy = allowAll;
const preToolUse: Array<{ t: number; tool: string; toolUseID: string }> = [];
const permissionCalls: Array<{ t: number; tool: string; toolUseID: string; decision?: string }> = [];

const canUseTool: CanUseTool = async (toolName, toolInput, opts) => {
  const entry = { t: log.now(), tool: toolName, toolUseID: opts.toolUseID } as (typeof permissionCalls)[number];
  permissionCalls.push(entry);
  log.write("canUseTool.call", {
    toolName,
    input: toolInput,
    toolUseID: opts.toolUseID,
    title: opts.title,
    displayName: opts.displayName,
    description: opts.description,
    decisionReason: opts.decisionReason,
    blockedPath: opts.blockedPath,
    suggestions: opts.suggestions,
    agentID: opts.agentID,
    requestId: (opts as Record<string, unknown>).requestId,
  });
  log.note(`canUseTool(${toolName}) ${opts.title ?? ""}`);
  const res = await policy(toolName, toolInput, opts);
  entry.decision = res.behavior;
  log.write("canUseTool.result", { toolName, toolUseID: opts.toolUseID, result: res, aborted: opts.signal.aborted });
  return res;
};

// ---- the query ----
const q: Query = query({
  prompt: input,
  options: {
    ...baseOptions(cwd),
    canUseTool,
    // Audit hook: sees every tool call, including the ones auto-allowed without canUseTool.
    hooks: {
      PreToolUse: [{ hooks: [async (h) => {
        const hi = h as { tool_name?: string; tool_use_id?: string };
        preToolUse.push({ t: log.now(), tool: String(hi.tool_name), toolUseID: String(hi.tool_use_id) });
        log.write("hook.PreToolUse", h);
        return {};
      }] }],
    },
    stderr: (d) => log.write("stderr", d),
  },
});
log.note(`cwd=${cwd} model=${MODEL} droppedEnv=${cleanEnv.dropped.length} vars`);
log.write("env.dropped", cleanEnv.dropped);

// ---- message pump with waiters ----
type Waiter = { pred: (m: SDKMessage) => boolean; resolve: (m: SDKMessage) => void };
const waiters: Waiter[] = [];
const listeners: Array<(m: SDKMessage) => void> = [];
let sessionId = "";
let initMsg: SDKMessage | null = null;
let ended = false;

const pump = (async () => {
  try {
    for await (const m of q) {
      log.write("msg", m);
      census.add(m);
      if (m.type === "system" && m.subtype === "init") {
        initMsg = m;
        sessionId = m.session_id;
      }
      for (const l of listeners) l(m);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(m)) waiters.splice(i, 1)[0].resolve(m);
      }
    }
  } catch (e) {
    log.note(`pump error: ${(e as Error).message}`);
  } finally {
    ended = true;
    log.note("query generator ended");
  }
})();

function waitFor<T extends SDKMessage>(pred: (m: SDKMessage) => boolean, timeoutMs = 180_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m as T)) });
  });
}
const nextResult = (timeoutMs?: number) => waitFor<SDKResultMessage>((m) => m.type === "result", timeoutMs);

/** Sends one user turn and collects stats until its result. */
async function turn(label: string, text: string, timeoutMs?: number) {
  const stats = { label, sentAt: log.now(), firstDeltaMs: -1, textDeltas: 0, assistantText: "", types: [] as string[], result: null as SDKResultMessage | null };
  const l = (m: SDKMessage) => {
    stats.types.push(m.type === "system" ? `system/${m.subtype}` : m.type);
    if (m.type === "stream_event" && m.event.type === "content_block_delta" && m.event.delta.type === "text_delta") {
      stats.textDeltas++;
      if (stats.firstDeltaMs < 0) stats.firstDeltaMs = log.now() - stats.sentAt;
    }
    if (m.type === "assistant" && m.parent_tool_use_id === null) stats.assistantText += assistantText(m);
  };
  listeners.push(l);
  const done = nextResult(timeoutMs);
  log.note(`>> [${label}] ${text}`);
  input.push(text);
  try {
    stats.result = await done;
  } finally {
    listeners.splice(listeners.indexOf(l), 1);
  }
  const r = stats.result;
  log.note(`<< [${label}] ${r.subtype} in ${log.now() - stats.sentAt}ms, deltas=${stats.textDeltas}, ttfd=${stats.firstDeltaMs}ms: ${JSON.stringify(stats.assistantText.slice(0, 160))}`);
  log.write("turn.stats", { ...stats, types: undefined, typeCounts: countBy(stats.types) });
  return stats;
}
const countBy = (xs: string[]) => xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});

// ================= scenario =================
async function main() {
  // --- 1 + 2: multi-turn streaming input, partial messages ---
  if (want("stream")) {
    const t1 = await turn("t1", "Count from one to twelve in English words, one per line. No other text.");
    const init = initMsg as Record<string, unknown> | null;
    record("9.auth", init?.apiKeySource === "none", `init.apiKeySource=${init?.apiKeySource}, model=${init?.model}, permissionMode=${init?.permissionMode}, claude_code_version=${init?.claude_code_version}`);
    record("2.streaming", t1.textDeltas > 1, `${t1.textDeltas} text_delta, time to first delta ${t1.firstDeltaMs}ms (result.ttft_ms=${(t1.result as any)?.ttft_ms})`);
    const t2 = await turn("t2", "What was the last word you wrote in your previous reply? Answer with that one word only.");
    record("1.multiturn", t1.result?.subtype === "success" && /twelve/i.test(t2.assistantText), `same session ${t2.result?.session_id === sessionId}, t2 answer=${JSON.stringify(t2.assistantText.trim())}`);

    try {
      const acct = await q.accountInfo();
      log.write("accountInfo", acct);
      record("9.account", null, `accountInfo: subscriptionType=${acct.subscriptionType}, tokenSource=${acct.tokenSource}, apiKeySource=${acct.apiKeySource}, apiProvider=${acct.apiProvider}`);
    } catch (e) {
      record("9.account", null, `accountInfo() failed: ${(e as Error).message}`);
    }
  }

  // --- 3: approvals with deny + retry + long pending promise ---
  if (want("approvals")) {
    let bashCalls = 0;
    let holdObserved = { start: 0, end: 0, msgsDuring: [] as string[] };
    const holdListener = (m: SDKMessage) => {
      if (holdObserved.start && !holdObserved.end) holdObserved.msgsDuring.push(m.type === "system" ? `system/${m.subtype}` : m.type);
    };
    listeners.push(holdListener);
    policy = async (tool, inp, opts) => {
      if (tool === "Write") {
        holdObserved.start = log.now();
        log.note(`holding Write approval for ${HOLD_MS}ms`);
        await sleep(HOLD_MS);
        holdObserved.end = log.now();
        log.note(`releasing Write approval (signal.aborted=${opts.signal.aborted})`);
        return { behavior: "allow", updatedInput: inp };
      }
      if (tool === "Bash") {
        bashCalls++;
        if (bashCalls === 1) return { behavior: "deny", message: "The user denied this first attempt on purpose (test). Please retry the exact same command once." };
        return { behavior: "allow", updatedInput: inp };
      }
      return { behavior: "allow", updatedInput: inp };
    };
    const t3 = await turn(
      "t3",
      "Use the Write tool to create notes.txt containing the single line: hello blue. Then use the Bash tool to run: git add notes.txt && git status --short. Finally reply with the command output.",
      HOLD_MS + 180_000,
    );
    listeners.splice(listeners.indexOf(holdListener), 1);
    policy = allowAll;
    const fileOk = fs.existsSync(path.join(cwd, "notes.txt")) && fs.readFileSync(path.join(cwd, "notes.txt"), "utf8").includes("hello blue");
    const staged = execSync("git diff --cached --name-only", { cwd }).toString().trim();
    const calls = permissionCalls.filter((c) => c.t >= t3.sentAt).map((c) => `${c.tool}:${c.decision}`);
    record("3.approvals", fileOk && bashCalls >= 2 && staged === "notes.txt" && t3.result?.subtype === "success", `canUseTool sequence ${calls.join(" → ")}; file written=${fileOk}; staged=${JSON.stringify(staged)}; permission_denials in result=${JSON.stringify(t3.result?.permission_denials)}; reply=${JSON.stringify(t3.assistantText.trim().slice(0, 80))}`);
    record("3.hold", holdObserved.end - holdObserved.start >= 60_000 && t3.result?.subtype === "success", `Write approval pending ${holdObserved.end - holdObserved.start}ms; messages during hold: ${JSON.stringify(countBy(holdObserved.msgsDuring))}; turn finished ${t3.result?.subtype}`);
  }

  // --- 4: AskUserQuestion answered via canUseTool ---
  if (want("question")) {
    let asked: unknown = null;
    policy = async (tool, inp) => {
      if (tool === "AskUserQuestion") {
        asked = inp;
        const qs = (inp.questions ?? []) as Array<{ question: string; options: Array<{ label: string }> }>;
        const answers: Record<string, string> = {};
        for (const qq of qs) answers[qq.question] = qq.options.find((o) => /green/i.test(o.label))?.label ?? qq.options[1]?.label ?? qq.options[0].label;
        log.note(`answering AskUserQuestion: ${JSON.stringify(answers)}`);
        return { behavior: "allow", updatedInput: { ...inp, answers } };
      }
      return { behavior: "allow", updatedInput: inp };
    };
    const t4 = await turn("t4", "Before doing anything else, use the AskUserQuestion tool to ask me one multiple-choice question: which color I prefer, with options Red, Green and Blue. After I answer, reply with only the chosen color name in uppercase.");
    policy = allowAll;
    log.write("question.input", asked);
    record("4.question", asked !== null && /GREEN/.test(t4.assistantText), `AskUserQuestion via canUseTool=${asked !== null}; reply=${JSON.stringify(t4.assistantText.trim())}`);
  }

  // --- 5: mid-session controls ---
  if (want("controls")) {
    const models = await q.supportedModels();
    log.write("supportedModels", models);
    record("5.supportedModels", models.length > 0, models.map((m) => `${m.value}${m.resolvedModel ? `→${m.resolvedModel}` : ""} "${m.displayName}" effort=${m.supportsEffort ? (m.supportedEffortLevels ?? []).join("/") : "no"}`).join("; "));

    await q.setPermissionMode("acceptEdits");
    const before = permissionCalls.length;
    const t5 = await turn("t5", "Use the Write tool to create edits.txt containing: auto. Reply with: written.");
    const writeAsked = permissionCalls.slice(before).some((c) => c.tool === "Write");
    record("5.setPermissionMode", fs.existsSync(path.join(cwd, "edits.txt")) && !writeAsked, `after setPermissionMode('acceptEdits') Write ran without canUseTool (asked=${writeAsked}); status msgs: ${t5.types.filter((x) => x.startsWith("system/")).join(",")}`);

    const target = process.env.SWITCH_MODEL ?? "sonnet";
    await q.setModel(target);
    const modelSeen: string[] = [];
    const ml = (m: SDKMessage) => m.type === "assistant" && modelSeen.push(m.message.model);
    listeners.push(ml);
    const t6 = await turn("t6", "Reply with exactly: ok");
    listeners.splice(listeners.indexOf(ml), 1);
    record("5.setModel", modelSeen.some((x) => x.includes(target)), `setModel('${target}') → assistant.message.model=${[...new Set(modelSeen)].join(",")}; modelUsage keys=${Object.keys(t6.result?.modelUsage ?? {}).join(",")}`);

    // effort: there is no setEffort(); try applyFlagSettings({ effortLevel }) and watch for a re-emitted init/effort.
    try {
      await q.applyFlagSettings({ effortLevel: "low" });
      const efforts: unknown[] = [];
      const el = (m: SDKMessage) => m.type === "system" && m.subtype === "init" && efforts.push((m as any).effort);
      listeners.push(el);
      const t7 = await turn("t7", "Reply with exactly: ok");
      listeners.splice(listeners.indexOf(el), 1);
      record("5.effort", null, `applyFlagSettings({effortLevel:'low'}) accepted; init.effort seen in next turn=${JSON.stringify(efforts)}; result=${t7.result?.subtype}`);
    } catch (e) {
      record("5.effort", null, `applyFlagSettings({effortLevel}) rejected: ${(e as Error).message}`);
    }
    await q.setModel(MODEL);
    await q.applyFlagSettings({ effortLevel: null });
  }

  // --- 6a: interrupt while the model is streaming text ---
  if (want("interrupt")) {
    {
      const types: string[] = [];
      let deltas = 0, deltasAfter = 0, tInt = 0, resultAt = 0;
      let res: SDKResultMessage | null = null;
      const il = (m: SDKMessage) => {
        types.push(m.type === "system" ? `system/${m.subtype}` : m.type);
        if (m.type === "stream_event" && m.event.type === "content_block_delta" && m.event.delta.type === "text_delta") (tInt ? deltasAfter++ : deltas++);
        if (m.type === "result" && !res) (res = m, resultAt = log.now());
      };
      listeners.push(il);
      log.note(">> [t8a] long text, interrupt after 15 deltas");
      input.push("Write a 400-word story about a lighthouse keeper. Plain prose.");
      const deadline = Date.now() + 60_000;
      while (deltas < 15 && !res && Date.now() < deadline) await sleep(20);
      tInt = log.now();
      const receipt = await q.interrupt();
      log.write("interrupt.receipt", receipt ?? null);
      while (!res && Date.now() < deadline + 30_000) await sleep(50);
      listeners.splice(listeners.indexOf(il), 1);
      const r = res as SDKResultMessage | null;
      log.write("turn.stats", { label: "t8a", typeCounts: countBy(types), result: r });
      record("6a.interrupt-text", !!r && resultAt >= tInt, `interrupt() after ${deltas} deltas → result ${r?.subtype} is_error=${r?.is_error} terminal_reason=${(r as any)?.terminal_reason} stop_reason=${r?.stop_reason} in ${resultAt - tInt}ms; deltas after interrupt=${deltasAfter}; receipt=${JSON.stringify(receipt)}`);
    }

    // --- 6b: interrupt while a Bash command is running ---
    const TOOL_WAIT = Number(process.env.TOOL_WAIT_MS ?? 32_000);
    const types: string[] = [];
    let toolSeenAt = 0, tInt = 0, resultAt = 0;
    let res: SDKResultMessage | null = null;
    const il = (m: SDKMessage) => {
      types.push(m.type === "system" ? `system/${m.subtype}` : m.type);
      if (m.type === "assistant" && (m.message.content as Array<{ type: string; name?: string }>).some((b) => b.type === "tool_use" && b.name === "Bash")) toolSeenAt ||= log.now();
      if (m.type === "result" && !res) (res = m, resultAt = log.now());
    };
    listeners.push(il);
    // Random marker so pgrep only matches this run's command (not leftovers, not the parent shell).
    const marker = `done-${Math.random().toString(36).slice(2, 10)}`;
    log.note(`>> [t8b] long-running Bash (node timer 60s, marker ${marker})`);
    input.push(`Use the Bash tool to run exactly this command, in the foreground: node -e "setTimeout(() => console.log('${marker}'), 60000)". Then reply with its output.`);
    const deadline = Date.now() + 60_000;
    while (!toolSeenAt && !res && Date.now() < deadline) await sleep(100);
    await sleep(TOOL_WAIT); // let the command run (and see if tool_progress arrives)
    // pgrep exits 1 when nothing matches; execFileSync avoids a shell whose own argv would match.
    const pg = () => { try { return execFileSync("pgrep", ["-f", marker]).toString().trim().split("\n").filter(Boolean).length; } catch { return 0; } };
    const before = pg();
    tInt = log.now();
    const receipt = res ? null : await q.interrupt();
    log.write("interrupt.receipt", receipt ?? null);
    while (!res && Date.now() < deadline + 60_000) await sleep(50);
    listeners.splice(listeners.indexOf(il), 1);
    // Poll until the command's processes are gone (or 15 s), and log what is left.
    let after = pg(), goneAfterMs = -1;
    const pollEnd = Date.now() + 15_000;
    while (after > 0 && Date.now() < pollEnd) {
      try { log.write("interrupt.leftover", execFileSync("ps", ["-o", "pid,ppid,etime,command", "-p", execFileSync("pgrep", ["-f", marker]).toString().trim().split("\n").join(",")]).toString()); } catch {}
      await sleep(250);
      after = pg();
    }
    if (after === 0) goneAfterMs = log.now() - tInt;
    const r = res as SDKResultMessage | null;
    log.write("turn.stats", { label: "t8b", typeCounts: countBy(types), result: r });
    const t9 = await turn("t9", "Reply with exactly: still here");
    record("6b.interrupt-tool", !!r && resultAt >= tInt && before > 0 && after === 0 && /still here/i.test(t9.assistantText), `Bash running ${tInt - toolSeenAt}ms, processes before=${before}, after=${after} (gone ${goneAfterMs}ms after interrupt); interrupt() → result ${r?.subtype} is_error=${r?.is_error} terminal_reason=${(r as any)?.terminal_reason} in ${resultAt - tInt}ms; tool_progress msgs=${types.filter((x) => x === "tool_progress").length}; next turn: ${JSON.stringify(t9.assistantText.trim())}`);
  }

  // --- end of session: close input, let the CLI exit ---
  fs.writeFileSync(LAST_SESSION_FILE, JSON.stringify({ sessionId, cwd, model: MODEL, at: new Date().toISOString() }, null, 2));
  log.note(`session_id=${sessionId} saved to ${path.relative(process.cwd(), LAST_SESSION_FILE)}`);
  input.close();
  const t = Date.now();
  while (!ended && Date.now() - t < 15_000) await sleep(100);
  if (!ended) {
    log.note("generator still open 15s after input close → q.close()");
    q.close();
  }
  await pump;
}

try {
  await main();
} catch (e) {
  log.note(`scenario error: ${(e as Error).stack}`);
  q.close();
} finally {
  const summary = { cwd, sessionId, model: MODEL, results, census: census.toJSON(), permissionCalls, preToolUse, log: log.file };
  const out = path.join(RESULTS_DIR, path.basename(log.file).replace(/^run-/, "summary-").replace(/\.jsonl$/, ".json"));
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log("\n=== results ===");
  for (const [k, v] of Object.entries(results)) console.log(`${v.pass === null ? "INFO" : v.pass ? "PASS" : "FAIL"}  ${k}  ${v.evidence}`);
  console.log("\n=== message types ===");
  for (const [k, v] of Object.entries(census.toJSON())) console.log(`${String(v.count).padStart(5)}  ${k}`);
  console.log(`\nlog: ${log.file}\nsummary: ${out}`);
  process.exit(0);
}
