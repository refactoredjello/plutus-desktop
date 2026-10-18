/**
 * macOS signing for electron-builder (electron-builder.config.mjs reads this from dist/).
 *
 * With a Developer ID certificate (CSC_LINK and CSC_KEY_PASSWORD, or CSC_NAME for one in the
 * keychain) electron-builder signs with it, the hardened runtime on, and notarizes when the
 * Apple credentials are set (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID, or
 * APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER).
 *
 * Without one the build is signed ad hoc (identity '-'): Apple Silicon requires a signature
 * to run, `codesign --verify` passes, and the Keychain sees one consistent app. Ad hoc builds
 * are never notarized (Apple refuses them) and skip the hardened runtime, which would need
 * library validation turned off to load the SQLite addon.
 */

export interface MacSigning {
  identity?: '-'
  hardenedRuntime: boolean
  notarize: boolean
}

const set = (value: string | undefined) => Boolean(value?.trim())

export function macSigning(env: Record<string, string | undefined>): MacSigning {
  if (set(env.CSC_LINK) || set(env.CSC_NAME)) return { hardenedRuntime: true, notarize: true }
  return { identity: '-', hardenedRuntime: false, notarize: false }
}
