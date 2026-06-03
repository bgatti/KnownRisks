#!/usr/bin/env node
// Service-dispatching start script. Railway provides RAILWAY_SERVICE_NAME
// for every container; we use it to route a single `npm start` to the
// correct entry point per service.
//
//   web-app          → vite (the existing default)
//   capture-worker   → node capture-worker.js (the standalone ADS-B poller)
//   (no env / local) → vite
//
// Lets a single deploy upload the same noise/web directory to both
// services without a per-service start-command override in the Railway
// dashboard (which my earlier deploys reset when the dashboard wasn't
// pinned). Adding a new worker service later = add a case here.

const svc = (process.env.RAILWAY_SERVICE_NAME || '').trim()
console.log(`[start] RAILWAY_SERVICE_NAME="${svc}"`)

if (svc === 'capture-worker') {
  console.log('[start] dispatching → capture-worker.js')
  await import('./capture-worker.js')
} else {
  console.log('[start] dispatching → vite (web server)')
  // Vite expects to be invoked as a CLI. Replace argv so its bin script
  // sees the same flags the previous `npm start` set.
  process.argv = [process.argv[0], './node_modules/vite/bin/vite.js', '--host', '0.0.0.0', '--mode', 'production']
  await import('./node_modules/vite/bin/vite.js')
}
