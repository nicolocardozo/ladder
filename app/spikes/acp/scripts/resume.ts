// Criterio 6: ripresa dopo kill. Processo 1 crea la sessione e viene ucciso con SIGKILL;
// processo 2 la riapre con session/load (conta gli aggiornamenti rigiocati) e verifica la memoria;
// processo 3 la riapre con session/resume, se l'agente lo annuncia, e verifica che non rigiochi nulla.
import { execFileSync } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import { resolveAgent } from "../src/agents.ts";
import { AcpHost, applyCheapest } from "../src/acp-client.ts";
import { finalText, observe, runTurn } from "../src/harness.ts";
import { Recorder } from "../src/recorder.ts";
import { makeTempRepo } from "../src/repo.ts";

const spec = await resolveAgent();
const rec = new Recorder(`resume-${spec.id}`);
const cwd = makeTempRepo("resume");
const WORD = "BLUEBERRY-42";
const result: Record<string, unknown> = {};

const childPids = (pid: number | undefined): string => {
  if (!pid) return "";
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const alive = (pids: string) =>
  pids.split("\n").filter(Boolean).filter((p) => {
    try {
      process.kill(Number(p), 0);
      return true;
    } catch {
      return false;
    }
  });

let sessionId = "";
try {
  // Processo 1
  {
    const host = AcpHost.start(spec, { rec, fsRoots: [cwd] });
    const obs = observe(host, rec, { echo: false });
    await host.initialize();
    const s = await host.newSession(cwd);
    sessionId = s.sessionId;
    await applyCheapest(host, sessionId, s.configOptions);
    const r = await runTurn(host, obs, sessionId, `Remember this code word: ${WORD}. Reply with just: noted`);
    result.p1 = { stopReason: r.stopReason, text: finalText(obs) };
    const kids = childPids(host.child.pid);
    await host.kill();
    await new Promise((r) => setTimeout(r, 1500));
    result.p1Kill = { childrenBefore: kids.split("\n").filter(Boolean).length, childrenAliveAfterKill: alive(kids).length };
    rec.note("process 1 killed", result.p1Kill);
  }

  // Processo 2: session/load
  {
    const host = AcpHost.start(spec, { rec, fsRoots: [cwd] });
    const obs = observe(host, rec, { echo: false });
    const init = await host.initialize();
    const replay: string[] = [];
    const off = host.onUpdate((n) => replay.push(n.update.sessionUpdate));
    const t = rec.ms();
    if (!init.agentCapabilities?.loadSession) throw new Error("loadSession not advertised");
    const loaded = await host.agent.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] });
    off();
    const counts = Object.fromEntries([...new Set(replay)].map((k) => [k, replay.filter((x) => x === k).length]));
    const replayedText = obs.events.filter((e) => e.type === "message.completed" || e.type === "history.user_message").map((e) => e.payload.text ?? e.payload.content);
    result.p2Load = { ms: rec.ms() - t, replayedUpdates: replay.length, kinds: counts, replayedText, configOptionsReturned: (loaded.configOptions ?? []).length };
    rec.note("session/load", result.p2Load);
    await applyCheapest(host, sessionId, loaded.configOptions);
    obs.events.length = 0;
    const r = await runTurn(host, obs, sessionId, "What was the code word? Reply with just the word.");
    result.p2 = { stopReason: r.stopReason, text: finalText(obs), remembers: finalText(obs).includes(WORD), firstMessageMs: r.timings.firstMessageMs };
    await host.close();
  }

  // Processo 3: session/resume (senza ripetizione) e session/list
  {
    const host = AcpHost.start(spec, { rec, fsRoots: [cwd] });
    const obs = observe(host, rec, { echo: false });
    const init = await host.initialize();
    if (init.agentCapabilities?.sessionCapabilities?.list) {
      const list = await host.agent.request(acp.methods.agent.session.list, { cwd });
      result.p3List = list.sessions.map((s) => ({ sessionId: s.sessionId, title: s.title, updatedAt: s.updatedAt }));
    }
    if (init.agentCapabilities?.sessionCapabilities?.resume) {
      const replay: string[] = [];
      const off = host.onUpdate((n) => replay.push(n.update.sessionUpdate));
      const t = rec.ms();
      const resumed = await host.agent.request(acp.methods.agent.session.resume, { sessionId, cwd, mcpServers: [] });
      off();
      result.p3Resume = { ms: rec.ms() - t, updatesDuringResume: replay };
      await applyCheapest(host, sessionId, resumed.configOptions);
      const r = await runTurn(host, obs, sessionId, "Say the code word again. Reply with just the word.");
      result.p3 = { stopReason: r.stopReason, text: finalText(obs), remembers: finalText(obs).includes(WORD) };
    } else {
      result.p3Resume = "session/resume not advertised";
    }
    await host.close();
  }
  rec.note("RESULT", result);
} catch (e) {
  rec.note("ERROR", { message: (e as Error).message, data: (e as { data?: unknown }).data, partial: result });
  process.exitCode = 1;
} finally {
  rec.note("log", rec.path);
  await rec.close();
}
