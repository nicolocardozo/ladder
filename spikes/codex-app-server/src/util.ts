// Utilità condivise dagli script dello spike.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CodexAppServer, RESULTS_DIR, type ClientOptions } from "./client.ts";
import type { Model, Turn } from "../generated/stable/v2/index.ts";
import type { ServerNotification } from "../generated/stable/index.ts";

export const STATE_FILE = path.join(RESULTS_DIR, "state.json");

/** Stato passato da uno script all'altro (thread persistente, repo di prova, modello scelto). */
export interface SpikeState {
  model?: string;
  effort?: string;
  repo?: string;
  threadId?: string;
  createdFile?: string;
}
export function readState(): SpikeState {
  return existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as SpikeState) : {};
}
export function writeState(patch: SpikeState): SpikeState {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const next = { ...readState(), ...patch };
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + "\n");
  return next;
}

/** Repo git di prova in una cartella temporanea (realpath: su macOS /var è un link a /private/var). */
export function makeTempRepo(label: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `blue-spike-codex-${label}-`)));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "spike@blue.invalid");
  git("config", "user.name", "Blue Spike");
  writeFileSync(path.join(dir, "README.md"), "# blue spike test repo\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return dir;
}

export async function startServer(opts: ClientOptions): Promise<CodexAppServer> {
  const s = new CodexAppServer(opts);
  const init = await s.initialize({ experimentalApi: false, requestAttestation: false });
  console.log(`initialize ok: platform=${init.platformOs} userAgent=${init.userAgent}`);
  return s;
}

/**
 * Sceglie il modello più economico. model/list non espone prezzi: si usa la descrizione
 * ("affordable", "efficient", "fast") e il nome (luna/mini/nano), preferendo la generazione
 * più recente. Poi lo sforzo minimo disponibile ("low" se c'è).
 */
export function pickCheapest(models: Model[]): { model: string; effort: string } {
  const visible = models.filter((m) => !m.hidden);
  const score = (m: Model) => {
    const d = `${m.id} ${m.description}`.toLowerCase();
    let sc = 10;
    if (/affordable|cheap/.test(d)) sc -= 4;
    if (/efficient|fast|easier/.test(d)) sc -= 2;
    if (/luna|mini|nano|lite|small/.test(d)) sc -= 2;
    if (/older|previous/.test(d)) sc += 1;
    return sc;
  };
  const sorted = [...visible].sort((a, b) => score(a) - score(b));
  const chosen = sorted[0];
  if (!chosen) throw new Error("model/list returned no visible models");
  const efforts = chosen.supportedReasoningEfforts.map((e) => e.reasoningEffort);
  const order = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  const effort = [...efforts].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? chosen.defaultReasoningEffort;
  return { model: chosen.id, effort };
}

export function text(t: string) {
  return { type: "text" as const, text: t, text_elements: [] };
}

/** Statistiche di streaming raccolte per un turno. */
export interface TurnStats {
  turnId: string;
  startedAtMs: number;
  firstDeltaMs: number | null;
  firstAgentDeltaMs: number | null;
  counts: Record<string, number>;
  agentText: string;
  finalMessage: string | null;
  items: { type: string; status?: string; detail?: string }[];
  completed: Turn | null;
  durationMs: number;
}

/**
 * Segue un turno dal `turn/start` fino a `turn/completed`, contando le notifiche ricevute.
 * `onStarted` riceve l'id del turno appena noto (per steer/interrupt).
 */
export async function runTurn(
  s: CodexAppServer,
  start: () => Promise<{ turn: Turn }>,
  hooks: { onEvent?: (n: ServerNotification, turnId: string) => void; timeoutMs?: number } = {},
): Promise<TurnStats> {
  const t0 = Date.now();
  const counts: Record<string, number> = {};
  const buffered: ServerNotification[] = [];
  let turnId: string | null = null;
  let firstDeltaMs: number | null = null;
  let firstAgentDeltaMs: number | null = null;
  let agentText = "";
  let finalMessage: string | null = null;
  const items: TurnStats["items"] = [];

  let resolveDone!: (t: Turn) => void;
  const done = new Promise<Turn>((r) => (resolveDone = r));

  const handle = (n: ServerNotification) => {
    const p = (n as { params?: Record<string, unknown> }).params ?? {};
    const nTurn = (p.turnId as string | undefined) ?? (p.turn as Turn | undefined)?.id;
    if (nTurn && nTurn !== turnId) return;
    counts[n.method] = (counts[n.method] ?? 0) + 1;
    if (firstDeltaMs === null && /delta|Delta/.test(n.method)) firstDeltaMs = Date.now() - t0;
    if (n.method === "item/agentMessage/delta") {
      if (firstAgentDeltaMs === null) firstAgentDeltaMs = Date.now() - t0;
      agentText += n.params.delta;
    }
    if (n.method === "item/completed") {
      const it = n.params.item;
      const entry: TurnStats["items"][number] = { type: it.type };
      if (it.type === "agentMessage") finalMessage = it.text;
      if (it.type === "commandExecution") {
        entry.status = it.status;
        entry.detail = `${it.command} → exit ${it.exitCode}`;
      }
      if (it.type === "fileChange") {
        entry.status = it.status;
        entry.detail = it.changes.map((c) => `${c.kind.type} ${c.path}`).join(", ");
      }
      items.push(entry);
    }
    hooks.onEvent?.(n, turnId!);
    if (n.method === "turn/completed") resolveDone(n.params.turn);
  };

  let timer: NodeJS.Timeout | undefined;
  const off = s.onNotification((n) => {
    if (turnId === null) buffered.push(n);
    else handle(n);
  });
  try {
    const res = await start();
    turnId = res.turn.id;
    for (const n of buffered.splice(0)) handle(n);
    const timeoutMs = hooks.timeoutMs ?? 300_000;
    const completed = await Promise.race([
      done,
      new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`turn ${turnId} timeout`)), timeoutMs))),
      s.exited.then(() => {
        throw new Error("app-server exited during turn");
      }),
    ]);
    return {
      turnId,
      startedAtMs: t0,
      firstDeltaMs,
      firstAgentDeltaMs,
      counts,
      agentText,
      finalMessage,
      items,
      completed,
      durationMs: Date.now() - t0,
    };
  } finally {
    off();
    clearTimeout(timer);
  }
}

export function printStats(label: string, st: TurnStats): void {
  console.log(`\n--- ${label}: turn ${st.turnId} → ${st.completed?.status} in ${st.durationMs} ms`);
  if (st.completed?.error) console.log(`    error: ${st.completed.error.message}`);
  console.log(`    first delta after ${st.firstDeltaMs} ms (first agentMessage delta ${st.firstAgentDeltaMs} ms)`);
  console.log(`    notifications: ${JSON.stringify(st.counts)}`);
  for (const it of st.items) console.log(`    item ${it.type}${it.status ? ` [${it.status}]` : ""}${it.detail ? `: ${it.detail}` : ""}`);
  console.log(`    final message: ${JSON.stringify(st.finalMessage)}`);
}

/** Registro dei risultati (pass/fail) scritto in results/checks.json. */
export function recordCheck(id: string, pass: boolean, evidence: string): void {
  const file = path.join(RESULTS_DIR, "checks.json");
  const all = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  all[id] = { pass, evidence, at: new Date().toISOString() };
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
  console.log(`${pass ? "PASS" : "FAIL"} ${id}: ${evidence}`);
}
