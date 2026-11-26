// End-to-end tests for scripts/update.sh against temp dirs: a fake, ad hoc signed Plutus.app,
// fake release zips, a stub `gh`, and a throwaway HOME. They never touch /Applications or the
// real data folder (every run passes --target and --data-dir). macOS only (ditto, codesign).

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'update.sh')
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'

let root: string
let target: string
let data: string
let bin: string
let home: string
let zips: string

function plist(version: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Plutus</string>
<key>CFBundleIdentifier</key><string>app.plutus.test</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`
}

function sh(cmd: string, args: string[], cwd?: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

/** A minimal signed app bundle at <dir>/Plutus.app. */
function makeApp(dir: string, version: string, { tamper = false } = {}) {
  const app = join(dir, 'Plutus.app')
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  const exe = join(app, 'Contents', 'MacOS', 'Plutus')
  writeFileSync(exe, `#!/bin/sh\necho ${version}\n`)
  chmodSync(exe, 0o755)
  writeFileSync(join(app, 'Contents', 'Info.plist'), plist(version))
  sh('codesign', ['--sign', '-', '--force', app])
  if (tamper) writeFileSync(exe, `#!/bin/sh\necho tampered\n`)
  return app
}

/** A release-style zip (Plutus.app at the top) for `version`. */
function makeZip(version: string, opts: { tamper?: boolean } = {}) {
  const staging = mkdtempSync(join(root, 'stage-'))
  const app = makeApp(staging, version, opts)
  const zip = join(zips, `Plutus-${version}-${arch}.zip`)
  sh('ditto', ['-c', '-k', '--keepParent', app, zip])
  return zip
}

function installedVersion() {
  return readFileSync(join(target, 'Plutus.app', 'Contents', 'Info.plist'), 'utf8').match(
    /CFBundleShortVersionString<\/key><string>([^<]+)/,
  )?.[1]
}

function run(args: string[], { env = {}, input = '' }: { env?: Record<string, string>; input?: string } = {}) {
  const r = spawnSync('bash', [script, '--target', target, '--data-dir', data, ...args], {
    encoding: 'utf8',
    input,
    env: {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      PLUTUS_PROCESS_NAME: 'PlutusUpdateTestNotRunning',
      ...env,
    },
  })
  return { status: r.status, out: r.stdout + r.stderr }
}

function writeData(content: string) {
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'plutus.sqlite'), `${content} db`)
  writeFileSync(join(data, 'plutus.sqlite-wal'), `${content} wal`)
  writeFileSync(join(data, 'plutus.sqlite-shm'), `${content} shm`)
}

const backups = (prefix: string) =>
  existsSync(join(data, 'backups'))
    ? readdirSync(join(data, 'backups')).filter((n) => n.startsWith(prefix)).sort()
    : []

const previousApps = () =>
  existsSync(join(data, 'previous-app')) ? readdirSync(join(data, 'previous-app')).sort() : []

