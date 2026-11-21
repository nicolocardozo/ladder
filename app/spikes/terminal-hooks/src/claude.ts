// Parte A: `claude` in un PTY con hook iniettati per processo via --settings inline.
// Flusso: fiducia cartella -> turno con permesso Bash (consenti) -> turno con AskUserQuestion
// -> turno con permesso negato (Esc) -> attesa di idle_prompt -> /exit.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cleanEnv, hashGlobalConfigs, makeRunDir, makeTempRepo, now, sleep, startHookServer, startPty, typeLine, waitQuiet } from './lib.ts';
import type { HookHit } from './lib.ts';

const CLAUDE = process.env.CLAUDE_BIN ?? path.join(os.homedir(), '.local', 'bin', 'claude');
const IDLE_WAIT_MS = Number(process.env.IDLE_WAIT_MS ?? 75_000);
const STEP_MS = 120_000;

const runDir = makeRunDir('claude');
const hashesBefore = hashGlobalConfigs();
const repo = makeTempRepo('blue-s6-claude-');
const token = crypto.randomBytes(16).toString('hex');
const sessionId = crypto.randomUUID();
const server = await startHookServer(token, path.join(runDir, 'hooks.jsonl'));
const version = execFileSync(CLAUDE, ['--version'], { encoding: 'utf8' }).trim();
console.log(`claude ${version} · repo ${repo} · session ${sessionId} · server ${server.url}`);

