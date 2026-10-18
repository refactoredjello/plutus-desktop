/**
 * Electron entry point for the request audit; audit.ts launches it. Not for direct use.
 *
 * Before anything else it points the app path at desktop/ and appData at the throwaway dir
 * audit.ts made, both synchronously, then imports desktop/dist/main.js unchanged: the same
 * startup, cookie guard, server, and window as `npm run dev`. main.js puts userData in
 * <appData>/Plutus Dev, so the audit never sees the developer's own data.
 *
 * It records every request (session.webRequest), console message, and uncaught page error
 * as one JSON event per line in <out>/events.ndjson, visits each route, waits until the page
 * is quiet, saves a screenshot, and quits. A hard timeout exits on its own.
 */

import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { BrowserWindow, app, session } from 'electron'

function need(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`audit: ${name} is not set; run tools/parity/visual/audit.ts`)
    process.exit(2)
  }
  return value
}

const DESKTOP = need('AUDIT_DESKTOP_DIR')
const APP_DATA = need('AUDIT_APP_DATA')
const OUT = need('AUDIT_OUT_DIR')
/** [{ path, direct, file }]; the first is '/', the page the app opens at startup. */
const ROUTES = JSON.parse(need('AUDIT_ROUTES'))
const HARD_TIMEOUT_MS = Number(process.env.AUDIT_HARD_TIMEOUT_MS ?? '170000')
const ROUTE_TIMEOUT_MS = 20_000
const QUIET_MS = 1_200

const EVENTS = join(OUT, 'events.ndjson')
writeFileSync(EVENTS, '')
const emit = (event) => appendFileSync(EVENTS, `${JSON.stringify(event)}\n`)

setTimeout(() => {
  emit({ t: 'exception', text: `audit: hard timeout after ${HARD_TIMEOUT_MS} ms` })
  app.exit(2)
}, HARD_TIMEOUT_MS)

// The throwaway data dir, set before main.js computes userData from it.
app.setAppPath(DESKTOP)
app.setPath('appData', APP_DATA)
if (app.getPath('appData') !== APP_DATA || app.getAppPath() !== DESKTOP) {
  console.error('audit: could not set the app path and appData; refusing to start')
  app.exit(3)
}

const inFlight = new Set()
let lastActivity = Date.now()
const touch = () => {
  lastActivity = Date.now()
}

app.on('web-contents-created', (_event, wc) => {
  wc.on('console-message', (...args) => {
    // Electron 44 passes one event with level and message; older versions passed positionals.
    const e = args[0]
    const level = typeof e?.level === 'string' ? e.level : ['verbose', 'info', 'warning', 'error'][args[1]] ?? 'info'
    const text = typeof e?.message === 'string' ? e.message : String(args[2])
    emit({ t: 'console', level, text })
  })
  try {
    wc.debugger.attach('1.3')
    wc.debugger.on('message', (_e, method, params) => {
      if (method === 'Runtime.exceptionThrown') {
        const d = params.exceptionDetails ?? {}
        emit({ t: 'exception', text: d.exception?.description ?? d.text ?? 'exception' })
      }
    })
    void wc.debugger.sendCommand('Runtime.enable')
  } catch (err) {
    emit({ t: 'exception', text: `audit: debugger attach failed: ${String(err)}` })
  }
})

// Registered before main.js is imported, so it runs before main.js opens its window.
app.whenReady().then(() => {
  const web = session.defaultSession.webRequest
  web.onBeforeRequest((d, callback) => {
    inFlight.add(d.id)
    touch()
    emit({ t: 'request', id: d.id, method: d.method, url: d.url })
    callback({})
  })
  web.onCompleted((d) => {
    const header = Object.entries(d.responseHeaders ?? {}).find(([k]) => k.toLowerCase() === 'content-type')
    emit({ t: 'response', id: d.id, status: d.statusCode, contentType: header ? String(header[1][0]) : null })
    emit({ t: 'finished', id: d.id })
    inFlight.delete(d.id)
    touch()
  })
  web.onErrorOccurred((d) => {
    emit({ t: 'failed', id: d.id, error: d.error })
    inFlight.delete(d.id)
    touch()
  })
})

