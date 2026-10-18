import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseShellArgs } from '../src/lib/args.js'

const cwd = '/Users/someone/work'

describe('parseShellArgs', () => {
  it('has no data dir when the flag is absent', () => {
    expect(parseShellArgs(['/path/Electron', '.'], cwd)).toEqual({ dataDir: null })
    expect(parseShellArgs(['/Applications/Plutus.app/Contents/MacOS/Plutus'], cwd)).toEqual({ dataDir: null })
  })

  it('reads --data-dir <path> in development and when packaged', () => {
    expect(parseShellArgs(['/path/Electron', '.', '--data-dir', '/tmp/profile'], cwd).dataDir).toBe('/tmp/profile')
    expect(parseShellArgs(['/x/Plutus', '--data-dir', '/tmp/profile'], cwd).dataDir).toBe('/tmp/profile')
  })

  it('reads --data-dir=<path>', () => {
    expect(parseShellArgs(['/x/Plutus', '--data-dir=/tmp/profile two'], cwd).dataDir).toBe('/tmp/profile two')
  })

  it('resolves a relative path against the working directory', () => {
    expect(parseShellArgs(['/x/Plutus', '--data-dir', 'profiles/b'], cwd).dataDir).toBe(resolve(cwd, 'profiles/b'))
    expect(parseShellArgs(['/x/Plutus', '--data-dir=b'], cwd).dataDir).toBe(resolve(cwd, 'b'))
  })

  it('ignores other switches around it', () => {
    const argv = ['/path/Electron', '.', '--remote-debugging-port=9222', '--data-dir', '/tmp/p', '--inspect']
    expect(parseShellArgs(argv, cwd).dataDir).toBe('/tmp/p')
  })

  it('refuses the flag without a path rather than falling back to the real data', () => {
    expect(() => parseShellArgs(['/x/Plutus', '--data-dir'], cwd)).toThrow(/--data-dir needs a path/)
    expect(() => parseShellArgs(['/x/Plutus', '--data-dir', '--inspect'], cwd)).toThrow(/--data-dir needs a path/)
    expect(() => parseShellArgs(['/x/Plutus', '--data-dir='], cwd)).toThrow(/--data-dir needs a path/)
  })
})
