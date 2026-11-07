// Impronta strutturale di ~/.codex/config.toml: per ogni chiave stampa solo il percorso e
// 8 caratteri dello SHA-256 del valore. Nessun valore viene mostrato (il file può contenere token).
// Uso: node src/toml-keys.ts > prima.txt ; ... ; node src/toml-keys.ts > dopo.txt ; diff prima.txt dopo.txt
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = process.argv[2] ?? path.join(os.homedir(), '.codex', 'config.toml');
const lines = fs.readFileSync(file, 'utf8').split('\n');
const out: string[] = [];
let table = '';
let curKey = '';
let curVal = '';
const flush = () => {
  if (curKey) out.push(`${table ? table + '.' : ''}${curKey} ${crypto.createHash('sha256').update(curVal.trim()).digest('hex').slice(0, 8)}`);
  curKey = '';
  curVal = '';
};
for (const line of lines) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const h = /^\[\[?([^\]]+)\]\]?$/.exec(t);
  if (h) {
    flush();
    table = h[1].trim();
    out.push(`[${table}]`);
    continue;
  }
  const kv = /^("[^"]*"|'[^']*'|[A-Za-z0-9_.\-"]+)\s*=\s*(.*)$/.exec(t);
  if (kv && !curVal.match(/(\[|"""|''')\s*$/)) {
    flush();
    curKey = kv[1];
    curVal = kv[2];
  } else {
    curVal += '\n' + t; // continuazione di un valore su più righe
  }
}
flush();
console.log(out.join('\n'));
