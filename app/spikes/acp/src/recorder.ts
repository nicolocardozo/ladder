// Registro grezzo: una riga JSON per messaggio sul filo, per riga di stderr dell'agente e per nota dello script.
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";

export const RESULTS_DIR = new URL("../results/", import.meta.url).pathname;

export type Direction = "out" | "in" | "stderr" | "note" | "blue";

export class Recorder {
  readonly path: string;
  readonly t0 = performance.now();
  private file: WriteStream;
  private quiet: boolean;

  constructor(name: string, opts: { quiet?: boolean } = {}) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.path = join(RESULTS_DIR, `${name}-${stamp}.jsonl`);
    this.file = createWriteStream(this.path, { flags: "a" });
    this.quiet = opts.quiet ?? false;
  }

  ms(): number {
    return Math.round(performance.now() - this.t0);
  }

  write(dir: Direction, data: unknown): void {
    this.file.write(JSON.stringify({ t: this.ms(), dir, data }) + "\n");
  }

  /** Nota leggibile: va nel file e sulla console. */
  note(label: string, data?: unknown): void {
    this.write("note", { label, data });
    if (!this.quiet) {
      const body = data === undefined ? "" : " " + short(data);
      console.log(`[${String(this.ms()).padStart(6)} ms] ${label}${body}`);
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.file.end(resolve));
  }
}

export function short(data: unknown, max = 400): string {
  const s = typeof data === "string" ? data : JSON.stringify(data);
  return s.length > max ? s.slice(0, max) + "…" : s;
}
