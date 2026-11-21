// Utilità comuni dello spike S6: PTY + schermo headless, server degli hook, repo temporanei, hash.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { IPty } from 'node-pty';

const require = createRequire(import.meta.url);
const pty = require('node-pty') as typeof import('node-pty');
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');

export const ROOT = path.resolve(import.meta.dirname, '..');
const T0 = performance.now();
/** Millisecondi dall'avvio dello script, con un decimale. */
export const now = (): number => Math.round((performance.now() - T0) * 10) / 10;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- hash della configurazione globale ----------

const GLOBAL_CONFIGS = [
  path.join(os.homedir(), '.claude', 'settings.json'),
  path.join(os.homedir(), '.codex', 'config.toml'),
];

/** SHA-256 dei file di configurazione globali (il contenuto non viene mai stampato). */
export function hashGlobalConfigs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of GLOBAL_CONFIGS) {
    const key = f.replace(os.homedir(), '~');
    try {
      out[key] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    } catch {
      out[key] = 'missing';
    }
  }
  return out;
}

// ---------- cartelle di lavoro ----------

export function makeRunDir(name: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(ROOT, 'results', `${name}-${stamp}`);
  fs.mkdirSync(path.join(dir, 'screens'), { recursive: true });
  return dir;
}

/** Repo git temporaneo in os.tmpdir(), con percorso reale (/private/var/...). */
export function makeTempRepo(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=blue-spike', '-c', 'user.email=spike@example.invalid', ...args], {
      cwd: dir,
      stdio: 'ignore',
    });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo di prova S6\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'alfa\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'beta\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

/**
 * Ambiente pulito per il figlio, come lo avrebbe Blue avviato dal Finder: solo variabili di base.
 * Niente ANTHROPIC_*, CLAUDE*, OPENAI_*: così vale il login in abbonamento della CLI.
 */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const keep = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING'];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k] as string;
  env.LANG ??= 'en_US.UTF-8';
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return { ...env, ...extra };
}

// ---------- server degli hook ----------

export type HookHit = {
  t: number;
  route: string; // cmd | http | notify | codex-hook
  event: string;
  tokenOk: boolean;
  body: any;
};

export type HookServer = {
  port: number;
  url: string;
  hits: HookHit[];
  on: (fn: (h: HookHit) => void) => void;
  waitFor: (pred: (h: HookHit) => boolean, timeoutMs: number, label: string, since?: number) => Promise<HookHit>;
  close: () => void;
};

/** Server HTTP locale: POST /<route>/<Event> registra il corpo JSON. Risponde 200 senza corpo (nessuna decisione). */
export async function startHookServer(token: string, logFile: string): Promise<HookServer> {
  const hits: HookHit[] = [];
  const listeners = new Set<(h: HookHit) => void>();
  const log = fs.createWriteStream(logFile);
  const server = http.createServer((req, res) => {
    const t = now();
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const [, route = '', event = ''] = (req.url ?? '').split('?')[0].split('/');
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: any = raw;
      try {
        body = JSON.parse(raw);
      } catch {}
      const hit: HookHit = { t, route, event: decodeURIComponent(event), tokenOk: req.headers['x-blue-token'] === token, body };
      hits.push(hit);
      log.write(JSON.stringify(hit) + '\n');
      for (const l of listeners) l(hit);
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    hits,
    on: (fn) => listeners.add(fn),
    waitFor(pred, timeoutMs, label, since = -1) {
      const found = hits.find((h) => h.t > since && pred(h));
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(fn);
          reject(new Error(`timeout hook: ${label}`));
        }, timeoutMs);
        const fn = (h: HookHit) => {
          if (h.t > since && pred(h)) {
            clearTimeout(timer);
            listeners.delete(fn);
            resolve(h);
          }
        };
        listeners.add(fn);
      });
    },
    close: () => {
      server.close();
      log.end();
    },
  };
}

// ---------- PTY con schermo headless (xterm.js) ----------

export type OscHit = { t: number; code: number; data: string };

export type PtySession = {
  pty: IPty;
  screen: () => string;
  send: (s: string, label?: string) => void;
  /** Risolve con l'istante (ms) del chunk che ha reso vero il predicato sullo schermo. */
  waitScreen: (pred: (screen: string) => boolean, timeoutMs: number, label: string) => Promise<number>;
  snapshot: (name: string) => string;
  /** Callback dopo ogni chunk analizzato, con lo schermo corrente e l'istante di arrivo del chunk. */
  onScreen: (fn: (screen: string, t: number) => void) => void;
  osc: OscHit[];
  bells: number[];
  exited: Promise<{ exitCode: number; signal?: number; t: number }>;
  lastOutputAt: () => number;
  close: () => void;
};

