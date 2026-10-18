// electron-builder configuration. `npm run dist` builds web, server, and desktop first, so the
// signing choice is read from the compiled src/lib/signing.ts (see README.md "Signing").
// Without signing variables the macOS build is signed ad hoc and never notarized.

import { macSigning } from './dist/lib/signing.js'

/** @type {import('electron-builder').Configuration} */
export default {
  appId: 'app.plutus.desktop',
  productName: 'Plutus',
  copyright: 'Plutus',

  directories: {
    output: 'release',
    // icon.icns, icon.ico, icon.png (scripts/icons.sh renders them from icon.svg).
    buildResources: 'build',
  },

  // The app: compiled main and preload, plus production dependencies (plutus-server and its
  // dependencies, collected from the workspace).
  files: [
    'dist/**',
    '!dist/lib/signing.js', // build-time only
    'package.json',
    // Sources the app never loads: the server runs from its dist, SQLite from its prebuild.
    '!**/node_modules/plutus-server/{src,scripts,test}/**',
    '!**/node_modules/plutus-server/*.{ts,json}',
    'node_modules/plutus-server/package.json',
    '!**/node_modules/better-sqlite3/{deps,src,build}/**',
    // better-sqlite3 ships a prebuild per platform; keep the one this build runs on.
    '!**/node_modules/better-sqlite3/prebuilds/**',
    '**/node_modules/better-sqlite3/prebuilds/${platform}-${arch}.node',
  ],

  // The SPA, served by the in-process server from Resources/web (src/lib/paths.ts).
  extraResources: [{ from: '../web/dist', to: 'web' }],

  asar: true,
  // Native modules cannot load from inside app.asar.
  asarUnpack: ['**/node_modules/better-sqlite3/**/*.node'],

  // better-sqlite3 13 ships N-API prebuilds (lib/<platform>.js loads prebuilds/<platform>.node);
  // N-API binaries load in Electron's Node unchanged, so there is nothing to rebuild for
  // Electron's ABI. Turn this back on if a dependency needs node-gyp.
  npmRebuild: false,

  mac: {
    category: 'public.app-category.finance',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    ...macSigning(process.env),
  },
  dmg: {
    // Plutus-0.1.0-arm64.dmg, Plutus-0.1.0-x64.dmg
    artifactName: '${productName}-${version}-${arch}.${ext}',
  },

  // Configured, not verified: built and tested on macOS only so far.
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    category: 'Finance',
    maintainer: 'Plutus',
  },
}