// ---------- impostazioni inline con gli hook ----------
// command: curl inoltra lo stdin JSON; http: handler nativo. SessionStart non supporta http.
const CMD_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
  'PermissionDenied', 'Notification', 'Stop', 'StopFailure', 'SessionEnd',
];
const HTTP_EVENTS = ['UserPromptSubmit', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure'];
const curl = (ev: string) =>
  `curl -s -o /dev/null -m 5 -H "X-Blue-Token: $BLUE_HOOK_TOKEN" --data-binary @- ${server.url}/cmd/${ev}`;
const hooks: Record<string, unknown[]> = {};
for (const ev of CMD_EVENTS) {
  const handlers: unknown[] = [{ type: 'command', command: curl(ev), timeout: 10 }];
  if (HTTP_EVENTS.includes(ev)) {
    handlers.push({
      type: 'http',
      url: `${server.url}/http/${ev}`,
      timeout: 10,
      headers: { 'X-Blue-Token': '$BLUE_HOOK_TOKEN' },
      allowedEnvVars: ['BLUE_HOOK_TOKEN'],
    });
  }
  hooks[ev] = [{ hooks: handlers }];
}
const settings = { hooks };
const args = ['--model', 'haiku', '--session-id', sessionId, '--permission-mode', 'default', '--settings', JSON.stringify(settings)];
fs.writeFileSync(path.join(runDir, 'settings.inline.json'), JSON.stringify(settings, null, 2));

// ---------- stato derivato dagli hook (solo route "cmd", per non contare due volte) ----------
type State = 'starting' | 'idle' | 'running' | 'waiting:permission' | 'waiting:question' | 'done' | 'error' | 'exited';
let state: State = 'starting';
const transitions: { t: number; from: State; to: State; why: string }[] = [];
const notes: { t: number; note: string }[] = [];
const setState = (to: State, t: number, why: string) => {
  if (to === state) return;
  transitions.push({ t, from: state, to, why });
  console.log(`  [${t.toFixed(0).padStart(6)} ms] stato ${state} -> ${to} (${why})`);
  state = to;
};
server.on((h: HookHit) => {
  const b = h.body ?? {};
  const tag = `${h.route}/${h.event}${b.notification_type ? ':' + b.notification_type : ''}${b.tool_name ? ':' + b.tool_name : ''}`;
  console.log(`  [${h.t.toFixed(0).padStart(6)} ms] hook ${tag} token=${h.tokenOk ? 'ok' : 'NO'}`);
  if (h.route !== 'cmd') return;
  switch (h.event) {
    case 'SessionStart':
      setState('idle', h.t, 'SessionStart');
      break;
    case 'UserPromptSubmit':
      setState('running', h.t, 'UserPromptSubmit');
      break;
    case 'PreToolUse':
      if (b.tool_name === 'AskUserQuestion') setState('waiting:question', h.t, 'PreToolUse AskUserQuestion');
      else setState('running', h.t, `PreToolUse ${b.tool_name}`);
      break;
    case 'PermissionRequest':
      setState(b.tool_name === 'AskUserQuestion' ? 'waiting:question' : 'waiting:permission', h.t, `PermissionRequest ${b.tool_name}`);
      break;
    case 'Notification':
      if (b.notification_type === 'permission_prompt' && !state.startsWith('waiting')) setState('waiting:permission', h.t, 'Notification permission_prompt');
      else if (b.notification_type === 'elicitation_dialog') setState('waiting:question', h.t, 'Notification elicitation_dialog');
      else notes.push({ t: h.t, note: `Notification ${b.notification_type} con stato ${state}` });
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      setState('running', h.t, `${h.event} ${b.tool_name}`);
      break;
    case 'Stop':
      setState('done', h.t, 'Stop');
      break;
    case 'StopFailure':
      setState('error', h.t, `StopFailure ${b.error}`);
      break;
    case 'SessionEnd':
      setState('exited', h.t, `SessionEnd ${b.reason}`);
      break;
  }
});

// ---------- PTY ----------
const sess = startPty({
  file: CLAUDE,
  args,
  cwd: repo,
  // DISABLE_AUTOUPDATER: senza, la CLI si aggiorna da sola durante lo spike (visto: 2.1.316 -> 2.1.319).
  env: cleanEnv({ BLUE_HOOK_TOKEN: token, DISABLE_AUTOUPDATER: '1' }),
  runDir,
});

// Indicatori sullo schermo e cronologia delle loro transizioni.
const flags = {
  trust: (s: string) => /trust (this|the files in this) folder|Yes, I trust/i.test(s),
  spinner: (s: string) => /esc to interrupt/i.test(s),
  permission: (s: string) => /Do you want to (proceed|make this edit|create)/i.test(s),
  question: (s: string) => /^\s*Pick a color\s*$/m.test(s) && /Enter to select/.test(s),
};
type Flag = keyof typeof flags;
const screenFlags: Record<Flag, boolean> = { trust: false, spinner: false, permission: false, question: false };
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

let exitExpected = false;
sess.exited.then(async (e) => {
  if (exitExpected) return;
  console.error(`claude è uscito inaspettatamente (code ${e.exitCode})`);
  results.unexpectedExit = e;
  sess.snapshot('uscita-inattesa');
  await finish(1);
});

const killer = setTimeout(() => {
  console.error('timeout globale, chiudo');
  sess.snapshot('timeout-globale');
  finish(1);
}, 9 * 60_000);

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
  const summary = {
    claudeVersion: version,
    repo,
    sessionId,
    args: args.map((a) => (a.startsWith('{') ? '<settings inline, vedi settings.inline.json>' : a)),
    results,
    transitions,
    notes,
    screenEvents,
    osc: sess.osc.filter((o) => o.code !== 0 && o.code !== 2),
    titles: sess.osc.filter((o) => o.code === 0 || o.code === 2).slice(0, 50),
    bells: sess.bells,
    hookCounts: countHooks(server.hits),
    sessionIdMatches: server.hits.filter((h) => h.body?.session_id).every((h) => h.body.session_id === sessionId),
    tokenOkAll: server.hits.every((h) => h.tokenOk),
    payloadKeys: payloadKeys(server.hits),
    hashesBefore,
    hashesAfter,
    configsUnchanged: Object.fromEntries(Object.keys(hashesBefore).map((k) => [k, hashesBefore[k] === hashesAfter[k]])),
  };
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ results, hookCounts: summary.hookCounts, sessionIdMatches: summary.sessionIdMatches, tokenOkAll: summary.tokenOkAll, configsUnchanged: summary.configsUnchanged }, null, 2));
  console.log(`risultati in ${runDir}`);
  process.exit(code);
}

