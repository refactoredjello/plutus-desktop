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
  /** Pre-migration backups (openDb keeps the newest 5). */
  backupDir: string
  logFile: string
}

/**
 * The userData folder, set before anything reads it. Development runs get their own, so an
 * unmerged branch's migrations never touch the database the installed app uses. --data-dir
 * replaces either; Electron keys the single-instance lock on this folder, so each profile has
 * its own.
 */
export function userDataDir(inputs: { isPackaged: boolean; appDataPath: string; dataDir?: string | null }): string {
  if (inputs.dataDir) return inputs.dataDir
  return join(inputs.appDataPath, inputs.isPackaged ? 'Plutus' : 'Plutus Dev')
}

export function resolvePaths(inputs: PathInputs): ShellPaths {
  const webDist = inputs.isPackaged
    ? join(inputs.resourcesPath, 'web') // electron-builder.yml extraResources
    : resolve(inputs.appPath, '..', 'web', 'dist')
  return {
    webDist,
    dataDir: inputs.userDataPath,
    databasePath: join(inputs.userDataPath, 'plutus.sqlite'),
    backupDir: join(inputs.userDataPath, 'backups'),
    logFile: join(inputs.userDataPath, 'logs', 'plutus.log'),
  }
}
