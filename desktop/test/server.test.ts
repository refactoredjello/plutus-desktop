import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from 'plutus-server/config'
import { openDb } from 'plutus-server/db'
import { silentLogger } from 'plutus-server/log'
import { KeySecretStore } from 'plutus-server/secrets'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newGuardToken } from '../src/lib/guard.js'
import type { ShellPaths } from '../src/lib/paths.js'
import { type RunningServer, desktopConfig, startServer } from '../src/lib/server.js'

const paths: ShellPaths = {
  webDist: '/app/Resources/web',
  dataDir: '/data/Plutus',
  databasePath: '/data/Plutus/plutus.sqlite',
  backupDir: '/data/Plutus/backups',
  logFile: '/data/Plutus/logs/plutus.log',
}

describe('desktopConfig', () => {
  it('forces the guard on and the loopback address on port 0, whatever the environment says', () => {
    const base = loadConfig({ PLUTUS_API_GUARD: 'false', HOST: '0.0.0.0', PORT: '8000' })
    const config = desktopConfig(base, paths)
    expect(config.apiGuard).toBe(true)
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(0)
  })

  it('takes the web build and the data locations from the shell paths', () => {
    const config = desktopConfig(loadConfig({ PLUTUS_DATA_DIR: '/elsewhere' }), paths)
    expect(config.webDist).toBe(paths.webDist)
    expect(config.dataDir).toBe(paths.dataDir)
    expect(config.databasePath).toBe(paths.databasePath)
  })

  it('keeps everything else from the base config', () => {
    const base = loadConfig({ LOG_LEVEL: 'warning', LLM_PROVIDER: 'fake' })
    const config = desktopConfig(base, paths)
    expect(config.logLevel).toBe('warning')
    expect(config.defaults).toEqual(base.defaults)
  })
})

describe('startServer', () => {
  let webDist: string
  let running: RunningServer | null
  const token = newGuardToken()

  beforeEach(() => {
    webDist = mkdtempSync(join(tmpdir(), 'plutus-desktop-web-'))
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>Plutus</title><div id="root"></div>')
    running = null
  })

  afterEach(async () => {
    await running?.close()
    rmSync(webDist, { recursive: true, force: true })
  })

  async function start(): Promise<RunningServer> {
    const config = desktopConfig(loadConfig({}), { ...paths, webDist })
    running = await startServer({
      db: openDb(':memory:'),
      secrets: new KeySecretStore('test-only'),
      config,
      log: silentLogger(),
      guardToken: token,
    })
    return running
  }

  it('listens on a free loopback port', async () => {
    const { origin } = await start()
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(new URL(origin).port).not.toBe('0')
  })

  it('rejects /api without the launch cookie', async () => {
    const { origin } = await start()
    const res = await fetch(`${origin}/api/health`)
    expect(res.status).toBe(401)
  })

  it('sets the launch token as an HttpOnly SameSite=Strict cookie on the page', async () => {
    const { origin } = await start()
    const res = await fetch(`${origin}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<div id="root">')
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`plutus_guard=${token}`)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Strict/i)
  })

  it('answers /api with the launch cookie', async () => {
    const { origin } = await start()
    const res = await fetch(`${origin}/api/health`, { headers: { cookie: `plutus_guard=${token}` } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ok', database: 'ok' })
  })

  it('rejects a token from another launch', async () => {
    const { origin } = await start()
    const res = await fetch(`${origin}/api/health`, {
      headers: { cookie: `plutus_guard=${newGuardToken()}` },
    })
    expect(res.status).toBe(401)
  })

  it('stops accepting connections when closed', async () => {
    const server = await start()
    await server.close()
    running = null
    await expect(fetch(`${server.origin}/api/health`)).rejects.toThrow()
  })
})