function countHooks(hits: HookHit[]) {
  const c: Record<string, number> = {};
  for (const h of hits) {
    const k = `${h.route}/${h.event}${h.body?.notification_type ? ':' + h.body.notification_type : ''}`;
    c[k] = (c[k] ?? 0) + 1;
  }
  return c;
}
function payloadKeys(hits: HookHit[]) {
  const k: Record<string, string[]> = {};
  for (const h of hits) if (h.route === 'cmd' && h.body && typeof h.body === 'object') k[h.event] = [...new Set([...(k[h.event] ?? []), ...Object.keys(h.body)])];
  return k;
}
/** Transizione dello schermo più vicina a un istante (per misurare la latenza hook ↔ schermo). */
function nearestScreen(flag: Flag, on: boolean, t: number) {
  let best: { t: number } | undefined;
  for (const e of screenEvents) if (e.flag === flag && e.on === on && (!best || Math.abs(e.t - t) < Math.abs(best.t - t))) best = e;
  return best ? { screenT: best.t, hookMinusScreenMs: Math.round(t - best.t) } : null;
}
const cmdHit = (event: string, extra: (b: any) => boolean = () => true, since = -1) =>
  server.hits.find((h) => h.route === 'cmd' && h.event === event && h.t > since && extra(h.body ?? {}));
const httpHit = (event: string, since = -1) => server.hits.find((h) => h.route === 'http' && h.event === event && h.t > since);

