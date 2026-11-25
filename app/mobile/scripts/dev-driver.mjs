// Solo sviluppo: server locale che passa comandi all'app (screenshot e prove senza toccare lo schermo).
//   node scripts/dev-driver.mjs            # in ascolto su 127.0.0.1:8099
//   curl -s localhost:8099/cmd -d '{"demo":true,"theme":"daylight","route":"/session/s2","sheet":"request"}'
// L'app (solo __DEV__, src/dev-driver.ts) legge GET /cmd ogni secondo ed esegue ogni comando nuovo.
import { createServer } from 'node:http'

// Porta: 8099, o DEV_DRIVER_PORT (con la stessa EXPO_PUBLIC_DEV_DRIVER_PORT per l'app).
const PORT = Number(process.env.DEV_DRIVER_PORT ?? 8099)
let current = { id: 0 }
createServer((req, res) => {
  if (req.method === 'POST') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      current = { ...JSON.parse(body || '{}'), id: current.id + 1 }
      res.end(String(current.id))
    })
    return
  }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(current))
}).listen(PORT, '127.0.0.1', () => console.log(`dev-driver su 127.0.0.1:${PORT} (l'emulatore Android lo raggiunge come 10.0.2.2)`))
