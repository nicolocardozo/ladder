// Client JSON-RPC minimale per `codex app-server` su stdio (JSONL, campo "jsonrpc" omesso).
// Tipi importati dai binding generati con `codex app-server generate-ts` per la versione fissata.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ClientRequest,
  InitializeParams,
  InitializeResponse,
  RequestId,
  ServerNotification,
  ServerRequest,
} from "../generated/stable/index.ts";
import type {
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  ModelListResponse,
  ThreadItemsListResponse,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadSetNameResponse,
  ThreadStartResponse,
  ThreadTurnsListResponse,
  TurnInterruptResponse,
  TurnStartResponse,
  TurnSteerResponse,
} from "../generated/stable/v2/index.ts";

export const SPIKE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RESULTS_DIR = path.join(SPIKE_DIR, "results");
const CODEX_JS = path.join(SPIKE_DIR, "node_modules", "@openai", "codex", "bin", "codex.js");

// ---- Tipi derivati dai binding generati ------------------------------------------------

export type ClientMethod = ClientRequest["method"];
export type ParamsOf<M extends ClientMethod> = Extract<ClientRequest, { method: M }>["params"];

/** I binding non includono una mappa metodo → risposta: la teniamo qui per i metodi usati. */
interface ResponseMap {
  initialize: InitializeResponse;
  "account/read": GetAccountResponse;
  "account/rateLimits/read": GetAccountRateLimitsResponse;
  "model/list": ModelListResponse;
  "thread/start": ThreadStartResponse;
  "thread/resume": ThreadResumeResponse;
  "thread/read": ThreadReadResponse;
  "thread/list": ThreadListResponse;
  "thread/turns/list": ThreadTurnsListResponse;
  "thread/items/list": ThreadItemsListResponse;
  "thread/name/set": ThreadSetNameResponse;
  "turn/start": TurnStartResponse;
  "turn/steer": TurnSteerResponse;
  "turn/interrupt": TurnInterruptResponse;
}
export type ResultOf<M extends ClientMethod> = M extends keyof ResponseMap ? ResponseMap[M] : unknown;

export type NotificationMethod = ServerNotification["method"];
export type Notification<M extends NotificationMethod = NotificationMethod> = Extract<ServerNotification, { method: M }>;
/** Parametri della notifica `M` (non distributivo, così resta usabile dentro funzioni generiche). */
export type NotifParams<M extends NotificationMethod> = [Notification<M>] extends [{ params: infer P }] ? P : never;
export type ServerRequestMethod = ServerRequest["method"];
export type ServerReq<M extends ServerRequestMethod = ServerRequestMethod> = Extract<ServerRequest, { method: M }>;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}
export class RpcRequestError extends Error {
  readonly rpc: RpcError;
  constructor(method: string, rpc: RpcError) {
    super(`${method} → ${rpc.code} ${rpc.message}`);
    this.rpc = rpc;
  }
}

/** Risposta a una richiesta del server: `result` oppure `error`. */
export type ServerRequestReply = { result: unknown } | { error: RpcError };
export type ServerRequestHandler = (req: ServerRequest) => Promise<ServerRequestReply> | ServerRequestReply;

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ClientOptions {
  /** Nome del file JSONL in results/ (senza estensione). */
  logName: string;
  /** Override `-c key=value` passati a `codex app-server`. */
  configOverrides?: string[];
  requestTimeoutMs?: number;
}

// ---- Redazione: nel log non finiscono email né identificativi dell'account ----------------
const REDACT_KEYS = new Set(["email", "accountId", "workspaceName", "accessToken", "refreshToken", "idToken", "apiKey"]);
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = REDACT_KEYS.has(k) && v != null ? "[redacted]" : redact(v);
    return out;
  }
  return value;
}

export class CodexAppServer {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly logFile: string;
  readonly startedAt = Date.now();
  /** Conteggio per metodo di tutte le notifiche e richieste ricevute dal server. */
  readonly counts = new Map<string, number>();
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  #nextId = 1;
  #pending = new Map<RequestId, Pending>();
  #listeners = new Set<(n: ServerNotification) => void>();
  #requestHandler: ServerRequestHandler | null = null;
  #timeoutMs: number;
  #closed = false;

  constructor(opts: ClientOptions) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    this.logFile = path.join(RESULTS_DIR, `${opts.logName}.jsonl`);
    this.#timeoutMs = opts.requestTimeoutMs ?? 60_000;
    const args = [CODEX_JS, "app-server"];
    for (const c of opts.configOverrides ?? []) args.push("-c", c);
    // CODEX_HOME resta quello di default: riusa il login dell'utente.
    this.proc = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.#log("meta", { event: "spawn", pid: this.proc.pid, args: args.slice(1) });