try {
  // ---------- avvio e fiducia della cartella ----------
  const startDeadline = now() + 60_000;
  let trustAnsweredAt = -1;
  while (now() < startDeadline) {
    const s = sess.screen();
    if (trustAnsweredAt < 0 && flags.trust(s)) {
      // In 2.1.316 l'opzione preselezionata è "No, exit": si scende fino a "Yes, I trust this folder".
      await sleep(400);
      const selected = sess.screen().split('\n').find((l) => l.includes('❯')) ?? '';
      if (!results.trustPrompt) {
        sess.snapshot('fiducia-cartella');
        results.trustPrompt = { seenAt: screenEvents.find((e) => e.flag === 'trust')?.t, preselected: selected.trim(), hooksBeforeTrust: server.hits.map((h) => h.event) };
      }
      if (/Yes, I trust/.test(selected)) {
        sess.send('\r', 'trust:confirm');
        trustAnsweredAt = now();
      } else {
        sess.send('\x1b[B', 'trust:down');
      }
      continue;
    }
    if (cmdHit('SessionStart') && !flags.trust(s)) break;
    await sleep(100);
  }
  const ss = cmdHit('SessionStart');
  results.sessionStart = ss ? { t: ss.t, afterTrustMs: trustAnsweredAt > 0 ? Math.round(ss.t - trustAnsweredAt) : null, source: ss.body.source, model: ss.body.model } : 'non arrivato';
  await waitQuiet(sess, 1500, 15_000);
  sess.snapshot('pronto');

  if (process.env.SCENARIO === 'idle') {
    // ---------- scenario idle: quando arriva Notification idle_prompt? ----------
    // Fase A: nessun evento di focus per 70 s. Fase B: focus-out (CSI O, come xterm.js con il modo 1004) e altri 70 s.
    console.log('scenario idle: un turno semplice, poi attesa');
    const ti = await typeLine(sess, 'Reply with only: ok', 'idle-turn');
    const stopI = await server.waitFor((h) => h.route === 'cmd' && h.event === 'Stop', STEP_MS, 'Stop idle', ti);
    const focusModeOn = /\x1b\[\?1004h/.test(fs.readFileSync(path.join(runDir, 'pty.raw'), 'utf8'));
    const isIdle = (h: HookHit) => h.route === 'cmd' && h.event === 'Notification' && h.body?.notification_type === 'idle_prompt';
    const a = await server.waitFor(isIdle, 70_000, 'idle A', stopI.t).catch(() => null);
    let b: HookHit | null = null;
    let focusOutAt = -1;
    if (!a) {
      focusOutAt = now();
      sess.send('\x1b[O', 'focus-out');
      b = await server.waitFor(isIdle, 70_000, 'idle B', focusOutAt).catch(() => null);
    }
    sess.snapshot('idle-fine');
    results.idleScenario = {
      focusReportingEnabledByClaude: focusModeOn,
      stopAt: stopI.t,
      phaseA_noFocusEvent: a ? { afterStopMs: Math.round(a.t - stopI.t), message: a.body.message } : 'nessuna in 70 s',
      phaseB_afterFocusOut: focusOutAt < 0 ? 'non eseguita' : b ? { afterStopMs: Math.round(b.t - stopI.t), afterFocusOutMs: Math.round(b.t - focusOutAt), message: b.body.message } : 'nessuna in 70 s',
      allNotifications: server.hits.filter((h) => h.route === 'cmd' && h.event === 'Notification').map((h) => ({ t: h.t, type: h.body.notification_type, message: h.body.message })),
    };
    exitExpected = true;
    await typeLine(sess, '/exit', 'exit');
    await Promise.race([sess.exited, sleep(10_000)]);
    await finish(0);
  }

  // ---------- turno 1: permesso Bash, consentito ----------
  console.log('turno 1: permesso Bash (consenti)');
  const t1 = await typeLine(sess, 'Use the Bash tool to run exactly: date > now.txt  Then reply with only: ok', 't1');
  const perm1 = await server.waitFor((h) => h.route === 'cmd' && h.event === 'PermissionRequest', STEP_MS, 'PermissionRequest t1', t1);
  await sess.waitScreen(flags.permission, 15_000, 'dialogo permesso t1');
  // aspetta anche la Notification permission_prompt prima di rispondere, come farebbe una persona lenta
  const notif1 = await server
    .waitFor((h) => h.route === 'cmd' && h.event === 'Notification' && h.body?.notification_type === 'permission_prompt', 12_000, 'Notification t1', t1)
    .catch(() => null);
  await sleep(500);
  sess.snapshot('t1-permesso');
  const approve1 = now();
  sess.send('\r', 't1:approve');
  const stop1 = await server.waitFor((h) => h.route === 'cmd' && h.event === 'Stop', STEP_MS, 'Stop t1', approve1);
  await waitQuiet(sess, 1000, 10_000);
  sess.snapshot('t1-fine');
  results.turn1 = {
    submitAt: t1,
    userPromptSubmit: cmdHit('UserPromptSubmit', () => true, t1)?.t,
    userPromptSubmitVsSpinner: nearestScreen('spinner', true, cmdHit('UserPromptSubmit', () => true, t1)?.t ?? 0),
    permissionRequest: { t: perm1.t, tool: perm1.body.tool_name, input: perm1.body.tool_input, suggestions: perm1.body.permission_suggestions, vsScreen: nearestScreen('permission', true, perm1.t) },
    notification: notif1 ? { t: notif1.t, afterPermissionRequestMs: Math.round(notif1.t - perm1.t), message: notif1.body.message, title: notif1.body.title, vsScreen: nearestScreen('permission', true, notif1.t) } : 'non arrivata entro 12 s',
    approveAt: approve1,
    dialogClosedAfterApproveMs: (() => { const e = screenEvents.find((x) => x.flag === 'permission' && !x.on && x.t >= approve1); return e ? Math.round(e.t - approve1) : null; })(),
    firstHookAfterApprove: (() => { const h = server.hits.find((x) => x.route === 'cmd' && x.t > approve1); return h ? { event: h.event, tool: h.body?.tool_name, afterApproveMs: Math.round(h.t - approve1) } : null; })(),
    stop: { t: stop1.t, last_assistant_message: stop1.body.last_assistant_message, vsSpinnerOff: nearestScreen('spinner', false, stop1.t), background_tasks: stop1.body.background_tasks },
    http: { PermissionRequest: !!httpHit('PermissionRequest', t1), Notification: !!httpHit('Notification', t1), Stop: !!httpHit('Stop', t1) },
    fileCreated: fs.existsSync(path.join(repo, 'now.txt')),
  };

  // ---------- turno 2: domanda (AskUserQuestion) ----------
  console.log('turno 2: AskUserQuestion');
  await waitQuiet(sess, 1000, 10_000);
  const t2 = await typeLine(sess, 'Use the AskUserQuestion tool to ask me "Pick a color" with options Red and Blue. Then reply with only the color I chose.', 't2');
  let qScreen = -1;
  try {
    qScreen = await sess.waitScreen(flags.question, STEP_MS, 'dialogo domanda t2');
  } catch (e) {
    sess.snapshot('t2-domanda-non-vista');
    throw e;
  }
  await sleep(3000); // lascia arrivare gli hook
  sess.snapshot('t2-domanda');
  const answer2 = now();
  sess.send('\r', 't2:answer-first-option');
  // eventuale schermata di riepilogo "Submit answers"
  for (let i = 0; i < 3; i++) {
    await sleep(1200);
    const s = sess.screen();
    if (/Submit answers|Review your answers/i.test(s)) {
      sess.snapshot('t2-riepilogo');
      sess.send('\r', 't2:submit');
    } else if (!flags.question(s)) break;
  }
  const stop2 = await server.waitFor((h) => h.route === 'cmd' && h.event === 'Stop', STEP_MS, 'Stop t2', answer2);
  await waitQuiet(sess, 1000, 10_000);
  sess.snapshot('t2-fine');
  const between = server.hits.filter((h) => h.route === 'cmd' && h.t > t2 && h.t < answer2).map((h) => ({ t: h.t, event: h.event, type: h.body?.notification_type, tool: h.body?.tool_name, message: h.body?.message }));
  results.turn2 = {
    questionScreenAt: qScreen,
    hooksBeforeAnswer: between,
    stop: { t: stop2.t, last_assistant_message: stop2.body.last_assistant_message },
  };

  // ---------- turno 3: permesso negato con Esc ----------
  console.log('turno 3: permesso Bash (nega con Esc)');
  await waitQuiet(sess, 1000, 10_000);
  const t3 = await typeLine(sess, 'Use the Bash tool to run exactly: date > later.txt  Then reply with only: ok', 't3');
  const perm3 = await server.waitFor((h) => h.route === 'cmd' && h.event === 'PermissionRequest', STEP_MS, 'PermissionRequest t3', t3);
  await sess.waitScreen(flags.permission, 15_000, 'dialogo permesso t3');
  await sleep(1500);
  sess.snapshot('t3-permesso');
  const deny3 = now();
  sess.send('\x1b', 't3:deny-esc');
  await sleep(8000);
  sess.snapshot('t3-dopo-esc');
  // Nessun hook dopo il rifiuto: il transcript JSONL invece registra l'interruzione e la fine del turno.
  const transcriptPath = cmdHit('SessionStart')?.body?.transcript_path as string | undefined;
  const transcriptTail = (() => {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return 'transcript non trovato';
    const entries = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    return entries.slice(-8).filter((e) => e.timestamp).map((e) => {
      const c = e.message?.content;
      const text = Array.isArray(c) ? c.map((x: any) => x.text ?? x.type).join(' ') : typeof c === 'string' ? c : '';
      return { type: e.type, subtype: e.subtype, text: String(text).slice(0, 80) };
    });
  })();
  results.turn3 = {
    transcriptTail,
    permissionRequest: perm3.t,
    denyAt: deny3,
    hooksAfterDeny: server.hits.filter((h) => h.route === 'cmd' && h.t > deny3).map((h) => ({ t: h.t, event: h.event, type: h.body?.notification_type, tool: h.body?.tool_name })),
    stateAfterDeny: state,
    spinnerOnScreen: flags.spinner(sess.screen()),
  };

  // ---------- attesa di idle_prompt ----------
  console.log(`attesa idle_prompt fino a ${IDLE_WAIT_MS / 1000} s`);
  const idleFrom = now();
  const idle = await server
    .waitFor((h) => h.route === 'cmd' && h.event === 'Notification' && h.body?.notification_type === 'idle_prompt', IDLE_WAIT_MS, 'idle_prompt', idleFrom)
    .catch(() => null);
  sess.snapshot('dopo-idle');
  results.idlePrompt = idle
    ? { t: idle.t, afterLastStopMs: Math.round(idle.t - stop2.t), afterDenyMs: Math.round(idle.t - deny3), message: idle.body.message, stateWhenArrived: state }
    : `nessuna entro ${IDLE_WAIT_MS / 1000} s`;
  results.allNotifications = server.hits
    .filter((h) => h.route === 'cmd' && h.event === 'Notification')
    .map((h) => ({ t: h.t, type: h.body.notification_type, message: h.body.message, title: h.body.title }));

  // ---------- uscita ----------
  exitExpected = true;
  const exitAt = await typeLine(sess, '/exit', 'exit');
  const ex = await Promise.race([sess.exited, sleep(15_000).then(() => null)]);
  if (!ex) {
    sess.send('\x03', 'ctrl-c');
    await sleep(300);
    sess.send('\x03', 'ctrl-c');
  }
  await sleep(1500);
  const se = cmdHit('SessionEnd');
  results.exit = { exitAt, exitedAt: ex?.t, exitCode: ex?.exitCode, sessionEnd: se ? { t: se.t, reason: se.body.reason } : 'non arrivato' };
  await finish(0);
} catch (err) {
  console.error(String(err));
  sess.snapshot('errore');
  results.error = String(err);
  await finish(1);
}
