// Collega host, normalizzatore e registro; usato dagli script di verifica.
import type * as acp from "@agentclientprotocol/sdk";
import type { AcpHost, PermissionDecider, PromptResult } from "./acp-client.ts";
import { AcpNormalizer, type BlueEvent } from "./normalize.ts";
import type { Recorder } from "./recorder.ts";

export type Observer = {
  norm: AcpNormalizer;
  /** Conteggio dei tipi di session/update ricevuti (dall'ultimo reset). */
  kinds: Map<string, number>;
  emit: (evs: BlueEvent[]) => void;
  events: BlueEvent[];
};

export function observe(host: AcpHost, rec: Recorder, opts: { echo?: boolean } = {}): Observer {
  const norm = new AcpNormalizer();
  const kinds = new Map<string, number>();
  const events: BlueEvent[] = [];
  const emit = (evs: BlueEvent[]) => {
    for (const e of evs) {
      events.push(e);
      rec.write("blue", e);
      if ((opts.echo ?? true) && !e.type.endsWith(".delta")) rec.note(`  blue ${e.type}`, e.payload);
    }
  };
  host.onUpdate((n) => {
    const k = n.update.sessionUpdate;
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
    emit(norm.update(n.update));
  });
  return { norm, kinds, emit, events };
}

/** Risponde alle richieste di permesso secondo una sequenza di preferenze, una per richiesta. */
export function scriptedPermissions(rec: Recorder, obs: Observer, plan: acp.PermissionOptionKind[][]): PermissionDecider & { log: unknown[] } {
  const log: unknown[] = [];
  let i = 0;
  const decide = (req: acp.RequestPermissionRequest, signal: AbortSignal, requestId: acp.JsonRpcId): acp.RequestPermissionResponse => {
    obs.emit(obs.norm.permissionOpened(req, requestId));
    const prefs = plan[Math.min(i, plan.length - 1)] ?? [];
    i++;
    let res: acp.RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
    if (!signal.aborted) {
      for (const kind of prefs) {
        const opt = req.options.find((o) => o.kind === kind);
        if (opt) {
          res = { outcome: { outcome: "selected", optionId: opt.optionId } };
          break;
        }
      }
    }
    const entry = {
      n: i,
      toolCall: { id: req.toolCall.toolCallId, title: req.toolCall.title, kind: req.toolCall.kind },
      offered: req.options.map((o) => ({ optionId: o.optionId, kind: o.kind, name: o.name })),
      chosen: res.outcome,
    };
    log.push(entry);
    rec.note("PERMISSION", entry);
    obs.emit(obs.norm.permissionResolved(requestId, res));
    return res;
  };
  return Object.assign(decide, { log });
}

export async function runTurn(host: AcpHost, obs: Observer, sessionId: string, text: string): Promise<PromptResult> {
  obs.kinds.clear();
  host.rec.note("PROMPT", text);
  obs.emit(obs.norm.turnStarted(text));
  const r = await host.prompt(sessionId, text);
  obs.emit(obs.norm.turnEnded(r));
  host.rec.note("TURN END", {
    stopReason: r.stopReason,
    error: r.error,
    timings: r.timings,
    updateKinds: Object.fromEntries(obs.kinds),
  });
  return r;
}

export function finalText(obs: Observer): string {
  const done = obs.events.filter((e) => e.type === "message.completed");
  return String(done.at(-1)?.payload.text ?? "");
}

/** Sceglie la modalità più restrittiva che chiede approvazioni, o quella indicata in ACP_MODE. */
export function pickApprovalMode(options: acp.SessionConfigOption[] | null | undefined): { configId: string; value: string } | null {
  const mode = (options ?? []).find((o) => o.category === "mode" && o.type === "select");
  if (!mode || mode.type !== "select") return null;
  const values = (mode.options as acp.SessionConfigSelectOption[]).filter((v) => "value" in v);
  const want = process.env.ACP_MODE;
  const hit = want ? values.find((v) => v.value === want) : values.find((v) => /approval|ask/i.test(`${v.name} ${v.description ?? ""}`));
  return hit ? { configId: mode.id, value: hit.value } : null;
}