describe.skipIf(process.platform !== 'darwin')('scripts/update.sh', () => {
  let running: ChildProcess | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plutus-update-test-'))
    target = join(root, 'Applications')
    data = join(root, 'data')
    bin = join(root, 'bin')
    home = join(root, 'home')
    zips = join(root, 'zips')
    for (const d of [target, bin, home, zips]) mkdirSync(d, { recursive: true })
    makeApp(target, '0.1.0')
    writeData('v1')
    mkdirSync(join(data, 'backups', 'plutus-earlier.sqlite.d'), { recursive: true })
  })

  afterEach(() => {
    running?.kill()
    running = undefined
    rmSync(root, { recursive: true, force: true })
  })

  it('installs a release zip after copying the data and keeping the old app', () => {
    const zip = makeZip('0.2.0')
    const r = run([], { env: { PLUTUS_UPDATE_ZIP: zip } })

    expect(r.status, r.out).toBe(0)
    expect(installedVersion()).toBe('0.2.0')
    expect(r.out).toContain('0.1.0 -> 0.2.0')
    expect(r.out).toMatch(/Always Allow/)
    sh('codesign', ['--verify', '--deep', '--strict', join(target, 'Plutus.app')])

    const [copy, ...more] = backups('manual-')
    expect(more).toEqual([])
    const copyDir = join(data, 'backups', copy!)
    expect(readdirSync(copyDir).sort()).toEqual(['plutus.sqlite', 'plutus.sqlite-shm', 'plutus.sqlite-wal'])
    expect(readFileSync(join(copyDir, 'plutus.sqlite'), 'utf8')).toBe('v1 db')
    // The live data is untouched.
    expect(readFileSync(join(data, 'plutus.sqlite'), 'utf8')).toBe('v1 db')

    expect(previousApps()).toEqual(['Plutus-0.1.0.zip'])
    const check = mkdtempSync(join(root, 'check-'))
    sh('ditto', ['-x', '-k', join(data, 'previous-app', 'Plutus-0.1.0.zip'), check])
    expect(readFileSync(join(check, 'Plutus.app', 'Contents', 'Info.plist'), 'utf8')).toContain('0.1.0')
    // No leftovers next to the installed app.
    expect(readdirSync(target)).toEqual(['Plutus.app'])
  })

  it('refuses while Plutus is running, before changing anything', () => {
    // pgrep matches the process name, which macOS cuts to 16 characters.
    const name = `PlutusT${process.pid % 100000}`
    const fake = join(bin, name)
    copyFileSync('/bin/sleep', fake)
    sh('codesign', ['--sign', '-', '--force', fake]) // a copied system binary is killed unsigned
    running = spawn(fake, ['30'], { stdio: 'ignore' })
    const zip = makeZip('0.2.0')

    for (let i = 0; i < 50 && spawnSync('pgrep', ['-x', name]).status !== 0; i++) {
      spawnSync('sleep', ['0.1'])
    }
    expect(spawnSync('pgrep', ['-x', name]).status).toBe(0)

    const r = run([], { env: { PLUTUS_UPDATE_ZIP: zip, PLUTUS_PROCESS_NAME: name } })

    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/quit Plutus/i)
    expect(installedVersion()).toBe('0.1.0')
    expect(backups('manual-')).toEqual([])
    expect(previousApps()).toEqual([])
  })

  /** Starts `tail -f` on files in the data folder and waits until lsof sees it holding them. */
  function holdOpen(...names: string[]) {
    const files = names.map((n) => join(data, n))
    running = spawn('tail', ['-f', ...files], { stdio: 'ignore' })
    const pid = String(running.pid)
    const holds = () =>
      spawnSync('lsof', ['-t', ...files], { encoding: 'utf8' }).stdout.split('\n').includes(pid)
    for (let i = 0; i < 50 && !holds(); i++) spawnSync('sleep', ['0.1'])
    expect(holds()).toBe(true)
  }

  it('refuses while another process holds the database open, before changing anything', () => {
    holdOpen('plutus.sqlite')
    const r = run([], { env: { PLUTUS_UPDATE_ZIP: makeZip('0.2.0') } })

    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/plutus\.sqlite is open in tail \(pid \d+\)/)
    expect(r.out).toMatch(/close it/i)
    expect(installedVersion()).toBe('0.1.0')
    expect(backups('manual-')).toEqual([])
    expect(previousApps()).toEqual([])
    expect(readdirSync(target)).toEqual(['Plutus.app'])
  })

  it('refuses a rollback or a data restore while the -wal file is open', () => {
    expect(run([], { env: { PLUTUS_UPDATE_ZIP: makeZip('0.2.0') } }).status).toBe(0)
    writeData('v2')
    holdOpen('plutus.sqlite-wal')

    for (const args of [['--rollback'], ['--rollback', '--restore-data']]) {
      const r = run(args, { input: 'restore\n' })
      expect(r.status).not.toBe(0)
      expect(r.out).toMatch(/is open in tail/)
      expect(r.out).not.toMatch(/Type restore/)
    }
    expect(installedVersion()).toBe('0.2.0')
    expect(readFileSync(join(data, 'plutus.sqlite'), 'utf8')).toBe('v2 db')
    expect(backups('before-')).toEqual([])
    expect(previousApps()).toEqual(['Plutus-0.1.0.zip'])
  })

  /** A codesign stub that logs its arguments; it signs for real only with the ad hoc identity. */
  function stubCodesign() {
    const log = join(root, 'codesign.log')
    writeFileSync(
      join(bin, 'codesign'),
      `#!/bin/bash
echo "$@" >> "${log}"
for a in "$@"; do
  if [ "$prev" = --sign ] && [ "$a" != - ]; then exit 0; fi
  prev="$a"
done
exec /usr/bin/codesign "$@"
`,
    )
    chmodSync(join(bin, 'codesign'), 0o755)
    return () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
  }

  it('re-signs the unpacked app with PLUTUS_SIGN_IDENTITY, after verifying the download', () => {
    const calls = stubCodesign()
    const r = run([], { env: { PLUTUS_UPDATE_ZIP: makeZip('0.2.0'), PLUTUS_SIGN_IDENTITY: '-' } })

    expect(r.status, r.out).toBe(0)
    expect(installedVersion()).toBe('0.2.0')
    sh('codesign', ['--verify', '--deep', '--strict', join(target, 'Plutus.app')])
    const log = calls()
    const signed = log.findIndex((c) => /^--force --deep --sign - .*\/Plutus\.app$/.test(c))
    expect(signed, log.join('\n')).toBeGreaterThan(0)
    expect(log[signed - 1]).toMatch(/^--verify --deep --strict /)
    expect(log[signed + 1]).toMatch(/^--verify --deep --strict /)
    // The ad hoc identity is still a new identity per build: the Keychain advice stays.
    expect(r.out).toMatch(/Always Allow/)
  })

  it('still refuses a tampered download when PLUTUS_SIGN_IDENTITY is set', () => {
    const r = run([], { env: { PLUTUS_UPDATE_ZIP: makeZip('0.2.0', { tamper: true }), PLUTUS_SIGN_IDENTITY: '-' } })

    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/signature/i)
    expect(installedVersion()).toBe('0.1.0')
  })

  it('says which identity signed the app instead of the Keychain advice', () => {
    const calls = stubCodesign()
    const env = { PLUTUS_SIGN_IDENTITY: 'Plutus Local Signing' }
    const r = run([], { env: { ...env, PLUTUS_UPDATE_ZIP: makeZip('0.2.0') } })

    expect(r.status, r.out).toBe(0)
    expect(calls()).toContainEqual(expect.stringMatching(/^--force --deep --sign Plutus Local Signing .*Plutus\.app$/))
    expect(r.out).toContain('Signed with "Plutus Local Signing"')
    expect(r.out).not.toMatch(/Always Allow/)

    // A rollback re-signs the saved app it reinstalls, too.
    const back = run(['--rollback'], { env })
    expect(back.status, back.out).toBe(0)
    expect(installedVersion()).toBe('0.1.0')
    expect(calls().filter((c) => c.startsWith('--force --deep --sign Plutus Local Signing'))).toHaveLength(2)
    expect(back.out).toContain('Signed with "Plutus Local Signing"')
  })

  it('refuses a download whose signature does not verify, leaving the installed app', () => {
    const zip = makeZip('0.2.0', { tamper: true })
    const r = run([], { env: { PLUTUS_UPDATE_ZIP: zip } })

    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/signature/i)
    expect(installedVersion()).toBe('0.1.0')
    expect(readdirSync(target)).toEqual(['Plutus.app'])
  })

  it('installs when no app or data exists yet', () => {
    rmSync(join(target, 'Plutus.app'), { recursive: true })
    rmSync(data, { recursive: true })
    const r = run([], { env: { PLUTUS_UPDATE_ZIP: makeZip('0.2.0') } })

    expect(r.status, r.out).toBe(0)
    expect(installedVersion()).toBe('0.2.0')
    expect(r.out).toContain('none -> 0.2.0')
    expect(previousApps()).toEqual([])
  })

  it('keeps only the two most recent previous apps', () => {
    for (const v of ['0.2.0', '0.3.0', '0.10.0']) {
      const r = run([], { env: { PLUTUS_UPDATE_ZIP: makeZip(v) } })
      expect(r.status, r.out).toBe(0)
    }
    expect(installedVersion()).toBe('0.10.0')
    expect(previousApps()).toEqual(['Plutus-0.2.0.zip', 'Plutus-0.3.0.zip'])
  })

  it('keeps the two most recently saved apps, not the two highest versions', () => {
    // Saves 0.1.0, then 0.9.0, 0.2.0, 0.3.0: the newest two are 0.2.0 and 0.3.0.
    for (const v of ['0.9.0', '0.2.0', '0.3.0', '0.4.0']) {
      const r = run([], { env: { PLUTUS_UPDATE_ZIP: makeZip(v) } })
      expect(r.status, r.out).toBe(0)
    }
    expect(previousApps()).toEqual(['Plutus-0.2.0.zip', 'Plutus-0.3.0.zip'])
  })

  it('keeps its newest five data copies and leaves everything else in backups alone', () => {
    const b = join(data, 'backups')
    const old = [
      'manual-20200101T000000Z',
      'manual-20200102T000000Z',
      'before-rollback-20200103T000000Z',
      'before-restore-20200104T000000Z',
      'manual-20200105T000000Z',
      'manual-20200105T000000Z-2',
    ]
    for (const n of old) mkdirSync(join(b, n), { recursive: true })
    // Not the script's: pre-migration backups and anything else stay.
    writeFileSync(join(b, 'plutus-20200101T000000Z-v0.1.0-before-0001.sqlite'), 'x')
    mkdirSync(join(b, 'notes'))

    const r = run([], { env: { PLUTUS_UPDATE_ZIP: makeZip('0.2.0') } })

    expect(r.status, r.out).toBe(0)
    const fresh = backups('manual-').filter((n) => !old.includes(n))
    expect(fresh).toHaveLength(1)
    const current = fresh[0]
    expect(readdirSync(b).sort()).toEqual(
      [
        'before-rollback-20200103T000000Z',
        'before-restore-20200104T000000Z',
        'manual-20200105T000000Z',
        'manual-20200105T000000Z-2',
        current!,
        'notes',
        'plutus-20200101T000000Z-v0.1.0-before-0001.sqlite',
        'plutus-earlier.sqlite.d',
      ].sort(),
    )
  })

  it('never prunes the copy made in this run, even when others look newer', () => {
    const b = join(data, 'backups')
    const future = ['01', '02', '03', '04', '05'].map((d) => `manual-299901${d}T000000Z`)
    for (const n of future) mkdirSync(join(b, n), { recursive: true })

    const r = run([], { env: { PLUTUS_UPDATE_ZIP: makeZip('0.2.0') } })

    expect(r.status, r.out).toBe(0)
    const mine = backups('manual-')
    expect(mine).toHaveLength(5)
    expect(mine.filter((n) => !n.startsWith('manual-2999'))).toHaveLength(1)
    expect(mine).not.toContain('manual-29990101T000000Z')
  })

  it('downloads the latest release, or a given version, for this Mac with gh', () => {
    const zip = makeZip('0.2.0')
    const log = join(root, 'gh.log')
    // Stub gh: logs its arguments and "downloads" the fixture into --dir.
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/bash
echo "$@" >> "${log}"
while [ $# -gt 0 ]; do case "$1" in --dir) dir="$2"; shift ;; esac; shift; done
cp "${zip}" "$dir/"
`,
    )
    chmodSync(join(bin, 'gh'), 0o755)

    let r = run([])
    expect(r.status, r.out).toBe(0)
    expect(installedVersion()).toBe('0.2.0')
    r = run(['v0.2.0'])
    expect(r.status, r.out).toBe(0)

    const calls = readFileSync(log, 'utf8').trim().split('\n')
    expect(calls[0]).toMatch(new RegExp(`^release download --pattern Plutus-\\*-${arch}\\.zip --dir `))
    expect(calls[1]).toMatch(new RegExp(`^release download v0\\.2\\.0 --pattern Plutus-0\\.2\\.0-${arch}\\.zip --dir `))
  })

  it('rolls back to the previous app, copying the data first', () => {
    expect(run([], { env: { PLUTUS_UPDATE_ZIP: makeZip('0.2.0') } }).status).toBe(0)
    writeData('v2')

    const r = run(['--rollback'])

    expect(r.status, r.out).toBe(0)
    expect(installedVersion()).toBe('0.1.0')
    expect(r.out).toContain('0.2.0 -> 0.1.0')
    expect(previousApps()).toEqual(['Plutus-0.1.0.zip', 'Plutus-0.2.0.zip'])
    const [copy] = backups('before-rollback-')
    expect(readFileSync(join(data, 'backups', copy!, 'plutus.sqlite'), 'utf8')).toBe('v2 db')
    // Data is only restored on request.
    expect(readFileSync(join(data, 'plutus.sqlite'), 'utf8')).toBe('v2 db')
  })

  it('refuses to roll back when no older app is saved', () => {
    const r = run(['--rollback'])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/no older app/i)
    expect(installedVersion()).toBe('0.1.0')
  })

  it('restores the pre-update data copy only after a typed confirmation', () => {
    expect(run([], { env: { PLUTUS_UPDATE_ZIP: makeZip('0.2.0') } }).status).toBe(0)
    writeData('v2')
    rmSync(join(data, 'plutus.sqlite-shm'))

    const declined = run(['--rollback', '--restore-data'], { input: 'yes\n' })
    expect(declined.status).not.toBe(0)
    expect(installedVersion()).toBe('0.2.0')
    expect(readFileSync(join(data, 'plutus.sqlite'), 'utf8')).toBe('v2 db')

    const r = run(['--rollback', '--restore-data'], { input: 'restore\n' })
    expect(r.status, r.out).toBe(0)
    expect(installedVersion()).toBe('0.1.0')
    expect(readFileSync(join(data, 'plutus.sqlite'), 'utf8')).toBe('v1 db')
    expect(readFileSync(join(data, 'plutus.sqlite-wal'), 'utf8')).toBe('v1 wal')
    expect(readFileSync(join(data, 'plutus.sqlite-shm'), 'utf8')).toBe('v1 shm')
    // The data it replaced is kept, not deleted.
    const [replaced] = backups('before-restore-')
    const replacedDir = join(data, 'backups', replaced!)
    expect(readdirSync(replacedDir).sort()).toEqual(['plutus.sqlite', 'plutus.sqlite-wal'])
    expect(readFileSync(join(replacedDir, 'plutus.sqlite'), 'utf8')).toBe('v2 db')
  })

  it('restores a copy taken after a clean quit, which has no -wal or -shm file', () => {
    rmSync(join(data, 'plutus.sqlite-wal'))
    rmSync(join(data, 'plutus.sqlite-shm'))
    expect(run([], { env: { PLUTUS_UPDATE_ZIP: makeZip('0.2.0') } }).status).toBe(0)
    writeData('v2')

    const r = run(['--rollback', '--restore-data'], { input: 'restore\n' })

    expect(r.status, r.out).toBe(0)
    expect(readdirSync(data).filter((n) => n.startsWith('plutus.sqlite'))).toEqual(['plutus.sqlite'])
    expect(readFileSync(join(data, 'plutus.sqlite'), 'utf8')).toBe('v1 db')
  })

  it('rejects unknown flags and --restore-data without --rollback', () => {
    expect(run(['--bogus']).status).toBe(2)
    const r = run(['--restore-data'])
    expect(r.status).toBe(2)
    expect(r.out).toMatch(/--rollback/)
  })
})
