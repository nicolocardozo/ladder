// Client ACP generico: avvia un agente su stdio e lo pilota con l'API fluente dell'SDK 2.x (`client()`).
// Non contiene nulla di specifico per un agente: riceve un AgentSpec e parla solo il protocollo v1 stabile.
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentSpec } from "./agents.ts";
import { Recorder, short } from "./recorder.ts";

export type PermissionDecider = (
  req: acp.RequestPermissionRequest,
  signal: AbortSignal,
  requestId: acp.JsonRpcId,
) => acp.RequestPermissionResponse | Promise<acp.RequestPermissionResponse>;

export type UpdateListener = (n: acp.SessionNotification) => void;

export type HostOptions = {
  rec: Recorder;
  /** Capacità annunciate dal client in `initialize`. */
  clientCapabilities?: acp.ClientCapabilities;
  decidePermission?: PermissionDecider;
  /** Radici entro cui i gestori fs/* possono leggere e scrivere. */
  fsRoots?: string[];
};

export const DEFAULT_CLIENT_CAPABILITIES: acp.ClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: false,
};

export type PromptResult = {
  stopReason?: acp.StopReason;
  response?: acp.PromptResponse;
  error?: { code?: number; message: string; data?: unknown };
  updates: acp.SessionNotification[];
  timings: { firstUpdateMs?: number; firstThoughtMs?: number; firstMessageMs?: number; totalMs: number };
};

/** Un processo agente e la sua connessione ACP. */
export class AcpHost {
  readonly spec: AgentSpec;
  readonly child: ChildProcess;
  readonly connection: acp.ClientConnection;
  readonly agent: acp.ClientContext;
  readonly rec: Recorder;
  readonly exited: Promise<number | null>;
  readonly stats = { fsRead: 0, fsWrite: 0, permissionRequests: 0, unknownRequests: [] as string[] };
  initializeResponse?: acp.InitializeResponse;
  private listeners = new Set<UpdateListener>();
  private caps: acp.ClientCapabilities;
  private fsRoots: string[];
  /** Politica per session/request_permission; si può cambiare a connessione aperta. */
  decidePermission: PermissionDecider;

