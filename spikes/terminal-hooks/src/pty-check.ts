// Verifica minima: node-pty carica il binario nativo e avvia un processo in un PTY.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve('node-pty/package.json'));
const pty = require('node-pty') as typeof import('node-pty');

const helper = path.join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
if (fs.existsSync(helper)) {
  const mode = fs.statSync(helper).mode & 0o777;
  console.log(`spawn-helper: ${helper} mode=${mode.toString(8)}`);
}

const p = pty.spawn('/bin/sh', ['-c', 'echo pty-ok; tty; stty size'], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
});
let out = '';
p.onData((d) => (out += d));
p.onExit(({ exitCode }) => {
  console.log(out.trim());
  console.log(`exit=${exitCode} node=${process.version} abi=${process.versions.modules} ${process.platform}-${process.arch}`);
});
