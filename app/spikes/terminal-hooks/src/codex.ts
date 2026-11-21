// Parte B: `codex` (TUI) in un PTY con override -c per processo.
// Segnali: notify (agent-turn-complete), notifiche del terminale OSC 9 / BEL (approval-requested,
// agent-turn-complete), facoltativamente hook PermissionRequest/Stop passati con -c.
// Variabili: CODEX_NOTIF_METHOD=osc9|bel, CODEX_HOOKS=1, CODEX_BYPASS_HOOK_TRUST=1, CODEX_DAEMON=1, CODEX_MODEL.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { ROOT, cleanEnv, hashGlobalConfigs, makeRunDir, makeTempRepo, now, sleep, startHookServer, startPty, typeLine, waitQuiet } from './lib.ts';
import type { HookHit } from './lib.ts';

const require = createRequire(import.meta.url);
// Binario nativo del pacchetto per la piattaforma (evita il wrapper node bin/codex.js).
const CODEX = path.join(path.dirname(require.resolve('@openai/codex-darwin-arm64/package.json')), 'vendor', 'aarch64-apple-darwin', 'bin', 'codex');
const NOTIFY = path.join(ROOT, 'src', 'notify.mjs');
const METHOD = process.env.CODEX_NOTIF_METHOD ?? 'osc9';
const WITH_HOOKS = process.env.CODEX_HOOKS === '1';
const BYPASS_HOOK_TRUST = process.env.CODEX_BYPASS_HOOK_TRUST === '1';
const MODEL = process.env.CODEX_MODEL ?? 'gpt-6-luna';
const STEP_MS = 120_000;

const runDir = makeRunDir(`codex-${METHOD}${WITH_HOOKS ? '-hooks' : ''}${BYPASS_HOOK_TRUST ? '-bypass' : ''}`);
const cfgToml = path.join(os.homedir(), '.codex', 'config.toml');
const mtimeBefore = fs.statSync(cfgToml).mtime.toISOString();
// Impronta delle chiavi di config.toml (percorsi + hash corti, mai i valori) per attribuire eventuali modifiche.
const tomlKeys = () => new Set(execFileSync(process.execPath, [path.join(ROOT, 'src', 'toml-keys.ts')], { encoding: 'utf8' }).trim().split('\n'));
const keysBefore = tomlKeys();
const hashesBefore = hashGlobalConfigs();
const runStart = new Date().toISOString();
// CODEX_DOTTED_REPO=1: cartella con un punto nel nome, per provare le forme dell'override di fiducia.
const repo = makeTempRepo(process.env.CODEX_DOTTED_REPO === '1' ? 'blue-s6-codex.dot-' : 'blue-s6-codex-');
const token = crypto.randomBytes(16).toString('hex');
const server = await startHookServer(token, path.join(runDir, 'hooks.jsonl'));
const version = execFileSync(CODEX, ['--version'], { encoding: 'utf8' }).trim();
console.log(`${version} · repo ${repo} · server ${server.url} · metodo ${METHOD} · hook ${WITH_HOOKS} · bypass ${BYPASS_HOOK_TRUST}`);

function trustOverride(form: string): string {
  if (form === 'quoted') return `projects."${repo}".trust_level="trusted"`;
  if (form === 'table') return `projects={${JSON.stringify(repo)}={trust_level="trusted"}}`;
  return `projects.${repo}.trust_level="trusted"`;
}
const curl = (ev: string) =>
  `curl -s -o /dev/null -m 5 -H "X-Blue-Token: $BLUE_HOOK_TOKEN" --data-binary @- ${server.url}/codex-hook/${ev}`;
