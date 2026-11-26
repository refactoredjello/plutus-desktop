/**
 * macOS signing for electron-builder (electron-builder.config.mjs reads this from dist/).
 *
 * With a certificate (CSC_LINK and CSC_KEY_PASSWORD, or CSC_NAME for one in the keychain)
 * electron-builder signs with it under the hardened runtime. Its default entitlements turn off
 * library validation, so the SQLite addon and Electron's frameworks load even when the
 * certificate has no Team ID (a self-signed one). The build is notarized only when a full set of
 * Apple credentials is also present: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID;
 * or APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER. A self-signed certificate gets no
 * notarization (Apple accepts only Developer ID), but its identity stays the same across builds,
 * so the Keychain keeps trusting the app.
 *
 * Without a certificate the build is signed ad hoc (identity '-'): Apple Silicon requires a
 * signature to run, and `codesign --verify` passes. Ad hoc builds are never notarized (Apple
 * refuses them) and skip the hardened runtime, which protects nothing without notarization.
 */

export interface MacSigning {
  identity?: '-'
  hardenedRuntime: boolean
  notarize: boolean
}

type Env = Record<string, string | undefined>

const set = (value: string | undefined) => Boolean(value?.trim())

const NOTARIZATION_CREDENTIALS = [
  ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
  ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
]

const canNotarize = (env: Env) => NOTARIZATION_CREDENTIALS.some((names) => names.every((n) => set(env[n])))

export function macSigning(env: Env): MacSigning {
  if (set(env.CSC_LINK) || set(env.CSC_NAME)) return { hardenedRuntime: true, notarize: canNotarize(env) }
  return { identity: '-', hardenedRuntime: false, notarize: false }
}
