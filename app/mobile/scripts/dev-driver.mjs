// Development only: local server that passes commands to the app (screenshots and tests without touching the screen).
//   node scripts/dev-driver.mjs            # listens on 127.0.0.1:8099
//   curl -s localhost:8099/cmd -d '{"demo":true,"theme":"daylight","route":"/session/s2","sheet":"request"}'
// The app (__DEV__ only, src/dev-driver.ts) reads GET /cmd every second and runs every new command.
import { createServer } from 'node:http'

// Port: 8099, or DEV_DRIVER_PORT (with the same EXPO_PUBLIC_DEV_DRIVER_PORT for the app).
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
}).listen(PORT, '127.0.0.1', () => console.log(`dev-driver on 127.0.0.1:${PORT} (the Android emulator reaches it as 10.0.2.2)`))