const args = [
  ...(process.env.CODEX_DAEMON === '1' ? [] : ['--no-daemon']),
  '-m', MODEL,
  '-c', 'model_reasoning_effort="low"',
  // "untrusted" non è più supportato in 0.167 (errore all'avvio): sandbox read-only + on-request
  '-a', 'on-request',
  '-s', 'read-only',
  // fiducia del progetto solo per questo processo: niente scrittura di [projects] in config.toml
  // Forme dell'override di fiducia (vedi README): dotted (predefinita), quoted, table.
  '-c', trustOverride(process.env.CODEX_TRUST_FORM ?? 'dotted'),
  '-c', `notify=["${process.execPath}","${NOTIFY}","${server.url}/notify/codex"]`,
  '-c', 'tui.notifications=["agent-turn-complete","approval-requested"]',
  '-c', `tui.notification_method="${METHOD}"`,
  '-c', 'tui.notification_condition="always"',
  // Il primo avvio della TUI ha scritto [tui.model_availability_nux] "gpt-6.1-sol" = 1 in config.toml:
  // il contatore alto passato per processo evita che il riquadro ricompaia e venga riscritto.
  '-c', 'tui.model_availability_nux={"gpt-6.1-sol"=99}',
];
if (WITH_HOOKS) {
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop']) {
    args.push('-c', `hooks.${ev}=[{hooks=[{type="command",command='${curl(ev)}',timeout=10}]}]`);
  }
}
if (BYPASS_HOOK_TRUST) args.push('--dangerously-bypass-hook-trust');
fs.writeFileSync(path.join(runDir, 'args.json'), JSON.stringify(args, null, 2));

// ---------- stato derivato ----------
type State = 'starting' | 'idle' | 'running' | 'waiting:permission' | 'done' | 'exited';
let state: State = 'starting';
const transitions: { t: number; from: State; to: State; why: string }[] = [];
const setState = (to: State, t: number, why: string) => {
  if (to === state) return;
  transitions.push({ t, from: state, to, why });
  console.log(`  [${t.toFixed(0).padStart(6)} ms] stato ${state} -> ${to} (${why})`);
  state = to;
};
server.on((h: HookHit) => {
  const b = h.body ?? {};
  console.log(`  [${h.t.toFixed(0).padStart(6)} ms] ${h.route}/${h.event} ${b.type ?? b.hook_event_name ?? ''} token=${h.tokenOk ? 'ok' : 'NO'}`);
  if (h.route === 'notify' && b.type === 'agent-turn-complete') setState('done', h.t, 'notify agent-turn-complete');
  if (h.route === 'codex-hook') {
    if (h.event === 'UserPromptSubmit') setState('running', h.t, 'hook UserPromptSubmit');
    if (h.event === 'PermissionRequest') setState('waiting:permission', h.t, 'hook PermissionRequest');
    if (h.event === 'Stop') setState('done', h.t, 'hook Stop');
  }
});

// ---------- PTY ----------
const sess = startPty({ file: CODEX, args, cwd: repo, env: cleanEnv({ BLUE_HOOK_TOKEN: token }), runDir });
const flags = {
  trust: (s: string) => /Trust this folder\?|Do you trust/i.test(s),
  approval: (s: string) => /Would you like to run the following command\?/.test(s),
  working: (s: string) => /esc to interrupt/i.test(s),
  hooksReview: (s: string) => /need review|new or changed|Review hooks/i.test(s),
};
type Flag = keyof typeof flags;
const screenFlags: Record<Flag, boolean> = { trust: false, approval: false, working: false, hooksReview: false };
const screenEvents: { t: number; flag: Flag; on: boolean }[] = [];
sess.onScreen((s, t) => {
  for (const k of Object.keys(flags) as Flag[]) {
    const v = flags[k](s);
    if (v !== screenFlags[k]) {
      screenFlags[k] = v;
      screenEvents.push({ t, flag: k, on: v });
      console.log(`  [${t.toFixed(0).padStart(6)} ms] schermo ${k}=${v}`);
    }
  }
});
// Notifiche del terminale: OSC 9 e BEL, come le vedrebbe xterm.js in Blue.
const termNotifs: { t: number; kind: string; data?: string }[] = [];
const oscSeen = new Set<unknown>();
const bellsSeen = new Set<number>();
setInterval(() => {
  for (const o of sess.osc) if (o.code === 9 && !oscSeen.has(o)) { oscSeen.add(o); termNotifs.push({ t: o.t, kind: 'osc9', data: o.data }); console.log(`  [${o.t.toFixed(0).padStart(6)} ms] OSC 9: ${o.data}`); if (/approv/i.test(o.data)) setState('waiting:permission', o.t, 'OSC 9 approval'); }
  for (const b of sess.bells) if (!bellsSeen.has(b)) { bellsSeen.add(b); termNotifs.push({ t: b, kind: 'bel' }); console.log(`  [${b.toFixed(0).padStart(6)} ms] BEL`); }
}, 50).unref();