    createInterface({ input: this.proc.stdout }).on("line", (line) => this.#onLine(line));
    createInterface({ input: this.proc.stderr }).on("line", (line) => this.#log("stderr", line));
    this.exited = new Promise((resolve) => {
      this.proc.on("exit", (code, signal) => {
        this.#closed = true;
        this.#log("meta", { event: "exit", code, signal });
        for (const p of this.#pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error(`app-server exited (${signal ?? code}) during ${p.method}`));
        }
        this.#pending.clear();
        resolve({ code, signal });
      });
    });
  }

  // ---- Logging ----------------------------------------------------------------------------
  #log(dir: "->" | "<-" | "stderr" | "meta", msg: unknown): void {
    const rec = { t: Date.now() - this.startedAt, dir, msg: redact(msg) };
    appendFileSync(this.logFile, JSON.stringify(rec) + "\n");
  }
  note(event: string, data: Record<string, unknown> = {}): void {
    this.#log("meta", { event, ...data });
  }

  // ---- Lettura dal server -----------------------------------------------------------------
  #onLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.#log("stderr", { unparsable: line });
      return;
    }
    this.#log("<-", msg);
    const hasId = "id" in msg && msg.id !== null && msg.id !== undefined;
    if (hasId && typeof msg.method === "string") {
      this.#bump(msg.method);
      void this.#handleServerRequest(msg as unknown as ServerRequest);
    } else if (hasId) {
      const p = this.#pending.get(msg.id as RequestId);
      if (!p) return;
      this.#pending.delete(msg.id as RequestId);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcRequestError(p.method, msg.error as RpcError));
      else p.resolve(msg.result);
    } else if (typeof msg.method === "string") {
      this.#bump(msg.method);
      const n = msg as unknown as ServerNotification;
      for (const l of this.#listeners) l(n);
    }
  }

  #bump(method: string): void {
    this.counts.set(method, (this.counts.get(method) ?? 0) + 1);
  }

  async #handleServerRequest(req: ServerRequest): Promise<void> {
    let reply: ServerRequestReply;
    try {
      reply = this.#requestHandler
        ? await this.#requestHandler(req)
        : { error: { code: -32601, message: `blue spike: no handler for ${req.method}` } };
    } catch (e) {
      reply = { error: { code: -32603, message: String(e) } };
    }
    this.#write({ id: req.id, ...reply });
  }

  #write(msg: Record<string, unknown>): void {
    if (this.#closed) return;
    this.#log("->", msg);
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  // ---- API --------------------------------------------------------------------------------
  request<M extends ClientMethod>(method: M, params: ParamsOf<M>, timeoutMs = this.#timeoutMs): Promise<ResultOf<M>> {
    return this.requestRaw(method, params, timeoutMs) as Promise<ResultOf<M>>;
  }

  /** Senza tipi: per i metodi sperimentali (richiedono `experimentalApi: true` nell'handshake). */
  requestRaw(method: string, params: unknown, timeoutMs = this.#timeoutMs): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#write(params === undefined ? { id, method } : { id, method, params });
    });
  }

  notify(method: "initialized"): void {
    this.#write({ method });
  }

  /** Handshake: `initialize` seguito dalla notifica `initialized`. */
  async initialize(capabilities: InitializeParams["capabilities"] = null): Promise<InitializeResponse> {
    const res = await this.request("initialize", {
      clientInfo: { name: "blue", title: "Blue", version: "0.0.0" },
      capabilities,
    });
    this.notify("initialized");
    return res;
  }

  onNotification(fn: (n: ServerNotification) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  on<M extends NotificationMethod>(method: M, fn: (params: NotifParams<M>) => void): () => void {
    return this.onNotification((n) => {
      if (n.method === method) fn((n as { params: unknown }).params as NotifParams<M>);
    });
  }

  setRequestHandler(fn: ServerRequestHandler): void {
    this.#requestHandler = fn;
  }

  /** Attende la prima notifica `method` che soddisfa `pred`. */
  waitFor<M extends NotificationMethod>(
    method: M,
    pred: (params: NotifParams<M>) => boolean = () => true,
    timeoutMs = 180_000,
  ): Promise<NotifParams<M>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timeout after ${timeoutMs}ms waiting for ${method}`));
      }, timeoutMs);
      const off = this.on(method, (p) => {
        if (!pred(p)) return;
        clearTimeout(timer);
        off();
        resolve(p);
      });
      void this.exited.then(() => {
        clearTimeout(timer);
        off();
        reject(new Error(`app-server exited while waiting for ${method}`));
      });
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    this.note("kill", { signal });
    this.proc.kill(signal);
    return this.exited;
  }

  /** Chiusura ordinata: chiude stdin e aspetta l'uscita (con SIGTERM di riserva). */
  async close(graceMs = 3_000): Promise<void> {
    if (this.#closed) return;
    this.proc.stdin.end();
    const t = setTimeout(() => this.proc.kill("SIGTERM"), graceMs);
    await this.exited;
    clearTimeout(t);
  }
}