export function startPty(opts: {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  runDir: string;
  cols?: number;
  rows?: number;
}): PtySession {
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 40;
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
  const raw = fs.createWriteStream(path.join(opts.runDir, 'pty.raw'));
  const timeline = fs.createWriteStream(path.join(opts.runDir, 'pty-timeline.jsonl'));
  const osc: OscHit[] = [];
  const bells: number[] = [];
  // Istanti dei chunk in attesa di parsing: gli handler OSC/BEL girano durante il parsing del primo.
  const pending: number[] = [];
  const cur = () => pending[0] ?? now();
  for (const code of [0, 2, 9, 99, 777]) {
    term.parser.registerOscHandler(code, (data) => {
      osc.push({ t: cur(), code, data });
      timeline.write(JSON.stringify({ t: cur(), osc: code, data }) + '\n');
      return false;
    });
  }
  term.onBell(() => {
    bells.push(cur());
    timeline.write(JSON.stringify({ t: cur(), bell: true }) + '\n');
  });

  const p = pty.spawn(opts.file, opts.args, { name: 'xterm-256color', cols, rows, cwd: opts.cwd, env: opts.env });
  // Le risposte del terminale (DSR, DA, colori) tornano al processo come farebbe xterm.js in Blue.
  term.onData((d) => {
    timeline.write(JSON.stringify({ t: now(), dir: 'reply', d }) + '\n');
    p.write(d);
  });

  const screen = () => {
    const b = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < term.rows; i++) lines.push(b.getLine(b.baseY + i)?.translateToString(true) ?? '');
    return lines.join('\n');
  };

  type Waiter = { pred: (s: string) => boolean; resolve: (t: number) => void };
  const waiters = new Set<Waiter>();
  const screenListeners = new Set<(screen: string, t: number) => void>();
  let lastOut = 0;
  p.onData((d) => {
    const t = now();
    lastOut = t;
    raw.write(d);
    timeline.write(JSON.stringify({ t, dir: 'out', d }) + '\n');
    pending.push(t);
    term.write(d, () => {
      pending.shift();
      if (waiters.size === 0 && screenListeners.size === 0) return;
      const s = screen();
      for (const l of screenListeners) l(s, t);
      for (const w of [...waiters]) {
        if (w.pred(s)) {
          waiters.delete(w);
          w.resolve(t);
        }
      }
    });
  });

  const exited = new Promise<{ exitCode: number; signal?: number; t: number }>((resolve) => {
    p.onExit(({ exitCode, signal }) => {
      timeline.write(JSON.stringify({ t: now(), exit: exitCode, signal }) + '\n');
      resolve({ exitCode, signal, t: now() });
    });
  });

  let snapN = 0;
  return {
    pty: p,
    screen,
    send(s, label) {
      timeline.write(JSON.stringify({ t: now(), dir: 'in', d: s, label }) + '\n');
      p.write(s);
    },
    waitScreen(pred, timeoutMs, label) {
      if (pred(screen())) return Promise.resolve(now());
      return new Promise((resolve, reject) => {
        const w: Waiter = { pred, resolve: (t) => (clearTimeout(timer), resolve(t)) };
        const timer = setTimeout(() => {
          waiters.delete(w);
          reject(new Error(`timeout schermo: ${label}`));
        }, timeoutMs);
        waiters.add(w);
      });
    },
    snapshot(name) {
      const s = screen();
      const file = path.join(opts.runDir, 'screens', `${String(++snapN).padStart(2, '0')}-${name}.txt`);
      fs.writeFileSync(file, s.replace(/\s+$/gm, '') + '\n');
      return s;
    },
    onScreen: (fn) => screenListeners.add(fn),
    osc,
    bells,
    exited,
    lastOutputAt: () => lastOut,
    close() {
      try {
        p.kill();
      } catch {}
      raw.end();
      timeline.end();
    },
  };
}

/** Attende che l'output del PTY resti fermo per `quietMs`. */
export async function waitQuiet(s: PtySession, quietMs: number, timeoutMs: number): Promise<void> {
  const start = now();
  while (now() - start < timeoutMs) {
    if (now() - s.lastOutputAt() >= quietMs) return;
    await sleep(50);
  }
}

/** Digita un testo nel PTY e lo invia con Invio, come farebbe una persona (testo, pausa, CR). */
export async function typeLine(s: PtySession, text: string, label: string): Promise<number> {
  s.send(text, label);
  await sleep(400);
  const t = now();
  s.send('\r', `${label}:enter`);
  return t;
}
