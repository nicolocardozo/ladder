// S2 spike, criterion 7: resume a session in a NEW node process, then open it from the CLI.
// Reads results/last-session.json written by run.ts (or kill.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { assistantText, baseOptions, cleanEnv, InputQueue, JsonlLog, LAST_SESSION_FILE, MODEL } from "./lib.ts";

const last = JSON.parse(fs.readFileSync(LAST_SESSION_FILE, "utf8")) as { sessionId: string; cwd: string; kind?: string; childPids?: number[] };
const log = new JsonlLog("resume");
const results: Record<string, { pass: boolean | null; evidence: string }> = {};
const record = (id: string, pass: boolean | null, evidence: string) => {
  results[id] = { pass, evidence };
  log.note(`${pass === null ? "INFO" : pass ? "PASS" : "FAIL"} ${id}: ${evidence}`);
};
log.note(`resuming ${last.sessionId} (${last.kind ?? "run"}) in ${last.cwd}`);

// Was the previous claude child left running after its parent died? (kill.ts only)
if (last.childPids?.length) {
  const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const killedAt = Date.parse((last as { at?: string }).at ?? "");
  const aliveAtStart = last.childPids.filter(isAlive);
  // Wait (max 90 s) for the orphan to exit on its own, so the resume below does not race it on the transcript.
  const t = Date.now();
  while (last.childPids.some(isAlive) && Date.now() - t < 90_000) await new Promise((r) => setTimeout(r, 250));
  const still = last.childPids.filter(isAlive);
  record("7.orphans", still.length === 0, `children alive when resume started (${Math.round((t - killedAt) / 100) / 10}s after parent SIGKILL): ${JSON.stringify(aliveAtStart)}; all gone ~${Math.round((Date.now() - killedAt) / 100) / 10}s after the kill; still alive after 90s wait: ${JSON.stringify(still)}`);
}

// Transcript on disk (only existence and size; contents stay where they are).
const projDir = path.join(os.homedir(), ".claude", "projects", last.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
const transcript = path.join(projDir, `${last.sessionId}.jsonl`);
const linesBefore = fs.existsSync(transcript) ? fs.readFileSync(transcript, "utf8").split("\n").length - 1 : -1;
record("7.transcript", linesBefore > 0, `${path.relative(os.homedir(), transcript)} exists=${linesBefore > 0}, lines=${linesBefore}`);

const question = process.env.RESUME_PROMPT ?? "Which files did you create with the Write tool earlier in this conversation? Answer with the file names only, comma separated.";

// ---- A: SDK resume in this new process (streaming input, like Blue would do) ----
const input = new InputQueue();
const q = query({
  prompt: input,
  options: { ...baseOptions(last.cwd), resume: last.sessionId, canUseTool: async () => ({ behavior: "deny", message: "No tools in this test." }) },
});
let init: Record<string, unknown> | null = null;
let text = "";
let result: SDKResultMessage | null = null;
input.push(question);
const t0 = Date.now();
for await (const m of q as AsyncIterable<SDKMessage>) {
  log.write("msg", m);
  if (m.type === "system" && m.subtype === "init" && !init) init = m as Record<string, unknown>;
  if (m.type === "assistant") text += assistantText(m);
  if (m.type === "result") {
    result = m;
    input.close();
  }
}
const expected = last.kind === "kill" ? /a\.txt/i : /notes\.txt/i;
record(
  "7.sdk-resume",
  result?.subtype === "success" && expected.test(text),
  `new process, resume=${last.sessionId}: init.session_id=${init?.session_id} (same=${init?.session_id === last.sessionId}), result.session_id=${result?.session_id}, ${Date.now() - t0}ms, answer=${JSON.stringify(text.trim())}`,
);

// ---- B: same session from the installed CLI ----
const bin = process.env.CLAUDE_BIN ?? path.join(os.homedir(), ".local", "bin", "claude");
const resumeId = result?.session_id ?? last.sessionId;
const cliPrompt = "In one line: which files did you create with the Write tool in this conversation, and how many times did I ask you which files you created?";
const cli = spawnSync(bin, ["--resume", resumeId, "-p", cliPrompt, "--model", MODEL, "--output-format", "json", "--setting-sources", "", "--settings", JSON.stringify({ disableClaudeAiConnectors: true })], {
  cwd: last.cwd,
  env: cleanEnv() as NodeJS.ProcessEnv,
  encoding: "utf8",
  timeout: 120_000,
});
log.write("cli", { status: cli.status, stdout: cli.stdout, stderr: cli.stderr });
let cliOut: Record<string, unknown> = {};
try { cliOut = JSON.parse(cli.stdout); } catch {}
const cliText = String(cliOut.result ?? cli.stdout ?? "");
const version = spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout.trim();
record(
  "7.cli-resume",
  cli.status === 0 && expected.test(cliText),
  `${version}: claude --resume ${resumeId} -p … → exit ${cli.status}, session_id=${cliOut.session_id} (same=${cliOut.session_id === resumeId}), answer=${JSON.stringify(cliText.trim().slice(0, 200))}${cli.stderr ? `, stderr=${JSON.stringify(cli.stderr.slice(0, 200))}` : ""}`,
);
const linesAfter = fs.existsSync(transcript) ? fs.readFileSync(transcript, "utf8").split("\n").length - 1 : -1;
record("7.transcript-after", null, `transcript lines ${linesBefore} → ${linesAfter} after SDK + CLI resume (same file)`);

console.log("\n=== results ===");
for (const [k, v] of Object.entries(results)) console.log(`${v.pass === null ? "INFO" : v.pass ? "PASS" : "FAIL"}  ${k}  ${v.evidence}`);
console.log(`\nlog: ${log.file}`);
