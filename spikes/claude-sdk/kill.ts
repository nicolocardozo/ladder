// S2 spike, criterion 7 (hard variant): the host process dies with SIGKILL in the middle of a turn.
// Then `npm run resume` resumes the session in a new process and checks for orphaned claude children.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { baseOptions, InputQueue, JsonlLog, LAST_SESSION_FILE, makeTestRepo } from "./lib.ts";

const log = new JsonlLog("kill");
const cwd = makeTestRepo();
const input = new InputQueue();
const q = query({ prompt: input, options: { ...baseOptions(cwd), permissionMode: "acceptEdits" } });

let sessionId = "";
let turn = 0;
let deltas = 0;
input.push("Use the Write tool to create a.txt containing: x. Then reply with: done.");
for await (const m of q) {
  log.write("msg", m);
  if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
  if (m.type === "result") {
    log.note(`turn ${++turn} ${m.subtype}`);
    if (turn === 1) input.push("Write a 400-word story about a lighthouse keeper. Plain prose.");
  }
  if (turn === 1 && m.type === "stream_event" && m.event.type === "content_block_delta" && m.event.delta.type === "text_delta" && ++deltas === 5) {
    let childPids: number[] = [];
    try { childPids = execFileSync("pgrep", ["-P", String(process.pid)]).toString().trim().split("\n").map(Number); } catch {}
    fs.writeFileSync(LAST_SESSION_FILE, JSON.stringify({ kind: "kill", sessionId, cwd, childPids, at: new Date().toISOString() }, null, 2));
    log.note(`SIGKILL self mid-turn 2 (session ${sessionId}, children ${childPids.join(",")})`);
    process.kill(process.pid, "SIGKILL");
  }
}