  constructor(spec: AgentSpec, opts: HostOptions) {
    this.spec = spec;
    this.rec = opts.rec;
    this.caps = opts.clientCapabilities ?? DEFAULT_CLIENT_CAPABILITIES;
    this.fsRoots = (opts.fsRoots ?? []).map((p) => resolve(p));
    this.decidePermission = opts.decidePermission ?? firstOptionOfKind("allow_once");

    const env: Record<string, string | undefined> = { ...process.env, ...spec.env };
    for (const k of spec.stripEnv ?? []) delete env[k];
    this.rec.note("spawn", { command: spec.command, args: spec.args, stripped: spec.stripEnv ?? [] });
    this.child = spawn(spec.command, spec.args, { stdio: ["pipe", "pipe", "pipe"], env });
    this.exited = new Promise((res) => this.child.on("exit", (code, signal) => {
      this.rec.note("agent exited", { code, signal });
      res(code);
    }));
    this.child.on("error", (err) => this.rec.note("spawn error", String(err)));
    let errBuf = "";
    this.child.stderr!.on("data", (d: Buffer) => {
      errBuf += d.toString("utf8");
      let i: number;
      while ((i = errBuf.indexOf("\n")) >= 0) {
        this.rec.write("stderr", errBuf.slice(0, i));
        errBuf = errBuf.slice(i + 1);
      }
    });

    const stream = tap(
      acp.ndJsonStream(
        Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>,
      ),
      this.rec,
    );

    const app = acp
      .client({ name: "blue-spike" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        for (const l of this.listeners) l(params);
      })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params, signal, requestId }) => {
        this.stats.permissionRequests++;
        return await this.decidePermission(params, signal, requestId);
      })
      .onRequest(acp.methods.client.fs.readTextFile, async ({ params }) => {
        this.stats.fsRead++;
        const path = this.checkPath(params.path);
        const text = await readFile(path, "utf8");
        if (params.line == null && params.limit == null) return { content: text };
        const lines = text.split("\n");
        const start = Math.max(0, (params.line ?? 1) - 1);
        const end = params.limit == null ? lines.length : start + params.limit;
        return { content: lines.slice(start, end).join("\n") };
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async ({ params }) => {
        this.stats.fsWrite++;
        const path = this.checkPath(params.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, params.content, "utf8");
        return {};
      })
      .onRequest("*", ({ method }) => {
        this.stats.unknownRequests.push(method);
        throw acp.RequestError.methodNotFound(method);
      })
      .onNotification("*", ({ method, params }) => {
        // Estensioni (metodi con "_"): ignorate. Sulla console solo le chiavi, perché per esempio
        // `_auth/status_update` di codex-acp contiene email e piano dell'account (resta nel log grezzo locale).
        this.rec.note("unhandled notification", { method, keys: Object.keys((params as object) ?? {}) });
      });

    this.connection = app.connect(stream);
    this.agent = this.connection.agent;
    this.child.on("exit", () => this.connection.close());
  }

  static start(spec: AgentSpec, opts: HostOptions): AcpHost {
    return new AcpHost(spec, opts);
  }

  onUpdate(l: UpdateListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async initialize(): Promise<acp.InitializeResponse> {
    const t = this.rec.ms();
    const res = await this.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: this.caps,
      clientInfo: { name: "blue-spike", title: "Blue (spike S5)", version: "0.0.0" },
    });
    this.initializeResponse = res;
    this.rec.note("initialize ok", { ms: this.rec.ms() - t, protocolVersion: res.protocolVersion, agentInfo: res.agentInfo });
    return res;
  }

  async newSession(cwd: string, extra: Partial<acp.NewSessionRequest> = {}): Promise<acp.NewSessionResponse> {
    const t = this.rec.ms();
    const res = await this.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [], ...extra });
    this.rec.note("session/new ok", { ms: this.rec.ms() - t, sessionId: res.sessionId });
    return res;
  }

  async setConfig(sessionId: string, configId: string, value: string): Promise<acp.SetSessionConfigOptionResponse> {
    const res = await this.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value });
    this.rec.note("set_config_option", { configId, value });
    return res;
  }

  /** Invia un prompt e raccoglie gli aggiornamenti fino al motivo di fine turno. */
  async prompt(sessionId: string, text: string, opts: { onUpdate?: UpdateListener } = {}): Promise<PromptResult> {
    const t0 = performance.now();
    const updates: acp.SessionNotification[] = [];
    const timings: PromptResult["timings"] = { totalMs: 0 };
    const since = () => Math.round(performance.now() - t0);
    const off = this.onUpdate((n) => {
      if (n.sessionId !== sessionId) return;
      updates.push(n);
      timings.firstUpdateMs ??= since();
      if (n.update.sessionUpdate === "agent_thought_chunk") timings.firstThoughtMs ??= since();
      if (n.update.sessionUpdate === "agent_message_chunk") timings.firstMessageMs ??= since();
      opts.onUpdate?.(n);
    });
    try {
      const response = await this.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      timings.totalMs = since();
      return { stopReason: response.stopReason, response, updates, timings };
    } catch (e) {
      timings.totalMs = since();
      const err = e as { code?: number; message?: string; data?: unknown };
      return { error: { code: err.code, message: err.message ?? String(e), data: err.data }, updates, timings };
    } finally {
      off();
    }
  }

  async cancel(sessionId: string): Promise<void> {
    await this.agent.notify(acp.methods.agent.session.cancel, { sessionId });
    this.rec.note("session/cancel sent");
  }

  /** Chiusura ordinata: chiude stdin e attende l'uscita, poi forza. */
  async close(timeoutMs = 4000): Promise<void> {
    this.connection.close();
    this.child.stdin?.end();
    const done = await Promise.race([this.exited.then(() => true), sleep(timeoutMs).then(() => false)]);
    if (!done) {
      this.child.kill("SIGTERM");
      const done2 = await Promise.race([this.exited.then(() => true), sleep(2000).then(() => false)]);
      if (!done2) this.child.kill("SIGKILL");
    }
  }

  /** Uccide il processo come in un crash. */
  async kill(): Promise<void> {
    this.child.kill("SIGKILL");
    await this.exited;
  }

  private checkPath(p: string): string {
    if (!isAbsolute(p)) throw acp.RequestError.invalidParams({ path: p }, "path must be absolute");
    const abs = resolve(p);
    const ok = this.fsRoots.some((root) => {
      const rel = relative(root, abs);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
    if (!ok) throw acp.RequestError.invalidParams({ path: p }, "path outside session roots");
    return abs;
  }
}

/** Copia ogni messaggio JSON-RPC nel registro, in entrata e in uscita. */
function tap(stream: acp.Stream, rec: Recorder): acp.Stream {
  const inbound = new TransformStream<acp.AnyMessage, acp.AnyMessage>({
    transform(m, c) {
      rec.write("in", m);
      c.enqueue(m);
    },
  });
  const outbound = new TransformStream<acp.AnyMessage, acp.AnyMessage>({
    transform(m, c) {
      rec.write("out", m);
      c.enqueue(m);
    },
  });
  outbound.readable.pipeTo(stream.writable).catch(() => {});
  return { readable: stream.readable.pipeThrough(inbound), writable: outbound.writable };
}

export function firstOptionOfKind(...kinds: acp.PermissionOptionKind[]): PermissionDecider {
  return (req) => {
    for (const kind of kinds) {
      const opt = req.options.find((o) => o.kind === kind);
      if (opt) return { outcome: { outcome: "selected", optionId: opt.optionId } };
    }
    return { outcome: { outcome: "cancelled" } };
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Sceglie i valori più economici tra le opzioni di configurazione, senza conoscere l'agente.
 * ACP non dà prezzi: è un'euristica su id, nome e descrizione. `ACP_MODEL` la scavalca.
 */
export function cheapestChoices(options: acp.SessionConfigOption[] | null | undefined): { configId: string; value: string; name: string }[] {
  const out: { configId: string; value: string; name: string }[] = [];
  for (const o of options ?? []) {
    if (o.type !== "select") continue;
    const flat = flatten(o.options);
    let patterns: RegExp[] = [];
    if (o.category === "model") {
      if (process.env.ACP_MODEL) patterns = [new RegExp(`^${process.env.ACP_MODEL}$`)];
      else patterns = [/affordable|cheap/i, /nano|mini|haiku|flash|lite|small/i, /fast|efficient|light/i];
    } else if (o.category === "thought_level") patterns = [/^(none|off|minimal)$/i, /^low$/i];
    let hit: acp.SessionConfigSelectOption | undefined;
    for (const p of patterns) {
      hit = flat.find((v) => p.test(v.value) || p.test(v.name) || p.test(v.description ?? ""));
      if (hit) break;
    }
    if (hit && hit.value !== o.currentValue) out.push({ configId: o.id, value: hit.value, name: hit.name });
  }
  return out;
}

/** Applica le scelte economiche (due passate: il modello può cambiare i livelli di ragionamento). */
export async function applyCheapest(host: AcpHost, sessionId: string, options: acp.SessionConfigOption[] | null | undefined) {
  for (let pass = 0; pass < 2; pass++) {
    for (const c of cheapestChoices(options)) {
      options = (await host.setConfig(sessionId, c.configId, c.value)).configOptions;
    }
  }
  return options;
}

export function flatten(opts: acp.SessionConfigSelectOptions): acp.SessionConfigSelectOption[] {
  const out: acp.SessionConfigSelectOption[] = [];
  for (const x of opts as Array<acp.SessionConfigSelectOption | acp.SessionConfigSelectGroup>) {
    if ("options" in x) out.push(...x.options);
    else out.push(x);
  }
  return out;
}

export function describeConfig(options: acp.SessionConfigOption[] | null | undefined): unknown[] {
  return (options ?? []).map((o) => ({
    id: o.id,
    name: o.name,
    category: o.category,
    type: o.type,
    current: o.type === "select" ? o.currentValue : (o as { currentValue?: unknown }).currentValue,
    values: o.type === "select" ? flatten(o.options).map((v) => v.value) : undefined,
  }));
}

export { short };