let exitExpected = false;
sess.exited.then(async (e) => {
  if (exitExpected) return;
  console.error(`codex è uscito inaspettatamente (code ${e.exitCode})`);
  results.unexpectedExit = e;
  sess.snapshot('uscita-inattesa');
  await finish(1);
});
const killer = setTimeout(() => {
  sess.snapshot('timeout-globale');
  finish(1);
}, 8 * 60_000);

const results: Record<string, unknown> = {};
let finished = false;
async function finish(code: number) {
  if (finished) return;
  finished = true;
  clearTimeout(killer);
  sess.close();
  await sleep(300);
  server.close();
  const hashesAfter = hashGlobalConfigs();
  const mtimeAfter = fs.statSync(cfgToml).mtime.toISOString();
  const keysAfter = tomlKeys();
  const tomlDiff = { added: [...keysAfter].filter((k) => !keysBefore.has(k)), removed: [...keysBefore].filter((k) => !keysAfter.has(k)) };
  const mine = [...tomlDiff.added, ...tomlDiff.removed].filter((k) => k.includes('blue-s6-') || /^(notify|tui\.notification|hooks|model|approval)/.test(k));
  const summary = {
    codexVersion: version,
    repo,
    args,
    results,
    transitions,
    termNotifs,
    screenEvents,
    hits: server.hits.map((h) => ({ t: h.t, route: h.route, event: h.event, tokenOk: h.tokenOk, keys: typeof h.body === 'object' ? Object.keys(h.body) : 'raw' })),
    hashesBefore,
    hashesAfter,
    configsUnchanged: Object.fromEntries(Object.keys(hashesBefore).map((k) => [k, hashesBefore[k] === hashesAfter[k]])),
    codexTomlDiff: tomlDiff,
    codexTomlChangesAttributableToThisRun: mine,
    codexConfigMtime: { before: mtimeBefore, after: mtimeAfter, runStart, runEnd: new Date().toISOString() },
  };
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ results, transitions, configsUnchanged: summary.configsUnchanged, codexTomlDiff: tomlDiff, mine, codexConfigMtime: summary.codexConfigMtime }, null, 2));
  console.log(`risultati in ${runDir}`);
  process.exit(code);
}
const near = (flag: Flag, on: boolean, t: number) => {
  let best: { t: number } | undefined;
  for (const e of screenEvents) if (e.flag === flag && e.on === on && (!best || Math.abs(e.t - t) < Math.abs(best.t - t))) best = e;
  return best ? { screenT: best.t, signalMinusScreenMs: Math.round(t - best.t) } : null;
};

