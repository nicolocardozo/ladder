// Criterio 7: tempi di avvio e tempo al primo chunk, su più turni brevi.
// Usa capacità client vuote (niente fs, niente terminale) per mostrare che non sono necessarie.
import { resolveAgent } from "../src/agents.ts";
import { AcpHost, applyCheapest } from "../src/acp-client.ts";
import { observe, runTurn } from "../src/harness.ts";
import { Recorder } from "../src/recorder.ts";
import { makeTempRepo } from "../src/repo.ts";

const spec = await resolveAgent();
const N = Number(process.env.ACP_SAMPLES ?? 3);
const rec = new Recorder(`ttfc-${spec.id}`);
const cwd = makeTempRepo("ttfc");
const t0 = rec.ms();
const host = AcpHost.start(spec, { rec, fsRoots: [cwd], clientCapabilities: {} });
const obs = observe(host, rec, { echo: false });

try {
  await host.initialize();
  const tInit = rec.ms() - t0;
  const tS = rec.ms();
  const s = await host.newSession(cwd);
  const tNew = rec.ms() - tS;
  await applyCheapest(host, s.sessionId, s.configOptions);
  const samples = [];
  for (let i = 0; i < N; i++) {
    const r = await runTurn(host, obs, s.sessionId, `Reply with just the number ${i + 1}.`);
    samples.push({ stopReason: r.stopReason, firstUpdateMs: r.timings.firstUpdateMs, firstMessageMs: r.timings.firstMessageMs, totalMs: r.timings.totalMs });
  }
  const fm = samples.map((x) => x.firstMessageMs ?? NaN).sort((a, b) => a - b);
  rec.note("RESULT", {
    spawnToInitializedMs: tInit,
    sessionNewMs: tNew,
    samples,
    firstMessageMedianMs: fm[Math.floor(fm.length / 2)],
    clientCapabilities: {},
    clientRequests: host.stats,
  });
} catch (e) {
  rec.note("ERROR", { message: (e as Error).message, data: (e as { data?: unknown }).data });
  process.exitCode = 1;
} finally {
  await host.close();
  rec.note("log", rec.path);
  await rec.close();
}
