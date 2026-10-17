/**
 * Starting and stopping the two apps. The Python API runs from api/.venv against a throwaway
 * Postgres database; the TypeScript server runs under tsx against a temp SQLite file. Both
 * get the same fixed settings (fake LLM, owner name tokens, PLUTUS_TODAY, scheduler off).
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const API_DIR = join(ROOT, 'api')
export const SERVER_DIR = join(ROOT, 'server')
const PYTHON = join(API_DIR, '.venv', 'bin', 'python')

export const PG_ADMIN_URL = process.env.PARITY_PG_ADMIN_URL ?? 'postgresql://plutus:plutus@localhost:5432/postgres'
export const pgUrl = (db: string) => {
  const base = PG_ADMIN_URL.replace(/^postgresql:/, 'postgresql+psycopg:')
  return base.replace(/\/[^/]*$/, `/${db}`)
}

/** Settings both apps share. Fake data only; the secret key exists only for this run. */
export function sharedEnv(today: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'C.UTF-8',
    ENVIRONMENT: 'development',
    LLM_PROVIDER: 'fake',
    OWNER_NAME_TOKENS: '["ALEX","SAMPLE"]',
    PLUTUS_TODAY: today,
    SCHEDULER_ENABLED: 'false',
    SYNC_INTERVAL_HOURS: '6',
    SYNC_FIRST_HISTORY_DAYS: '180',
    LOG_LEVEL: 'warning',
  }
}

export interface CommandResult {
  ok: boolean
  status: number | null
  output: string
}

function run(cmd: string, args: string[], cwd: string, env: Record<string, string>, input?: string): CommandResult {
  const r = spawnSync(cmd, args, { cwd, env, input, encoding: 'utf8', timeout: 300_000 })
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`.trim()
  return { ok: r.status === 0, status: r.status, output }
}

export function requirePython(): void {
  if (!existsSync(PYTHON)) throw new Error(`${PYTHON} not found: run \`cd api && uv sync\` first`)
}

/** Drop and recreate a database on the compose Postgres. Never touches any other database. */
export function recreateDatabase(db: string, env: Record<string, string>): CommandResult {
  if (!/^plutus_parity\w*$/.test(db)) throw new Error(`refusing to recreate ${db}: not a parity database`)
  const script = [
    'import sys, psycopg',
    'with psycopg.connect(sys.argv[1], autocommit=True) as c:',
    `    c.execute('DROP DATABASE IF EXISTS ${db} WITH (FORCE)')`,
    `    c.execute('CREATE DATABASE ${db}')`,
  ].join('\n')
  return run(PYTHON, ['-c', script, PG_ADMIN_URL], API_DIR, env)
}

export function dropDatabase(db: string, env: Record<string, string>): CommandResult {
  if (!/^plutus_parity\w*$/.test(db)) throw new Error(`refusing to drop ${db}: not a parity database`)
  const script = [
    'import sys, psycopg',
    'with psycopg.connect(sys.argv[1], autocommit=True) as c:',
    `    c.execute('DROP DATABASE IF EXISTS ${db} WITH (FORCE)')`,
  ].join('\n')
  return run(PYTHON, ['-c', script, PG_ADMIN_URL], API_DIR, env)
}

export function pythonEnv(today: string, db: string): Record<string, string> {
  return { ...sharedEnv(today), DATABASE_URL: pgUrl(db), SECRET_KEY: 'parity-only-not-a-secret' }
}

export function tsEnv(today: string, dataDir: string): Record<string, string> {
  return {
    ...sharedEnv(today),
    LOG_LEVEL: 'warn',
    PLUTUS_DATA_DIR: dataDir,
    PLUTUS_DB_PATH: join(dataDir, 'plutus.sqlite'),
    PLUTUS_SECRET_KEY: 'parity-only-not-a-secret',
    PLUTUS_WEB_DIST: join(dataDir, 'no-web-dist'),
  }
}

export const migratePython = (env: Record<string, string>) => run(PYTHON, ['-m', 'alembic', 'upgrade', 'head'], API_DIR, env)
export const demoLoadPython = (env: Record<string, string>) => run(PYTHON, ['-m', 'app.demo', 'load'], API_DIR, env)
export const demoLoadTs = (env: Record<string, string>) => run('npm', ['run', '--silent', 'demo', '--', 'load'], SERVER_DIR, env)

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 0
      srv.close(() => resolve(port))
    })
  })
}

export interface AppProcess {
  label: string
  baseUrl: string
  logFile: string
  /** Null when the app answered /api/health, else why it did not. */
  startError: string | null
  stop(): Promise<void>
}

async function launch(
  label: string,
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  port: number,
  logFile: string,
): Promise<AppProcess> {
  const fd = openSync(logFile, 'a')
  const child: ChildProcess = spawn(cmd, args, { cwd, env, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  let exited = false
  child.on('exit', () => (exited = true))
  const baseUrl = `http://127.0.0.1:${port}`

  const stop = async () => {
    if (exited) return
    const done = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    await done
    clearTimeout(timer)
  }

  const deadline = Date.now() + 60_000
  let startError: string | null = 'did not answer /api/health within 60 s'
  while (Date.now() < deadline) {
    if (exited) {
      startError = `exited before answering /api/health; log tail: ${tail(logFile)}`
      break
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        startError = null
        break
      }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return { label, baseUrl, logFile, startError, stop }
}

function tail(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').slice(-5).join(' / ')
  } catch {
    return '(no log)'
  }
}

export async function startPython(label: string, env: Record<string, string>, logFile: string): Promise<AppProcess> {
  const port = await freePort()
  return launch(
    label,
    PYTHON,
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'],
    API_DIR,
    env,
    port,
    logFile,
  )
}

export async function startTs(label: string, env: Record<string, string>, logFile: string): Promise<AppProcess> {
  const port = await freePort()
  // node --import tsx keeps one process, so SIGTERM reaches the server itself.
  return launch(
    label,
    process.execPath,
    ['--import', 'tsx', join(SERVER_DIR, 'src', 'main.ts')],
    ROOT,
    { ...env, HOST: '127.0.0.1', PORT: String(port) },
    port,
    logFile,
  )
}
