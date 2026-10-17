/**
 * Where the shell finds the web build and keeps its data. Electron supplies the inputs
 * (app.isPackaged, app.getAppPath(), process.resourcesPath, app.getPath('userData')).
 */

import { join, resolve } from 'node:path'

export interface PathInputs {
  isPackaged: boolean
  /** The desktop package in development; app.asar when packaged. */
  appPath: string
  resourcesPath: string
  userDataPath: string
}

export interface ShellPaths {
  webDist: string
  dataDir: string
  databasePath: string
}

export function resolvePaths(inputs: PathInputs): ShellPaths {
  const webDist = inputs.isPackaged
    ? join(inputs.resourcesPath, 'web') // electron-builder.yml extraResources
    : resolve(inputs.appPath, '..', 'web', 'dist')
  return {
    webDist,
    dataDir: inputs.userDataPath,
    databasePath: join(inputs.userDataPath, 'plutus.sqlite'),
  }
}
