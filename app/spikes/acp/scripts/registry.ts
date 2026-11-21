// Criterio 8: scarica il registro ACP, salva un campione ridotto e mostra come ogni voce diventa un comando.
import { writeFileSync } from "node:fs";
import { REGISTRY_URL, platformKey, specFromRegistry, type Registry, type RegistryEntry } from "../src/registry.ts";

const SAMPLE_PATH = new URL("../registry-sample.json", import.meta.url);

const res = await fetch(REGISTRY_URL);
if (!res.ok) throw new Error(`registry: HTTP ${res.status}`);
const reg = (await res.json()) as Registry;

// Riduce le voci binarie alla piattaforma corrente più una, per leggibilità.
const trim = (e: RegistryEntry): RegistryEntry => {
  if (!e.distribution.binary) return e;
  const keys = Object.keys(e.distribution.binary);
  const keep = [platformKey(), keys.find((k) => k !== platformKey())].filter((k): k is string => !!k && keys.includes(k));
  return { ...e, distribution: { ...e.distribution, binary: Object.fromEntries(keep.map((k) => [k, e.distribution.binary![k]])) } };
};

const firstFive = reg.agents.slice(0, 5);
const extra = reg.agents.filter((a) => ["codex-acp", "claude-acp", "goose"].includes(a.id) && !firstFive.includes(a));
const sample = {
  _note: `Campione ridotto di ${REGISTRY_URL} (scaricato ${new Date().toISOString().slice(0, 10)}): prime 5 voci più codex-acp, claude-acp e goose; voci binarie ridotte a 2 piattaforme.`,
  version: reg.version,
  agentCount: reg.agents.length,
  extensions: reg.extensions,
  agents: [...firstFive, ...extra].map(trim),
};
writeFileSync(SAMPLE_PATH, JSON.stringify(sample, null, 2) + "\n");

const kinds = { npx: 0, uvx: 0, binary: 0 };
for (const a of reg.agents) for (const k of Object.keys(a.distribution) as (keyof typeof kinds)[]) kinds[k]++;
const unsupported = reg.agents.filter((a) => !specFromRegistry(a)).map((a) => a.id);
const noSha = reg.agents.filter((a) => a.distribution.binary && Object.values(a.distribution.binary).some((b) => !b.sha256)).map((a) => a.id);

console.log(JSON.stringify({
  registryVersion: reg.version,
  agents: reg.agents.length,
  distributionKinds: kinds,
  platform: platformKey(),
  noLaunchOnThisPlatform: unsupported,
  binaryWithoutSha256: noSha,
  authInfoInRegistry: reg.agents.some((a) => "auth" in a),
  examples: ["codex-acp", "claude-acp", "gemini", "goose", "cursor"].map((id) => {
    const e = reg.agents.find((a) => a.id === id);
    const s = e && specFromRegistry(e);
    return s && { id, command: s.command, args: s.args, archive: s.install?.archive };
  }),
  saved: SAMPLE_PATH.pathname,
}, null, 2));