emit({ t: 'route', path: ROUTES[0].path })
await import(pathToFileURL(join(DESKTOP, 'dist', 'main.js')).href)
if (app.getPath('userData') !== join(APP_DATA, 'Plutus Dev')) {
  console.error(`audit: userData is ${app.getPath('userData')}, not under the throwaway dir; stopping`)
  app.exit(3)
}

async function waitFor(probe, what, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const value = await probe()
      if (value) return value
    } catch {
      // not yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

/** No request in flight for QUIET_MS, or the route timeout. */
async function quiet() {
  const start = Date.now()
  await sleep(300)
  while (Date.now() - start < ROUTE_TIMEOUT_MS) {
    if (inFlight.size === 0 && Date.now() - lastActivity >= QUIET_MS) return
    await sleep(100)
  }
  emit({ t: 'exception', text: `audit: requests still in flight after ${ROUTE_TIMEOUT_MS} ms` })
}

const heading = (wc) => wc.executeJavaScript(`document.querySelector('main h1')?.textContent ?? null`)

/** In-app navigation: click a link to the route if the page has one, else the History API. */
function navigateInApp(wc, path) {
  return wc.executeJavaScript(`(() => {
    const target = ${JSON.stringify(path)}
    const link = [...document.querySelectorAll('a[href]')].find((a) => new URL(a.href).pathname === target)
    if (link) {
      link.click()
      return 'link ' + link.getAttribute('href')
    }
    history.pushState(null, '', target)
    dispatchEvent(new PopStateEvent('popstate', { state: null }))
    return 'history'
  })()`)
}

/**
 * After the first page: one goal with suggestions, one planned item, one confirmed recurrence,
 * sent by the page itself (so through the cookie guard), so Goals, Planned, and Recurring show
 * data and send their per-item requests. Recorded under its own marker, not as a page.
 */
function seed(wc) {
  return wc.executeJavaScript(`(async () => {
    const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)
    const send = async (method, path, body) => {
      const res = await fetch(path, {
        method,
        credentials: 'include',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: res.status, body: res.status === 204 ? null : await res.json() }
    }
    const goal = await send('POST', '/api/goals', { name: 'Emergency fund', target_amount: '6000.00', target_date: day(365) })
    const suggestions = await send('POST', '/api/goals/' + goal.body.id + '/suggestions')
    const entry = await send('POST', '/api/manual-entries', { amount: '-180.00', description: 'Car registration', due_date: day(14), recurrence: 'none' })
    const proposed = (await send('GET', '/api/recurring?status=proposed')).body
    const confirmed = proposed.length > 0 ? await send('PATCH', '/api/recurring/' + proposed[0].id, { status: 'confirmed' }) : { status: null }
    return [goal.status, suggestions.status, entry.status, confirmed.status]
  })()`)
}

async function audit() {
  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 'the window', 60_000)
  const wc = win.webContents
  await waitFor(() => heading(wc), 'the first page', 60_000)
  const origin = new URL(wc.getURL()).origin
  for (const [i, route] of ROUTES.entries()) {
    let how = 'startup'
    if (i > 0) {
      emit({ t: 'route', path: route.path })
      if (route.direct) {
        await wc.loadURL(`${origin}${route.path}`)
        how = 'direct load'
      } else {
        how = await navigateInApp(wc, route.path)
      }
    }
    await waitFor(() => heading(wc), `a heading on ${route.path}`, ROUTE_TIMEOUT_MS).catch((err) =>
      emit({ t: 'exception', text: `audit: ${err.message}` }),
    )
    await quiet()
    const image = await wc.capturePage()
    writeFileSync(join(OUT, route.file), image.toPNG())
    emit({ t: 'screenshot', path: route.path, file: route.file, how, url: wc.getURL() })
    if (i === 0) {
      emit({ t: 'route', path: '(seed: a goal, a planned item, a confirmed recurrence)' })
      emit({ t: 'seed', statuses: await seed(wc) })
      await quiet()
    }
  }
  // The guard: the same API from outside the page, without the cookie.
  const unguarded = await fetch(`${origin}/api/health`)
  emit({ t: 'guard', status: unguarded.status })
}

audit()
  .catch((err) => emit({ t: 'exception', text: `audit: ${err instanceof Error ? err.message : String(err)}` }))
  .finally(() => {
    emit({ t: 'done' })
    app.quit()
  })
