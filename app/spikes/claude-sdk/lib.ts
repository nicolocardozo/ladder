// Shared helpers for the S2 spike: clean env, JSONL logger, input queue, type census.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { SDKMessage, SDKUserMessage, Options } from "@anthropic-ai/claude-agent-sdk";

export const SPIKE_DIR = path.dirname(new URL(import.meta.url).pathname);
export const RESULTS_DIR = path.join(SPIKE_DIR, "results");
export const TMP_DIR = path.join(SPIKE_DIR, ".tmp");
export const LAST_SESSION_FILE = process.env.SESSION_FILE ?? path.join(RESULTS_DIR, "last-session.json");

export const MODEL = process.env.SPIKE_MODEL ?? "haiku";

/**
 * Environment for the claude subprocess.
 * Copies process.env but drops ANTHROPIC_* and CLAUDE* variables: ANTHROPIC_API_KEY would win over the
 * subscription login, and when this script is launched from inside Claude Code (terminal or desktop app)
 * the parent leaks CLAUDECODE, CLAUDE_CODE_SIMPLE (= --bare), ANTHROPIC_BASE_URL (host proxy), etc.
 */
export function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  const dropped: string[] = [];
  for (const k of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE)/.test(k)) {
      dropped.push(k);
      delete env[k];
    }
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "blue-spike-s2/0.0.0";
  // Without this the CLI sends session_state_changed only as sdk_host_only, and the SDK swallows it.
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = "1";
  cleanEnv.dropped = dropped;
  return env;
}
cleanEnv.dropped = [] as string[];

/** Optional: use the user's installed CLI instead of the binary bundled with the SDK. */
export function claudeExecutable(): Partial<Options> {
  const bin = process.env.CLAUDE_BIN;
  return bin ? { pathToClaudeCodeExecutable: bin } : {};
}

export function baseOptions(cwd: string): Options {
  return {
    cwd,
    model: MODEL,
    env: cleanEnv(),
    settingSources: [],
    permissionMode: "default",
    includePartialMessages: true,
    // With a claude.ai login the CLI also connects the account's claude.ai connectors (Gmail, Drive, ...),
    // even with settingSources: []. Blue must opt out explicitly.
    settings: { disableClaudeAiConnectors: true },
    ...claudeExecutable(),
  };
}

/** Creates a fresh git repo for the agent to work in. */
export function makeTestRepo(): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_DIR, "repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# test repo for the Blue S2 spike\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.name=spike", "-c", "user.email=spike@example.invalid", "commit", "-q", "-m", "init"], { cwd: dir });
  return fs.realpathSync(dir);
}

// Keys that could carry personal data; never written to logs.
const REDACT = new Set(["email", "organization", "emailAddress", "account_email"]);

export class JsonlLog {
  readonly file: string;
  readonly t0 = Date.now();
  constructor(name: string) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.file = path.join(RESULTS_DIR, `${name}-${stamp}.jsonl`);
  }
  now(): number {
    return Date.now() - this.t0;
  }
  write(kind: string, data: unknown): void {
    const line = JSON.stringify({ t: this.now(), kind, data }, (k, v) => (REDACT.has(k) ? "[redacted]" : v));
    fs.appendFileSync(this.file, line + "\n");
  }
  note(text: string, extra?: unknown): void {
    this.write("note", extra === undefined ? { text } : { text, extra });
    console.log(`[${(this.now() / 1000).toFixed(1)}s] ${text}`);
  }
}

/** Push-based AsyncIterable used as the streaming `prompt`. */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(text: string): SDKUserMessage {
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    this.items.push(msg);
    this.wake?.();
    return msg;
  }
  close(): void {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      while (this.items.length) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

/** Counts every distinct message type/subtype and keeps the key set of the first sample. */
export class Census {
  readonly rows = new Map<string, { count: number; keys: string[] }>();
  add(m: SDKMessage): void {
    const any = m as Record<string, unknown>;
    let key = String(any.type);
    if (typeof any.subtype === "string") key += `/${any.subtype}`;
    if (any.type === "stream_event") {
      const ev = any.event as Record<string, unknown>;
      key += `:${ev.type}`;
      const d = ev.delta as Record<string, unknown> | undefined;
      if (d?.type) key += `:${d.type}`;
      const cb = ev.content_block as Record<string, unknown> | undefined;
      if (cb?.type) key += `:${cb.type}`;
    }
    if (any.type === "assistant" || (any.type === "user" && Array.isArray((any.message as any)?.content))) {
      const blocks = ((any.message as any)?.content ?? []) as Array<{ type: string }>;
      key += `[${[...new Set(blocks.map((b) => b.type))].join(",")}]`;
    }
    const row = this.rows.get(key);
    if (row) row.count++;
    else this.rows.set(key, { count: 1, keys: Object.keys(any).sort() });
  }
  toJSON(): Record<string, { count: number; keys: string[] }> {
    return Object.fromEntries([...this.rows.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Text of an assistant message's text blocks. */
export function assistantText(m: SDKMessage): string {
  if (m.type !== "assistant") return "";
  return (m.message.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}
