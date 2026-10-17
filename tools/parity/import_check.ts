/**
 * End-to-end check of the Postgres export and SQLite import (brief 2D): `make import-check`.
 *
 * 1. Drops and recreates the throwaway database plutus_export, migrates it, loads the demo
 *    fixture, and stores a fake SimpleFIN access URL encrypted with a throwaway SECRET_KEY.
 * 2. Starts the Python API and runs the parity write steps that fill the tables the demo
 *    leaves empty (rules, goals, manual entries, suggestions, dismissals, a custom category).
 * 3. Exports with `python -m app.export_json`, imports with server/scripts/import-json.ts into
 *    a temp SQLite file, and compares row counts per table: Postgres, the file, SQLite.
 * 4. Starts the TypeScript server on the imported file and compares GET /api/reports/monthly
 *    with the Python API, both with the same PLUTUS_TODAY.
 *
 * `--all-gets` also compares every parity GET case on the imported data, for information.
 *
 * Exits 0 only when every count and every monthly response is equal. Fake data only; it
 * touches no database but plutus_export, and deletes the export file (it holds the fake
 * secret in clear text) when done.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IMPORT_TABLES } from '../../server/scripts/import-json.ts'
import { openDb } from '../../server/src/db/index.ts'
import { KeySecretStore } from '../../server/src/secrets.ts'
import {
  API_DIR,
  type AppProcess,
  PG_ADMIN_URL,
  ROOT,
  demoLoadPython,
  migratePython,
  pythonEnv,
  requirePython,
  startPython,
  startTs,
  tsEnv,
} from './apps.ts'
import { makeApi } from './client.ts'
import { getCases } from './endpoints.ts'
import { formatValue } from './report.ts'
import { compareGet } from './harness.ts'
import { WRITE_STEPS, type WriteStep, runPrepare } from './writes.ts'

/** Write steps that add rows the demo does not, in WRITE_STEPS order. */
export const SEED_STEP_NAMES = [
  'recategorize with save-as-rule',
  'add a note',
  'mark one-time',
  'confirm a recurrence',
  'dismiss a recurrence',
  'mark a merchant yearly recurring',
  'create a manual entry',
  'create a recurring manual entry',
  'update a manual entry',
  'delete a manual entry',
  'create a goal',
  'update a goal',
  'generate suggestions',
  'dismiss a suggestion',
  'dismiss a change',
  'create a category',
  'hide a category',
] as const

export function seedSteps(): WriteStep[] {
  return SEED_STEP_NAMES.map((name) => {
    const step = WRITE_STEPS.find((s) => s.name === name)
    if (step === undefined) throw new Error(`import-check: no write step named "${name}"`)
    return step
  })
}

export interface CountRow {
  table: string
  postgres: number | null
  exported: number | null
  sqlite: number | null
  ok: boolean
}

export function compareCounts(
  tables: readonly string[],
  postgres: Record<string, number>,
  exported: Record<string, number>,
  sqlite: Record<string, number>,
): { ok: boolean; rows: CountRow[] } {
  const rows = tables.map((table) => {
    const p = postgres[table] ?? null
    const e = exported[table] ?? null
    const s = sqlite[table] ?? null
    return { table, postgres: p, exported: e, sqlite: s, ok: p !== null && p === e && e === s }
  })
  return { ok: rows.every((r) => r.ok), rows }
}

export function renderCounts(rows: readonly CountRow[]): string {
  const cell = (n: number | null) => (n === null ? '-' : String(n)).padStart(8)
  const lines = [`${'table'.padEnd(26)}${'postgres'.padStart(8)}${'export'.padStart(8)}${'sqlite'.padStart(8)}  verdict`]
  for (const r of rows) {
    lines.push(`${r.table.padEnd(26)}${cell(r.postgres)}${cell(r.exported)}${cell(r.sqlite)}  ${r.ok ? 'equal' : 'DIFFERENT'}`)
  }
  return lines.join('\n')
}

const DB = 'plutus_export'
const FAKE_ACCESS_URL = 'https://demo-user:demo-pass@bridge.invalid/simplefin'
// Every months value the parity harness uses except 0, a validation error that reads no data
// (its 422 body differs by design: plan section 5.5).
const MONTHLY = ['', '?months=1', '?months=6', '?months=24'].map((q) => `/api/reports/monthly${q}`)
const PYTHON = join(API_DIR, '.venv', 'bin', 'python')

const log = (msg: string) => process.stdout.write(`import-check: ${msg}\n`)

function python(args: string[], env: Record<string, string>): string {
  const r = spawnSync(PYTHON, args, { cwd: API_DIR, env, encoding: 'utf8', timeout: 300_000 })
  if (r.status !== 0) throw new Error(`python ${args.slice(0, 2).join(' ')} failed: ${r.stdout}${r.stderr}`)
  return r.stdout
}

const RECREATE = `
import sys, psycopg
with psycopg.connect(sys.argv[1], autocommit=True) as c:
    c.execute('DROP DATABASE IF EXISTS ${DB} WITH (FORCE)')
    c.execute('CREATE DATABASE ${DB}')
`

const STORE_SECRET = `
import sys
from app.config import get_settings
from app.db import get_sessionmaker
from app.services.app_settings import SIMPLEFIN_ACCESS_URL, set_setting
with get_sessionmaker()() as db:
    set_setting(db, get_settings(), SIMPLEFIN_ACCESS_URL, sys.argv[1], encrypt=True)
`

const COUNT = `
import json, sys
from sqlalchemy import text
from app.db import get_sessionmaker
with get_sessionmaker()() as db:
    print(json.dumps({t: db.execute(text(f'SELECT count(*) FROM "{t}"')).scalar_one() for t in sys.argv[1:]}))
`

