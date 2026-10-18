/**
 * Electron main process: open the database, run the server in-process on a loopback port,
 * and show it in a window.
 *
 * --data-dir <folder> runs a second profile: its own database, log, and single-instance lock.
 * PLUTUS_DEVTOOLS=1 opens the DevTools panel in dev builds (ignored when packaged).
 *
 * PLUTUS_SMOKE=1 opens the real window against a throwaway data dir (or --data-dir), waits for
 * the SPA to render its first page and reach /api through the cookie guard, prints the result,
 * and exits. PLUTUS_SMOKE_SCREENSHOT=<file.png> also saves what the window showed.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BrowserWindow,
  type MenuItemConstructorOptions,
  Menu,
  app,
  dialog,
  safeStorage,
  shell,
} from 'electron'
import { type Config, loadConfig } from 'plutus-server/config'
import { type Db, openDb } from 'plutus-server/db'
import { type Logger, createLogger } from 'plutus-server/log'
import { type Scheduler, createScheduler } from 'plutus-server/scheduler'
import { type ShellArgs, parseShellArgs } from './lib/args.js'
import { shouldOpenDevTools } from './lib/devtools.js'
import { newGuardToken } from './lib/guard.js'
import { initialPath } from './lib/launch.js'
import { fileLogDestination } from './lib/logfile.js'
import { classifyNavigation } from './lib/navigation.js'
import { resolvePaths, userDataDir } from './lib/paths.js'
import { SafeStorageSecretStore } from './lib/secrets.js'
import { type RunningServer, desktopConfig, startServer } from './lib/server.js'
import { pollUntil } from './lib/smoke.js'
import { startupDialog } from './lib/startup.js'

const SMOKE = process.env.PLUTUS_SMOKE === '1'
const SMOKE_TIMEOUT_MS = 30_000

function readArgs(): ShellArgs {
  try {
    return parseShellArgs(process.argv, process.cwd())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(message)
    if (!SMOKE) dialog.showErrorBox('Plutus could not start', message)
    process.exit(2)
  }
}

const args = readArgs()

// Before anything reads userData: the single-instance lock, safeStorage, and the database.
app.setPath(
  'userData',
  SMOKE
    ? (args.dataDir ?? mkdtempSync(join(tmpdir(), 'plutus-smoke-')))
    : userDataDir({ isPackaged: app.isPackaged, appDataPath: app.getPath('appData'), dataDir: args.dataDir }),
)

const secrets = new SafeStorageSecretStore(safeStorage)
let log: Logger | null = null
let config: Config | null = null
let db: Db | null = null
let server: RunningServer | null = null
let scheduler: Scheduler | null = null
let mainWindow: BrowserWindow | null = null
let origin = ''
let logFile: string | null = null
let stopped = false

function openOutside(url: string): void {
  if (classifyNavigation(url, origin) === 'external') void shell.openExternal(url)
}

function createWindow(path: string): BrowserWindow {
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
  if (shouldOpenDevTools({ isPackaged: app.isPackaged, env: process.env })) win.webContents.openDevTools()
  void win.loadURL(`${origin}${path}`)
  return win
}

function buildMenu(): Menu {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  return Menu.buildFromTemplate(template)
}

async function start(): Promise<void> {
  const paths = resolvePaths({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
  })
  config = desktopConfig(loadConfig(process.env), paths)
  logFile = paths.logFile
  log = createLogger({ level: config.logLevel }, fileLogDestination(paths.logFile))
  // Guards, backs up, migrates, and checks; throws (database closed) rather than open data
  // that failed, so the server never starts on it.
  const appVersion = app.getVersion()
  db = openDb(paths.databasePath, { backupDir: paths.backupDir, appVersion })
  scheduler = createScheduler({ db, secrets, defaults: config.defaults, log })
  const guardToken = newGuardToken()
  // appVersion: /api/health (the Settings page) reports the release, not the server package's.
  server = await startServer({ db, secrets, config, log, guardToken, scheduler, appVersion })
  origin = server.origin
  log.info(
    {
      origin,
      database: paths.databasePath,
      logFile: paths.logFile,
      web: paths.webDist,
      electron: process.versions.electron,
    },
    'Plutus desktop started',
  )
  scheduler.start() // only when the config enables it
  Menu.setApplicationMenu(buildMenu())
  const path = await initialPath(origin, guardToken)
  mainWindow = createWindow(path)
  if (SMOKE) void smoke(mainWindow, path)
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

const HEADINGS: Record<string, string> = { '/': 'Overview', '/settings': 'Settings' }

// Runs in the page: it shows the expected page, and its own fetch reaches /api through the guard.
function pageProbe(path: string): string {
  return `(async () => {
  const heading = document.querySelector('main h1')?.textContent ?? null
  if (location.pathname !== ${JSON.stringify(path)} || heading !== ${JSON.stringify(HEADINGS[path] ?? '')}) return null
  const res = await fetch('/api/health', { credentials: 'include' })
  const body = await res.json()
  if (res.status !== 200 || body.status !== 'ok' || body.database !== 'ok') return null
  const accounts = await (await fetch('/api/accounts', { credentials: 'include' })).json()
  const simplefin = await (await fetch('/api/settings/simplefin', { credentials: 'include' })).json()
  return {
    brand: document.querySelector('header nav span')?.textContent ?? null,
    path: location.pathname,
    heading,
    health: { status: res.status, body },
    accounts: Array.isArray(accounts) ? accounts.length : null,
    simplefinConnected: simplefin.connected,
    cookieReadableByPage: document.cookie.includes('plutus_guard'),
  }
})()`
}

function probe(win: BrowserWindow, path: string): Promise<Record<string, unknown>> {
  return pollUntil(
    () => win.webContents.executeJavaScript(pageProbe(path)) as Promise<Record<string, unknown> | null>,
    { timeoutMs: SMOKE_TIMEOUT_MS, intervalMs: 250 },
  )
}

async function smoke(win: BrowserWindow, path: string): Promise<void> {
  let code = 1
  try {
    const page = await probe(win, path)
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
          dataDir: app.getPath('userData'),
          safeStorageAvailable: safeStorage.isEncryptionAvailable(),
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
    if (!mainWindow && server) mainWindow = createWindow('/')
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
        const { title, message } = startupDialog(err, logFile)
        dialog.showErrorBox(title, message)
      }
      void shutdown().finally(() => app.exit(1))
    })
}
