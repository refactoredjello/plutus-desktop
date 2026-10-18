/**
 * Electron request audit (brief 4A): opens the real desktop app on fake demo data, visits
 * every page and one deep link, and records each request, console message, failed request,
 * and page error, with one screenshot per page. Then checks every request the pages sent
 * against the parity harness's cases.
 *
 *   npm run build:all --prefix desktop                  # web, server, desktop (or pass --build)
 *   node_modules/.bin/tsx tools/parity/visual/audit.ts  # writes tools/parity/visual/out/
 *
 * Output (gitignored): audit.md, audit.json, events.ndjson, electron.log, one PNG per route.
 * Exits 1 on any problem or coverage gap, 2 when Electron failed or timed out.
 *
 * The data dir is a fresh temp dir, removed afterwards; Electron runs in its own process group
 * and is killed after AUDIT_TIMEOUT_MS (default 180 s) or when this script exits.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTES, auditExitCode, coverageGaps, fileName, harnessKeys, renderAudit, replayEvents, uiKeys } from './audit_lib.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DESKTOP = join(ROOT, 'desktop')
const SERVER = join(ROOT, 'server')
const OUT = fileURLToPath(new URL('./out/', import.meta.url))
const ENTRY = fileURLToPath(new URL('./electron_main.mjs', import.meta.url))
const TIMEOUT_MS = Number(process.env.AUDIT_TIMEOUT_MS ?? '180000')
/** Only the harness's request shapes matter here, not its dates. */
const HARNESS_TODAY = '2026-09-30'

const log = (msg: string) => process.stdout.write(`audit: ${msg}\n`)

function baseEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'C.UTF-8',
    ENVIRONMENT: 'development',
    LLM_PROVIDER: 'fake',
    OWNER_NAME_TOKENS: '["ALEX","SAMPLE"]',
    SCHEDULER_ENABLED: 'false',
    LOG_LEVEL: 'warn',
  }
}

function build(): void {
  log('building web, server, and desktop')
  const r = spawnSync('npm', ['run', 'build:all'], { cwd: DESKTOP, stdio: 'inherit', timeout: 300_000 })
  if (r.status !== 0) throw new Error(`build failed (status ${r.status}, signal ${r.signal})`)
}

function requireBuilds(): void {
  for (const file of [join(DESKTOP, 'dist', 'main.js'), join(SERVER, 'dist', 'app.js'), join(ROOT, 'web', 'dist', 'index.html')]) {
    if (!existsSync(file)) throw new Error(`${file} is missing: run npm run build:all --prefix desktop, or pass --build`)
  }
}

function loadDemo(userData: string): void {
  const r = spawnSync('npm', ['run', '--silent', 'demo', '--', 'load'], {
    cwd: SERVER,
    env: { ...baseEnv(), PLUTUS_DATA_DIR: userData, PLUTUS_DB_PATH: join(userData, 'plutus.sqlite') },
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (r.status !== 0) throw new Error(`demo load failed (status ${r.status}): ${r.stdout}${r.stderr}`)
  log(`demo: ${r.stdout.trim().split('\n').at(-1) ?? ''}`)
}

/** Runs Electron in its own process group; resolves with its exit code, or null on timeout. */
function runElectron(appData: string): Promise<number | null> {
  const electron = createRequire(join(DESKTOP, 'package.json'))('electron') as string
  const routes = ROUTES.map((r) => ({ ...r, file: `${fileName(r.path)}.png` }))
  const child = spawn(electron, [ENTRY], {
    cwd: DESKTOP,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...baseEnv(),
      AUDIT_DESKTOP_DIR: DESKTOP,
      AUDIT_APP_DATA: appData,
      AUDIT_OUT_DIR: OUT,
      AUDIT_ROUTES: JSON.stringify(routes),
      AUDIT_HARD_TIMEOUT_MS: String(TIMEOUT_MS - 10_000),
    },
  })
  const out = createWriteStream(join(OUT, 'electron.log'))
  child.stdout.pipe(out)
  child.stderr.pipe(out)
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal)
    } catch {
      // already gone
    }
  }
  process.on('exit', () => killGroup('SIGKILL'))
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      killGroup('SIGKILL')
      process.exit(130)
    })
  }
  return new Promise((resolve) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      log(`Electron still running after ${TIMEOUT_MS} ms: killing it`)
      killGroup('SIGTERM')
      setTimeout(() => killGroup('SIGKILL'), 5_000).unref()
    }, TIMEOUT_MS)
    child.on('exit', (code) => {
      clearTimeout(timer)
      killGroup('SIGKILL') // helpers left behind
      resolve(timedOut ? null : code)
    })
  })
}

interface Shot {
  path: string
  file: string
  how: string
  url: string
}

async function main(): Promise<number> {
  if (ROUTES[0]?.path !== '/') throw new Error('the first route must be /, the page the app opens')
  if (process.argv.includes('--build')) build()
  requireBuilds()
  mkdirSync(OUT, { recursive: true })
  for (const f of readdirSync(OUT)) rmSync(join(OUT, f), { force: true })

  const appData = mkdtempSync(join(tmpdir(), 'plutus-audit-'))
  try {
    const userData = join(appData, 'Plutus Dev')
    mkdirSync(userData)
    loadDemo(userData)
    log(`Electron on ${userData}, at most ${TIMEOUT_MS / 1000} s`)
    const code = await runElectron(appData)

    const events = existsSync(join(OUT, 'events.ndjson')) ? readFileSync(join(OUT, 'events.ndjson'), 'utf8').split('\n') : []
    const results = replayEvents(events)
    const shots = events
      .filter((l) => l.startsWith('{"t":"screenshot"'))
      .map((l) => JSON.parse(l) as Shot)
    const screenshots = Object.fromEntries(shots.map((s) => [s.path, `${s.file}; reached by ${s.how}; ${s.url}`]))
    const gaps = coverageGaps(uiKeys(results), harnessKeys(HARNESS_TODAY))
    writeFileSync(join(OUT, 'audit.json'), `${JSON.stringify({ results, gaps, screenshots }, null, 2)}\n`)
    writeFileSync(join(OUT, 'audit.md'), renderAudit(results, gaps, screenshots))

    const problems = results.reduce((n, r) => n + r.problems.length, 0)
    const requests = results.reduce((n, r) => n + r.requests.length, 0)
    log(`${results.length} routes, ${requests} requests, ${problems} problems, ${gaps.length} coverage gaps, ${shots.length} screenshots`)
    for (const r of results) for (const p of r.problems) log(`  ${r.path}: ${p}`)
    for (const g of gaps) log(`  gap: ${g}`)
    log(`report: ${join(OUT, 'audit.md')}`)
    const finished = events.some((l) => l.startsWith('{"t":"done"'))
    if (code !== 0 || !finished || shots.length !== ROUTES.length) {
      log(`Electron ${code === null ? 'timed out' : `exited ${code}`}${finished ? '' : ' before finishing'}; see ${join(OUT, 'electron.log')}`)
      return 2
    }
    return auditExitCode(results, gaps)
  } finally {
    rmSync(appData, { recursive: true, force: true })
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    log(err instanceof Error ? err.message : String(err))
    process.exit(2)
  },
)
