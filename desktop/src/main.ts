/**
 * Electron main process: open the database, run the server in-process on a loopback port,
 * and show it in a window. Plan section 8, brief 1F.
 *
 * PLUTUS_SMOKE=1 opens the real window against a throwaway data dir, waits for the SPA to
 * render and reach /api/health through the cookie guard, prints the result, and exits.
 * PLUTUS_SMOKE_SCREENSHOT=<file.png> also saves what the window showed.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, app, dialog, safeStorage, shell } from 'electron'
import { loadConfig } from 'plutus-server/config'
import { type Db, openDb } from 'plutus-server/db'
import { type Logger, createLogger } from 'plutus-server/log'
import { type Scheduler, createScheduler } from 'plutus-server/scheduler'
import { newGuardToken } from './lib/guard.js'
import { classifyNavigation } from './lib/navigation.js'
import { resolvePaths, userDataDir } from './lib/paths.js'
import { SafeStorageSecretStore } from './lib/secrets.js'
import { type RunningServer, desktopConfig, startServer } from './lib/server.js'
import { pollUntil } from './lib/smoke.js'

const SMOKE = process.env.PLUTUS_SMOKE === '1'
const SMOKE_TIMEOUT_MS = 30_000

// Before anything reads userData: the single-instance lock, safeStorage, and the database.
app.setPath(
  'userData',
  SMOKE
    ? mkdtempSync(join(tmpdir(), 'plutus-smoke-'))
    : userDataDir({ isPackaged: app.isPackaged, appDataPath: app.getPath('appData') }),
)

let log: Logger | null = null
let db: Db | null = null
let server: RunningServer | null = null
let scheduler: Scheduler | null = null
let mainWindow: BrowserWindow | null = null
let origin = ''
let stopped = false

function openOutside(url: string): void {
  if (classifyNavigation(url, origin) === 'external') void shell.openExternal(url)
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: 'Plutus',
    show: false,
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (classifyNavigation(url, origin) === 'app') return { action: 'allow' }
    openOutside(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (classifyNavigation(url, origin) === 'app') return
    event.preventDefault()
    openOutside(url)
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  void win.loadURL(`${origin}/`)
  return win
}

async function start(): Promise<void> {
  const paths = resolvePaths({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
  })
  const config = desktopConfig(loadConfig(process.env), paths)
  log = createLogger({ level: config.logLevel })
  const secrets = new SafeStorageSecretStore(safeStorage)
  db = openDb(paths.databasePath)
  scheduler = createScheduler({ db, secrets, defaults: config.defaults, log })
  server = await startServer({ db, secrets, config, log, guardToken: newGuardToken(), scheduler })
  origin = server.origin
  log.info(
    { origin, database: paths.databasePath, web: paths.webDist, electron: process.versions.electron },
    'Plutus desktop started',
  )
  scheduler.start() // only when the config enables it
  mainWindow = createWindow()
  if (SMOKE) void smoke(mainWindow)
}

/** Stops background work, the server, and the database, in that order. Runs once. */
async function shutdown(): Promise<void> {
  if (stopped) return
  stopped = true
  scheduler?.stop()
  scheduler = null
  await server?.close()
  server = null
  db?.$client.close()
  db = null
}

// Runs in the page: the SPA rendered and its own fetch reaches /api through the cookie guard.
const PAGE_PROBE = `(async () => {
  const heading = document.querySelector('main h1')?.textContent ?? null
  if (heading !== 'Overview') return null
  const res = await fetch('/api/health', { credentials: 'include' })
  const body = await res.json()
  if (res.status !== 200 || body.status !== 'ok' || body.database !== 'ok') return null
  return {
    brand: document.querySelector('header nav span')?.textContent ?? null,
    heading,
    health: { status: res.status, body },
    cookieReadableByPage: document.cookie.includes('plutus_guard'),
  }
})()`

async function smoke(win: BrowserWindow): Promise<void> {
  let code = 1
  try {
    const page = await pollUntil(
      () => win.webContents.executeJavaScript(PAGE_PROBE) as Promise<Record<string, unknown> | null>,
      { timeoutMs: SMOKE_TIMEOUT_MS, intervalMs: 250 },
    )
    const unguarded = await fetch(`${origin}/api/health`)
    const ok = page.cookieReadableByPage === false && unguarded.status === 401
    const screenshot = process.env.PLUTUS_SMOKE_SCREENSHOT
    if (screenshot) writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG())
    console.log(
      JSON.stringify(
        {
          smoke: ok ? 'ok' : 'failed',
          packaged: app.isPackaged,
          electron: process.versions.electron,
          node: process.versions.node,
          origin,
          page,
          withoutCookie: { status: unguarded.status },
        },
        null,
        2,
      ),
    )
    code = ok ? 0 : 1
  } catch (err) {
    console.log(JSON.stringify({ smoke: 'failed', origin, error: String(err) }, null, 2))
  }
  await shutdown()
  app.exit(code)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (!mainWindow && server) mainWindow = createWindow()
  })

  // Windows are closed by now. A second app.quit() after preventDefault never completes, so
  // exit directly once the server and database are closed.
  app.on('will-quit', (event) => {
    if (stopped) return
    event.preventDefault()
    void shutdown().finally(() => app.exit(0))
  })

  app
    .whenReady()
    .then(start)
    .catch((err: unknown) => {
      log?.error({ err }, 'Plutus desktop failed to start')
      if (SMOKE) {
        console.log(JSON.stringify({ smoke: 'failed', error: String(err) }, null, 2))
      } else {
        dialog.showErrorBox('Plutus could not start', err instanceof Error ? err.message : String(err))
      }
      void shutdown().finally(() => app.exit(1))
    })
}
