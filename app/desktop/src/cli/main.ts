// Real entry point of the `ladder` CLI: in development `node src/cli/main.ts`, in the packaged app the bundle
// run with the app binary and ELECTRON_RUN_AS_NODE=1 (see bin/ladder).
import { connectSocket } from './client.ts'
import { run } from './index.ts'

async function stdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

void run(process.argv.slice(2), {
  out: (text) => void process.stdout.write(`${text}${text.endsWith('\n') ? '' : '\n'}`),
  write: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(`${text}\n`),
  stdin,
  env: process.env,
  cwd: process.cwd(),
  connect: connectSocket,
  onInterrupt: (fn) => void process.once('SIGINT', fn)
}).then((code) => {
  // No process.exit(): with output on a pipe it truncates whatever has not been written yet (beyond 64 KB). The process ends on its own.
  process.exitCode = code
})