try {
  // ---------- avvio ----------
  await waitQuiet(sess, 2500, 40_000);
  sess.snapshot('avvio');
  if (flags.trust(sess.screen())) throw new Error('prompt di fiducia visibile nonostante -c projects...: non rispondo (scriverebbe config.toml)');
  if (flags.hooksReview(sess.screen())) {
    // Modale bloccante "Hooks need review". "Trust all" scriverebbe la fiducia in config.toml:
    // si sceglie "Continue without trusting (hooks won't run)".
    results.hooksReviewAtStartup = sess.screen().split('\n').filter((l) => /hook|trust|›/i.test(l)).map((l) => l.trim());
    for (let i = 0; i < 6; i++) {
      const sel = sess.screen().split('\n').find((l) => l.trimStart().startsWith('›')) ?? '';
      if (/Continue without trusting/.test(sel)) break;
      sess.send('\x1b[B', 'hooks-review:down');
      await sleep(300);
    }
    sess.send('\r', 'hooks-review:continue-without-trusting');
    await waitQuiet(sess, 1500, 10_000);
    sess.snapshot('dopo-hooks-review');
  }
  results.startup = { hooksBeforePrompt: server.hits.map((h) => `${h.route}/${h.event}`) };

  // ---------- turno 1: approvazione consentita ----------
  console.log('turno 1: approvazione (consenti)');
  const t1 = await typeLine(sess, 'Run this shell command with sandbox_permissions=require_escalated: date > now.txt  Then reply with only: ok', 't1');
  const ap1 = await sess.waitScreen(flags.approval, STEP_MS, 'dialogo approvazione t1');
  await sleep(1500);
  sess.snapshot('t1-approvazione');
  const approve1 = now();
  sess.send('y', 't1:approve');
  const done1 = await server.waitFor((h) => h.route === 'notify', STEP_MS, 'notify t1', approve1).catch(() => null);
  await waitQuiet(sess, 1500, 15_000);
  sess.snapshot('t1-fine');
  const osc1 = termNotifs.filter((n) => n.t > t1 && n.t < approve1);
  const osc1b = termNotifs.filter((n) => n.t > approve1);
  results.turn1 = {
    submitAt: t1,
    approvalScreenAt: ap1,
    termNotifsWhileWaiting: osc1.map((n) => ({ ...n, minusScreenMs: Math.round(n.t - ap1) })),
    hookPermissionRequest: server.hits.find((h) => h.route === 'codex-hook' && h.event === 'PermissionRequest' && h.t > t1)?.body ?? null,
    approveAt: approve1,
    notify: done1 ? { t: done1.t, afterApproveMs: Math.round(done1.t - approve1), payload: done1.body, tokenOk: done1.tokenOk, vsWorkingOff: near('working', false, done1.t) } : 'non arrivato',
    termNotifsAfterApprove: osc1b.map((n) => ({ ...n, vsNotifyMs: done1 ? Math.round(n.t - done1.t) : null })),
    hookStop: server.hits.find((h) => h.route === 'codex-hook' && h.event === 'Stop' && h.t > approve1)?.body ?? null,
    fileCreated: fs.existsSync(path.join(repo, 'now.txt')),
  };

  // ---------- turno 2: approvazione negata (Esc) ----------
  console.log('turno 2: approvazione (nega con Esc)');
  await waitQuiet(sess, 1000, 10_000);
  const t2 = await typeLine(sess, 'Run this shell command with sandbox_permissions=require_escalated: date > later.txt  Then reply with only: ok', 't2');
  const ap2 = await sess.waitScreen(flags.approval, STEP_MS, 'dialogo approvazione t2');
  await sleep(1500);
  sess.snapshot('t2-approvazione');
  const deny2 = now();
  sess.send('\x1b', 't2:deny-esc');
  await sleep(10_000);
  sess.snapshot('t2-dopo-esc');
  results.turn2 = {
    approvalScreenAt: ap2,
    termNotifsWhileWaiting: termNotifs.filter((n) => n.t > t2 && n.t < deny2),
    signalsAfterDeny: [
      ...server.hits.filter((h) => h.t > deny2).map((h) => ({ t: h.t, src: `${h.route}/${h.event}`, type: h.body?.type })),
      ...termNotifs.filter((n) => n.t > deny2).map((n) => ({ t: n.t, src: n.kind, data: n.data })),
    ],
    workingOnScreen: flags.working(sess.screen()),
    stateAfterDeny: state,
  };

  // ---------- uscita ----------
  exitExpected = true;
  await typeLine(sess, '/quit', 'quit');
  const ex = await Promise.race([sess.exited, sleep(8000).then(() => null)]);
  if (!ex) {
    sess.send('\x03', 'ctrl-c');
    await sleep(500);
    sess.send('\x03', 'ctrl-c');
    await Promise.race([sess.exited, sleep(5000)]);
  }
  results.exit = ex ?? 'chiuso con ctrl-c';
  await finish(0);
} catch (err) {
  console.error(String(err));
  sess.snapshot('errore');
  results.error = String(err);
  await finish(1);
}
