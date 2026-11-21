// Un agente ACP per Blue è solo una voce di configurazione: comando, argomenti, ambiente.
// Nessun codice specifico per agente: tutto il resto passa dal protocollo.
import { fileURLToPath } from "node:url";

export type AgentSpec = {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** Variabili aggiunte all'ambiente del processo figlio. */
  env?: Record<string, string>;
  /** Variabili tolte dall'ambiente (per esempio chiavi API che scavalcano il login dell'abbonamento). */
  stripEnv?: string[];
};

const localBin = (name: string) => fileURLToPath(new URL(`../node_modules/.bin/${name}`, import.meta.url));

export const AGENTS: Record<string, AgentSpec> = {
  // Equivale a `npx -y @agentclientprotocol/codex-acp@2.5.0` del registro, ma usa la copia fissata in node_modules.
  codex: {
    id: "codex-acp",
    name: "Codex",
    command: localBin("codex-acp"),
    args: [],
    stripEnv: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  },
  // Riserva: adapter ACP di Claude Code, con il login della CLI.
  claude: {
    id: "claude-acp",
    name: "Claude Agent",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.101.0"],
    stripEnv: ["ANTHROPIC_API_KEY"],
  },
};

/** Chiavi API che Blue toglie sempre dall'ambiente degli agenti: vale il login dell'agente. */
export const STRIP_ENV_ALWAYS = ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY"];

/**
 * `--agent codex|claude` usa le voci locali; `--registry <id>` costruisce la voce dal registro ACP,
 * cioè come farebbe "Aggiungi un agente" in Blue.
 */
export async function resolveAgent(argv = process.argv.slice(2)): Promise<AgentSpec> {
  const r = argv.indexOf("--registry");
  if (r >= 0) {
    const { REGISTRY_URL, specFromRegistry } = await import("./registry.ts");
    const reg = (await (await fetch(REGISTRY_URL)).json()) as import("./registry.ts").Registry;
    const entry = reg.agents.find((a) => a.id === argv[r + 1]);
    const spec = entry && specFromRegistry(entry);
    if (!spec) throw new Error(`agente non trovato o non avviabile dal registro: ${argv[r + 1]}`);
    if ("install" in spec && spec.install) throw new Error("distribuzione binaria: lo spike non scarica archivi");
    return { ...spec, stripEnv: STRIP_ENV_ALWAYS };
  }
  const i = argv.indexOf("--agent");
  const key = i >= 0 ? argv[i + 1] : (process.env.ACP_AGENT ?? "codex");
  const spec = AGENTS[key];
  if (!spec) throw new Error(`agente sconosciuto: ${key} (disponibili: ${Object.keys(AGENTS).join(", ")})`);
  return spec;
}
