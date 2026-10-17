/** Comparing one GET, and running one write step, on the Python app and the other app. */

import { type Difference, compareResponses } from './diff.ts'
import { normalizeOptionsFor, templateFor } from './endpoints.ts'
import type { Json } from './normalize.ts'
import type { CaseResult } from './report.ts'
import { type Api, PrepareError, type State, type StepRequest, type WriteStep, runPrepare } from './writes.ts'

export interface Side {
  api: Api
  state: State
}

export async function compareGet(
  expected: Api,
  actual: Api,
  path: string,
  label: string,
  actualPath: string = path,
): Promise<CaseResult> {
  const endpoint = templateFor('GET', path)
  const [e, a] = await Promise.all([expected.send('GET', path), actual.send('GET', actualPath)])
  const differences: Difference[] = []
  if (actualPath !== path) {
    differences.push({ path: '(request)', expected: path, actual: actualPath, note: 'the re-read path differs' })
  }
  differences.push(...compareResponses(e, a, normalizeOptionsFor(endpoint)))
  const request = actualPath === path ? `GET ${path}` : `GET ${path} (other app: ${actualPath})`
  return { endpoint, label, request, differences }
}

type Prepared = { ok: true; request: StepRequest } | { ok: false; error: string }

async function prepare(step: WriteStep, side: Side, today: string): Promise<Prepared> {
  try {
    return { ok: true, request: await runPrepare(step, side.api, side.state, today) }
  } catch (err) {
    if (!(err instanceof PrepareError)) throw err
    return { ok: false, error: err.message }
  }
}

const asJson = (r: StepRequest): Json => ({ ...r }) as Json

/** Prepare, send, and capture on both sides, then compare the write and its re-reads. */
export async function runStep(
  step: WriteStep,
  index: number,
  expected: Side,
  actual: Side,
  today: string,
): Promise<CaseResult[]> {
  const label = `step ${index}: ${step.name}`
  const pe = await prepare(step, expected, today)
  const pa = await prepare(step, actual, today)
  const differences: Difference[] = []
  let request = step.endpoint

  if (!pe.ok) {
    differences.push({
      path: '(prepare)',
      expected: `failed: ${pe.error}`,
      actual: pa.ok ? asJson(pa.request) : `failed: ${pa.error}`,
      note: 'Python could not prepare the step',
    })
  } else {
    request = `${pe.request.method} ${pe.request.path}`
    const re = await expected.api.send(pe.request.method, pe.request.path, pe.request.body)
    step.capture?.(re, expected.state)
    if (!pa.ok) {
      differences.push({
        path: '(prepare)',
        expected: asJson(pe.request),
        actual: `failed: ${pa.error}`,
        note: 'could not prepare the step',
      })
    } else {
      if (JSON.stringify(pe.request) !== JSON.stringify(pa.request)) {
        differences.push({
          path: '(request)',
          expected: asJson(pe.request),
          actual: asJson(pa.request),
          note: 'the step picked different targets',
        })
      }
      const ra = await actual.api.send(pa.request.method, pa.request.path, pa.request.body)
      step.capture?.(ra, actual.state)
      differences.push(...compareResponses(re, ra, normalizeOptionsFor(step.endpoint)))
    }
  }

  const results: CaseResult[] = [{ endpoint: step.endpoint, label, request, differences }]
  const ePaths = step.reread(expected.state, today)
  const aPaths = step.reread(actual.state, today)
  for (let i = 0; i < Math.max(ePaths.length, aPaths.length); i++) {
    const path = ePaths[i] ?? aPaths[i] ?? ''
    results.push(await compareGet(expected.api, actual.api, path, `after ${label}`, aPaths[i] ?? path))
  }
  return results
}
