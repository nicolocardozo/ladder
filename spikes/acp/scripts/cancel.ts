// Criterio 5: session/cancel durante un turno lungo; atteso stopReason "cancelled" e un turno successivo che funziona.
import { resolveAgent } from "../src/agents.ts";
import { AcpHost, applyCheapest, sleep } from "../src/acp-client.ts";
import { finalText, observe, runTurn } from "../src/harness.ts";
import { Recorder } from "../src/recorder.ts";
import { makeTempRepo } from "../src/repo.ts";

const spec = await resolveAgent();
const rec = new Recorder(`cancel-${spec.id}`);
const cwd = makeTempRepo("cancel");
const host = AcpHost.start(spec, { rec, fsRoots: [cwd] });
const obs = observe(host, rec);

const LONG = "Run the shell command `sleep 30 && echo done` and wait for it to finish, then reply with the single word: finished";
const NEXT = "Reply with just the word: OK";

try {
  await host.initialize();
  const s = await host.newSession(cwd);
  await applyCheapest(host, s.sessionId, s.configOptions);

  // Annulla un secondo dopo l'inizio della prima tool call, o dopo 20 s se non arriva.
  let cancelAt = 0;
  let cancelled = false;
  const doCancel = async (why: string) => {
    if (cancelled) return;
    cancelled = true;
    rec.note("cancelling", { why });
    cancelAt = rec.ms();
    await host.cancel(s.sessionId);
  };
  const off = host.onUpdate((n) => {
    if (n.update.sessionUpdate === "tool_call") void sleep(1000).then(() => doCancel("tool_call started"));
  });
  const fallback = setTimeout(() => void doCancel("timeout"), 20000);

  const r1 = await runTurn(host, obs, s.sessionId, LONG);
  clearTimeout(fallback);
  off();
  const stopAfterCancelMs = rec.ms() - cancelAt;

  const r2 = await runTurn(host, obs, s.sessionId, NEXT);
  rec.note("RESULT", {
    firstStopReason: r1.stopReason,
    firstError: r1.error,
    cancelToStopMs: stopAfterCancelMs,
    secondStopReason: r2.stopReason,
    secondText: finalText(obs),
    toolStates: obs.events.filter((e) => e.type.startsWith("tool.")).map((e) => [e.type, e.payload.status ?? ""]),
  });
} catch (e) {
  rec.note("ERROR", { message: (e as Error).message, data: (e as { data?: unknown }).data });
  process.exitCode = 1;
} finally {
  await host.close();
  rec.note("log", rec.path);
  await rec.close();
}
