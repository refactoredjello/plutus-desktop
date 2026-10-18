import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePaths, userDataDir } from '../src/lib/paths.js'

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

  it('keeps pre-migration backups under the data directory', () => {
    const paths = resolvePaths({ isPackaged: true, appPath: '/a', resourcesPath: '/r', userDataPath })
    expect(paths.backupDir).toBe(join(userDataPath, 'backups'))
  })

  it('writes the log file under the data directory, so each profile has its own', () => {
    const paths = resolvePaths({ isPackaged: true, appPath: '/a', resourcesPath: '/r', userDataPath })
    expect(paths.logFile).toBe(join(userDataPath, 'logs', 'plutus.log'))
  })
})

describe('userDataDir', () => {
  const appDataPath = '/Users/someone/Library/Application Support'

  it('is Plutus under the OS app data folder when packaged', () => {
    expect(userDataDir({ isPackaged: true, appDataPath })).toBe(join(appDataPath, 'Plutus'))
  })

  it('is a separate folder in development, so a dev run never migrates the real database', () => {
    expect(userDataDir({ isPackaged: false, appDataPath })).toBe(join(appDataPath, 'Plutus Dev'))
  })

  it('is the --data-dir folder when one is given, packaged or not', () => {
    for (const isPackaged of [false, true]) {
      expect(userDataDir({ isPackaged, appDataPath, dataDir: '/tmp/second-profile' })).toBe('/tmp/second-profile')
    }
    expect(userDataDir({ isPackaged: true, appDataPath, dataDir: null })).toBe(join(appDataPath, 'Plutus'))
  })
})
