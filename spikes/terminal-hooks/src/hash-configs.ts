// Stampa lo SHA-256 di ~/.claude/settings.json e ~/.codex/config.toml (solo hash, mai il contenuto).
import { hashGlobalConfigs } from './lib.ts';

for (const [file, hash] of Object.entries(hashGlobalConfigs())) console.log(`${hash}  ${file}`);
