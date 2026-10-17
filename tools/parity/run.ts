/**
 * Parity harness: Python API (the oracle) against the TypeScript server, or against a second
 * Python API with --self-check. Writes tools/parity/report.md and exits 1 on any difference.
 *
 *   make parity          # node_modules/.bin/tsx tools/parity/run.ts
 *   make parity-self     # ... --self-check
 *   options: --today=YYYY-MM-DD (default $PARITY_TODAY or 2026-09-30)
 *
 * Fake demo data only. Postgres must be up on localhost:5432 (PARITY_PG_ADMIN_URL overrides);
 * the run drops and recreates plutus_parity (and plutus_parity_self for the self-check).
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  API_DIR,
  type AppProcess,
  type CommandResult,
  SERVER_DIR,
  demoLoadPython,
  demoLoadTs,
  dropDatabase,
  migratePython,
  pythonEnv,
  recreateDatabase,
  requirePython,
  startPython,
  startTs,
  tsEnv,
} from './apps.ts'
import { makeApi } from './client.ts'
import { NOT_COMPARED, getCases, monthOffset, ruleNotes } from './endpoints.ts'
import { compareGet, runStep } from './harness.ts'
import { collectTsPrompts, comparePrompts, dumpPythonPrompts, loadTsPrompts, type TsPrompt } from './prompts.ts'
import { type CaseResult, type CheckResult, type RunReport, exitCode, renderReport, summarize } from './report.ts'
import { WRITE_STEPS } from './writes.ts'

const REPORT = fileURLToPath(new URL('./report.md', import.meta.url))
const TS_PROMPTS = join(SERVER_DIR, 'src', 'providers', 'llm', 'prompts.ts')
const DB = 'plutus_parity'
const SELF_DB = 'plutus_parity_self'

const selfCheck = process.argv.includes('--self-check')
const today =
  process.argv.find((a) => a.startsWith('--today='))?.slice('--today='.length) ??
  process.env.PARITY_TODAY ??
  '2026-09-30'
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`--today must be YYYY-MM-DD, got ${today}`)

const log = (msg: string) => process.stdout.write(`parity: ${msg}\n`)
const lastLine = (r: CommandResult) => r.output.split('\n').filter(Boolean).at(-1) ?? ''
/** The most telling line of a failed command: the first error line, else the last line. */
const errorLine = (r: CommandResult) =>
  r.output.split('\n').find((l) => /Error\b/.test(l))?.trim() ?? lastLine(r)

function check(name: string, ok: boolean, detail: string): CheckResult {
  return { name, ok, detail }
}

function must(r: CommandResult, what: string): void {
  if (!r.ok) throw new Error(`${what} failed (exit ${r.status}): ${r.output}`)
}

async function promptChecks(): Promise<CheckResult[]> {
  const python = dumpPythonPrompts(API_DIR)
  if (selfCheck) {
    const again = dumpPythonPrompts(API_DIR) as Record<string, TsPrompt>
    return comparePrompts(python, again as Parameters<typeof comparePrompts>[1])
  }
  let mod: Record<string, unknown> | null
  try {
    mod = await loadTsPrompts(TS_PROMPTS)
  } catch (err) {
    const error = `import failed: ${err instanceof Error ? err.message : String(err)}`
    return Object.keys(python).map((name) => check(name, false, error))
  }
  return comparePrompts(python, collectTsPrompts(mod))
}

