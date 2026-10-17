/**
 * Runs the Plutus server in the Electron main process: the desktop config and the listener.
 * Plan 5.9: loopback only, a free port each launch, the cookie guard always on.
 */

import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { type AppDeps, createApp } from 'plutus-server/dist/app.js'
import type { Config } from 'plutus-server/dist/config.js'
import type { ShellPaths } from './paths.js'

export const LOOPBACK = '127.0.0.1'

export function desktopConfig(base: Config, paths: ShellPaths): Config {
  return {
    ...base,
    webDist: paths.webDist,
    dataDir: paths.dataDir,
    databasePath: paths.databasePath,
    apiGuard: true,
    host: LOOPBACK,
    port: 0,
  }
}

export interface RunningServer {
  /** http://127.0.0.1:<port>, the only origin the window loads. */
  origin: string
  close(): Promise<void>
}

export function startServer(deps: AppDeps & { guardToken: string }): Promise<RunningServer> {
  const app = createApp(deps)
  const { host, port } = deps.config
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: host, port }) as Server
    server.once('error', reject)
    server.once('listening', () => {
      const address = server.address() as AddressInfo
      resolve({
        origin: `http://${LOOPBACK}:${address.port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
            server.closeAllConnections()
          }),
      })
    })
  })
}