async function main(): Promise<number> {
  requirePython()
  const today = process.env.PARITY_TODAY ?? '2026-09-30'
  const work = mkdtempSync(join(tmpdir(), 'plutus-import-check-'))
  const exportFile = join(work, 'export.json')
  const pyEnv = pythonEnv(today, DB)
  const ts = tsEnv(today, work)
  const apps: AppProcess[] = []
  log(`PLUTUS_TODAY=${today}; work directory ${work}`)

  try {
    python(['-c', RECREATE, PG_ADMIN_URL], pyEnv)
    const migrated = migratePython(pyEnv)
    if (!migrated.ok) throw new Error(migrated.output)
    const demo = demoLoadPython(pyEnv)
    if (!demo.ok) throw new Error(demo.output)
    log(demo.output.split('\n').at(-1) ?? '')
    python(['-c', STORE_SECRET, FAKE_ACCESS_URL], pyEnv)

    const py = await startPython('Python', pyEnv, join(work, 'python.log'))
    apps.push(py)
    if (py.startError) throw new Error(`Python API: ${py.startError}`)
    const pyApi = makeApi(py.baseUrl)
    const state = {}
    for (const step of seedSteps()) {
      const request = await runPrepare(step, pyApi, state, today)
      const res = await pyApi.send(request.method, request.path, request.body)
      if (res.status >= 400) throw new Error(`seed step "${step.name}" answered ${res.status}: ${formatValue(res.body)}`)
      step.capture?.(res, state)
    }
    log(`${SEED_STEP_NAMES.length} write steps on the Python API`)

    python(['-m', 'app.export_json', exportFile], pyEnv)
    const postgres = JSON.parse(python(['-c', COUNT, ...IMPORT_TABLES], pyEnv)) as Record<string, number>
    const file = JSON.parse(readFileSync(exportFile, 'utf8')) as { tables: Record<string, unknown[]> }
    const exported = Object.fromEntries(Object.entries(file.tables).map(([t, rows]) => [t, rows.length]))

    const dbPath = ts.PLUTUS_DB_PATH ?? join(work, 'plutus.sqlite')
    const imported = spawnSync(
      join(ROOT, 'node_modules', '.bin', 'tsx'),
      [join(ROOT, 'server', 'scripts', 'import-json.ts'), exportFile, '--db', dbPath],
      { cwd: ROOT, env: { ...ts }, encoding: 'utf8', timeout: 300_000 },
    )
    if (imported.status !== 0) throw new Error(`import-json failed: ${imported.stdout}${imported.stderr}`)
    rmSync(exportFile)

    const db = openDb(dbPath)
    const sqlite: Record<string, number> = {}
    let secretOk = false
    try {
      for (const t of IMPORT_TABLES) {
        sqlite[t] = db.$client.prepare(`SELECT count(*) FROM "${t}"`).pluck().get() as number
      }
      const blob = db.$client
        .prepare("SELECT value FROM app_settings WHERE key = 'simplefin_access_url' AND is_encrypted = 1")
        .pluck()
        .get() as string | undefined
      secretOk = blob !== undefined && new KeySecretStore(ts.PLUTUS_SECRET_KEY ?? '').decrypt(blob) === FAKE_ACCESS_URL
    } finally {
      db.$client.close()
    }

    const counts = compareCounts(IMPORT_TABLES, postgres, exported, sqlite)
    process.stdout.write(`${renderCounts(counts.rows)}\n`)
    log(`SimpleFIN access URL re-encrypted and readable with the new key: ${secretOk ? 'yes' : 'NO'}`)

    const tsApp = await startTs('TypeScript', ts, join(work, 'typescript.log'))
    apps.push(tsApp)
    if (tsApp.startError) throw new Error(`TypeScript server: ${tsApp.startError}`)
    const tsApi = makeApi(tsApp.baseUrl)
    let monthlyOk = true
    for (const path of MONTHLY) {
      const result = await compareGet(pyApi, tsApi, path, 'imported')
      const equal = result.differences.length === 0
      monthlyOk &&= equal
      log(`GET ${path}: ${equal ? 'equal' : `${result.differences.length} differences`} (${result.statuses?.expected}/${result.statuses?.actual})`)
      for (const d of result.differences.slice(0, 10)) {
        log(`  ${d.path}: Python ${formatValue(d.expected)}, TypeScript ${formatValue(d.actual)}`)
      }
    }

    if (process.argv.includes('--all-gets')) {
      // Informational: every parity GET case on the imported data. Never changes the exit code.
      const results = []
      for (const c of getCases(today, { categoryId: null })) results.push(await compareGet(pyApi, tsApi, c.path, 'imported'))
      const differing = results.filter((r) => r.differences.length > 0)
      log(`--all-gets: ${results.length - differing.length} of ${results.length} GET cases equal`)
      for (const r of differing) {
        const first = r.differences[0]
        const detail = first ? `${first.path}: Python ${formatValue(first.expected)}, TypeScript ${formatValue(first.actual)}` : ''
        log(`  ${r.request} (${r.statuses?.expected}/${r.statuses?.actual}), ${r.differences.length} differences; ${detail}`)
      }
    }

    const ok = counts.ok && secretOk && monthlyOk
    log(ok ? 'PASS: equal counts for every table and an equal monthly report' : 'FAIL')
    return ok ? 0 : 1
  } finally {
    await Promise.all(apps.map((a) => a.stop()))
    if (existsSync(exportFile)) rmSync(exportFile)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`import-check: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(2)
    },
  )
}
