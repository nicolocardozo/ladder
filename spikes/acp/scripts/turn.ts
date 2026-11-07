// Criteri 3, 4 e 7, in una sessione con la modalità che chiede approvazioni.
// Turno A: crea hello.txt (permesso: consenti una volta), esegue `ls`, crea second.txt (permesso: rifiuta).
// Turno B: esegue due comandi, uno bloccato dalla sandbox; mostra output dei comandi e fine turno normale.
// Registra tutti i session/update, il motivo di fine turno e il tempo al primo chunk.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgent } from "../src/agents.ts";
import { AcpHost, applyCheapest, describeConfig, type PromptResult } from "../src/acp-client.ts";
import { observe, pickApprovalMode, runTurn, scriptedPermissions } from "../src/harness.ts";
import { Recorder } from "../src/recorder.ts";
import { gitDiff, gitStatus, makeTempRepo } from "../src/repo.ts";

const spec = await resolveAgent();
const rec = new Recorder(`turn-${spec.id}`);
const cwd = makeTempRepo("turn");
const host = AcpHost.start(spec, { rec, fsRoots: [cwd] });
const obs = observe(host, rec);
const perms = scriptedPermissions(rec, obs, [["allow_once"], ["reject_once"]]);
host.decidePermission = perms;

const TURN_A = [
  "Do these steps in order, then stop:",
  "1. Using your file editing tool (not the shell), create hello.txt containing the line: hello from blue",
  "2. Run the shell command: ls",
  "3. Using your file editing tool (not the shell), create second.txt containing the line: second",
  "If an action is rejected, skip it and do not retry. End with one short sentence.",
].join("\n");

const TURN_B = [
  "Run the shell command `cat hello.txt`, then run the shell command `touch third.txt`.",
  "If a command is blocked, do not retry it. Reply with one short sentence.",
].join("\n");

const summary = (r: PromptResult) => ({
  stopReason: r.stopReason,
  error: r.error,
  timeToFirstUpdateMs: r.timings.firstUpdateMs,
  timeToFirstThoughtMs: r.timings.firstThoughtMs,
  timeToFirstMessageChunkMs: r.timings.firstMessageMs,
  totalMs: r.timings.totalMs,
});

try {
  await host.initialize();
  const s = await host.newSession(cwd);
  let options = await applyCheapest(host, s.sessionId, s.configOptions);
  const mode = pickApprovalMode(options);
  if (mode) options = (await host.setConfig(s.sessionId, mode.configId, mode.value)).configOptions;
  rec.note("config", describeConfig(options).map((o) => `${(o as { id: string }).id}=${(o as { current: unknown }).current}`));

  const a = await runTurn(host, obs, s.sessionId, TURN_A);
  const toolsA = obs.events.filter((e) => e.type.startsWith("tool.")).length;
  const b = await runTurn(host, obs, s.sessionId, TURN_B);

  const hello = join(cwd, "hello.txt");
  rec.note("RESULT", {
    turnA: summary(a),
    turnB: summary(b),
    helloContent: existsSync(hello) ? readFileSync(hello, "utf8") : null,
    secondExists: existsSync(join(cwd, "second.txt")),
    thirdExists: existsSync(join(cwd, "third.txt")),
    permissions: perms.log,
    toolEventsTurnA: toolsA,
    clientRequests: host.stats,
    unknownUpdateKinds: obs.norm.unknown,
  });
  rec.note("git status (Blue)", gitStatus(cwd));
  rec.note("git diff (Blue)", gitDiff(cwd));
  rec.note("agent diffs", obs.events.filter((e) => e.type === "tool.diff").map((d) => d.payload));
} catch (e) {
  rec.note("ERROR", { message: (e as Error).message, data: (e as { data?: unknown }).data });
  process.exitCode = 1;
} finally {
  await host.close();
  rec.note("log", rec.path);
  await rec.close();
}
