// Registro ACP: tipi delle voci e conversione in AgentSpec, senza codice per agente.
import type { AgentSpec } from "./agents.ts";

export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

type PackageDist = { package: string; args?: string[]; env?: Record<string, string> };
type BinaryTarget = { archive: string; cmd: string; args?: string[]; env?: Record<string, string>; sha256?: string };

export type RegistryEntry = {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  authors: string[];
  license: string;
  license_url?: string;
  icon: string;
  distribution: { npx?: PackageDist; uvx?: PackageDist; binary?: Record<string, BinaryTarget> };
};

export type Registry = { version: string; agents: RegistryEntry[]; extensions: unknown[] };

/** Chiave di piattaforma usata dal registro, per esempio darwin-aarch64. */
export function platformKey(platform = process.platform, arch = process.arch): string {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  return `${os}-${cpu}`;
}

/**
 * Converte una voce del registro in un comando da avviare.
 * Preferenza: npx, poi uvx, poi binario per la piattaforma (che Blue deve scaricare,
 * verificare con sha256 quando c'è ed estrarre in `installDir`).
 */
export function specFromRegistry(entry: RegistryEntry, installDir = `~/Library/Application Support/Blue/agents/${entry.id}/${entry.version}`): (AgentSpec & { install?: BinaryTarget }) | null {
  const d = entry.distribution;
  const base = { id: entry.id, name: entry.name };
  if (d.npx) return { ...base, command: "npx", args: ["-y", d.npx.package, ...(d.npx.args ?? [])], env: d.npx.env };
  if (d.uvx) return { ...base, command: "uvx", args: [d.uvx.package, ...(d.uvx.args ?? [])], env: d.uvx.env };
  const bin = d.binary?.[platformKey()];
  if (bin) return { ...base, command: `${installDir}/${bin.cmd.replace(/^\.\//, "")}`, args: bin.args ?? [], env: bin.env, install: bin };
  return null;
}
