// Criteri 1 e 2: initialize con protocollo 1, capacità e metodi di login; session/new, opzioni, modalità, modello economico.
import { resolveAgent } from "../src/agents.ts";
import { AcpHost, applyCheapest, describeConfig } from "../src/acp-client.ts";
import { Recorder } from "../src/recorder.ts";
import { makeTempRepo } from "../src/repo.ts";

const spec = await resolveAgent();
const rec = new Recorder(`probe-${spec.id}`);
const cwd = makeTempRepo("probe");
const host = AcpHost.start(spec, { rec, fsRoots: [cwd] });

try {
  const init = await host.initialize();
  rec.note("agentCapabilities", init.agentCapabilities);
  rec.note("authMethods", init.authMethods);

  const s = await host.newSession(cwd);
  rec.note("modes", s.modes);
  rec.note("configOptions", describeConfig(s.configOptions));
  const options = await applyCheapest(host, s.sessionId, s.configOptions);
  rec.note("configOptions after", describeConfig(options));
  rec.note("client-side requests", host.stats);
} catch (e) {
  rec.note("ERROR", { message: (e as Error).message, data: (e as { data?: unknown }).data });
  process.exitCode = 1;
} finally {
  await host.close();
  rec.note("log", rec.path);
  await rec.close();
}
