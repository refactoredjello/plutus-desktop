import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from 'plutus-server/config'
import { type Db, openDb } from 'plutus-server/db'
import { silentLogger } from 'plutus-server/log'
import { KeySecretStore } from 'plutus-server/secrets'
import { SIMPLEFIN_ACCESS_URL, setSetting } from 'plutus-server/settings'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newGuardToken } from '../src/lib/guard.js'
import { initialPath } from '../src/lib/launch.js'
import { type RunningServer, desktopConfig, startServer } from '../src/lib/server.js'

describe('initialPath', () => {
  const token = newGuardToken()
  const secrets = new KeySecretStore('test-only')
  let webDist: string
  let db: Db
  let running: RunningServer

  beforeEach(async () => {
    webDist = mkdtempSync(join(tmpdir(), 'plutus-desktop-web-'))
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><div id="root"></div>')
    db = openDb(':memory:')
    const config = desktopConfig(loadConfig({}), {
      webDist,
      dataDir: '/data',
      databasePath: ':memory:',
      backupDir: '/data/backups',
      logFile: '/data/logs/plutus.log',
    })
    running = await startServer({ db, secrets, config, log: silentLogger(), guardToken: token })
  })

  afterEach(async () => {
    await running.close()
    rmSync(webDist, { recursive: true, force: true })
  })

  it('opens Settings first on an empty database, where SimpleFIN is not connected', async () => {
    expect(await initialPath(running.origin, token)).toBe('/settings')
  })

  it('opens the Overview once SimpleFIN is connected', async () => {
    setSetting(db, secrets, SIMPLEFIN_ACCESS_URL, 'https://user:pass@bridge.example.test/simplefin', { encrypt: true })
    expect(await initialPath(running.origin, token)).toBe('/')
  })

  it('opens the Overview when the status cannot be read, rather than not opening at all', async () => {
    expect(await initialPath(running.origin, newGuardToken())).toBe('/') // 401: wrong token
    const failing = () => Promise.reject(new Error('connection refused'))
    expect(await initialPath(running.origin, token, failing)).toBe('/')
    const garbled = () => Promise.resolve(new Response('not json', { status: 200 }))
    expect(await initialPath(running.origin, token, garbled)).toBe('/')
  })
})
