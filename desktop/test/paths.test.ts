import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePaths } from '../src/lib/paths.js'

const userDataPath = '/Users/someone/Library/Application Support/Plutus'

describe('resolvePaths', () => {
  it('serves web/dist from the repository in development', () => {
    const paths = resolvePaths({
      isPackaged: false,
      appPath: '/repo/desktop',
      resourcesPath: '/repo/node_modules/electron/dist/Electron.app/Contents/Resources',
      userDataPath,
    })
    expect(paths.webDist).toBe(resolve('/repo/web/dist'))
  })

  it('serves the web build copied into Resources when packaged', () => {
    const paths = resolvePaths({
      isPackaged: true,
      appPath: '/Applications/Plutus.app/Contents/Resources/app.asar',
      resourcesPath: '/Applications/Plutus.app/Contents/Resources',
      userDataPath,
    })
    expect(paths.webDist).toBe(join('/Applications/Plutus.app/Contents/Resources', 'web'))
  })

  it('keeps the data directory and database in userData either way', () => {
    for (const isPackaged of [false, true]) {
      const paths = resolvePaths({ isPackaged, appPath: '/a', resourcesPath: '/r', userDataPath })
      expect(paths.dataDir).toBe(userDataPath)
      expect(paths.databasePath).toBe(join(userDataPath, 'plutus.sqlite'))
    }
  })
})
