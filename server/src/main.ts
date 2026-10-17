/**
 * Headless entry: open the database, build the app, serve web/dist and /api on a port.
 * The desktop shell does the same in-process with its own secret store and port 0.
 */

import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { openDb } from './db/index.js'
import { createLogger } from './lib/log.js'
import { KeySecretStore } from './secrets.js'
import { applyEnvOverrides } from './services/config.js'

const config = loadConfig()
const log = createLogger({ level: config.logLevel })
const db = openDb(config.databasePath)
const secrets = new KeySecretStore(config.secretKey)
// Headless only: a set environment variable wins at every start (services/config.ts). The
// desktop never calls this and reads only the app_settings table.
const overridden = applyEnvOverrides(db, secrets, process.env)
if (overridden.length > 0) log.info({ settings: overridden }, 'settings from the environment')
const app = createApp({ db, secrets, config, log })

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  log.info(
    { address: info.address, port: info.port, database: config.databasePath, web: config.webDist },
    `Plutus listening on http://${config.host}:${info.port}`,
  )
})

function shutdown(signal: string): void {
  log.info({ signal }, 'shutting down')
  server.close(() => {
    db.$client.close()
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