async function main(): Promise<number> {
  requirePython()
  const work = mkdtempSync(join(tmpdir(), 'plutus-parity-'))
  const setup: CheckResult[] = [check('work directory', true, `logs and SQLite file in ${work}`)]
  const apps: AppProcess[] = []
  const stopAll = async () => {
    await Promise.all(apps.map((a) => a.stop()))
  }
  process.on('SIGINT', () => void stopAll().then(() => process.exit(130)))

  try {
    log(`PLUTUS_TODAY=${today}, ${selfCheck ? 'self-check (Python vs Python)' : 'Python vs TypeScript'}`)

    // Python: the oracle.
    const pyEnv = pythonEnv(today, DB)
    must(recreateDatabase(DB, pyEnv), `recreate ${DB}`)
    must(migratePython(pyEnv), 'alembic upgrade (Python)')
    const pyDemo = demoLoadPython(pyEnv)
    must(pyDemo, 'python -m app.demo load')
    log(`Python demo: ${lastLine(pyDemo)}`)

    // The other side: a second Python app, or the TypeScript server.
    let otherDemo: CommandResult
    let otherEnv: Record<string, string>
    if (selfCheck) {
      otherEnv = pythonEnv(today, SELF_DB)
      must(recreateDatabase(SELF_DB, otherEnv), `recreate ${SELF_DB}`)
      must(migratePython(otherEnv), 'alembic upgrade (second Python)')
      otherDemo = demoLoadPython(otherEnv)
    } else {
      otherEnv = tsEnv(today, work)
      otherDemo = demoLoadTs(otherEnv)
    }
    const actualLabel = selfCheck ? 'Python (second instance)' : 'TypeScript'
    log(`${actualLabel} demo: ${otherDemo.ok ? lastLine(otherDemo) : `failed (exit ${otherDemo.status})`}`)
    setup.push(
      check(
        'demo load',
        otherDemo.ok && lastLine(otherDemo) === lastLine(pyDemo),
        otherDemo.ok
          ? `Python "${lastLine(pyDemo)}"; ${actualLabel} "${lastLine(otherDemo)}"`
          : `Python "${lastLine(pyDemo)}"; ${actualLabel} failed (exit ${otherDemo.status}): ${errorLine(otherDemo).slice(0, 300)}`,
      ),
    )

    const python = await startPython('Python', pyEnv, join(work, 'python.log'))
    apps.push(python)
    if (python.startError) throw new Error(`Python API: ${python.startError}`)
    const other = selfCheck
      ? await startPython(actualLabel, otherEnv, join(work, 'python-self.log'))
      : await startTs(actualLabel, otherEnv, join(work, 'typescript.log'))
    apps.push(other)
    setup.push(
      check(
        `${actualLabel} start`,
        other.startError === null,
        other.startError ?? `listening on ${other.baseUrl}`,
      ),
    )
    log(`Python on ${python.baseUrl}; ${actualLabel} on ${other.baseUrl}${other.startError ? ` (${other.startError})` : ''}`)

    const prompts = await promptChecks()

    const py = makeApi(python.baseUrl)
    const ot = makeApi(other.baseUrl)
    const cases: CaseResult[] = []

    // The oracle picks the category used in the category filter case.
    const top = await py.send('GET', `/api/reports/by-category?month=${monthOffset(today, 0)}`)
    const first = Array.isArray(top.body) ? top.body[0] : null
    const categoryId =
      first !== null && typeof first === 'object' && !Array.isArray(first) && typeof first.category_id === 'number'
        ? first.category_id
        : null

    const gets = getCases(today, { categoryId })
    log(`${gets.length} GET cases`)
    for (const c of gets) cases.push(await compareGet(py, ot, c.path, 'initial'))

    log(`${WRITE_STEPS.length} write steps`)
    const pySide = { api: py, state: {} }
    const otSide = { api: ot, state: {} }
    for (const [i, step] of WRITE_STEPS.entries()) {
      cases.push(...(await runStep(step, i + 1, pySide, otSide, today)))
    }

    const report: RunReport = {
      mode: selfCheck ? 'self-check' : 'python-vs-typescript',
      actualLabel,
      today,
      setup,
      prompts,
      cases,
      notCompared: [...NOT_COMPARED],
      rules: ruleNotes(),
    }
    writeFileSync(REPORT, renderReport(report))
    const s = summarize(report)
    log(
      `${s.differingEndpoints} of ${s.endpoints.length} endpoints differ, ${s.failedChecks} checks differ; ` +
        `${cases.length} cases. Report: ${REPORT}`,
    )
    return exitCode(report)
  } finally {
    await stopAll()
    if (selfCheck) dropDatabase(SELF_DB, pythonEnv(today, SELF_DB))
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`parity: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  },
)
