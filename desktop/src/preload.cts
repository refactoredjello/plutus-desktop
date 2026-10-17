/**
 * Preload for the sandboxed window (CommonJS, as sandboxed preloads must be). The SPA talks to
 * the server over HTTP like any browser, so this exposes only a read-only marker.
 */

const { contextBridge } = require('electron') as typeof import('electron')

contextBridge.exposeInMainWorld('plutusDesktop', Object.freeze({ platform: process.platform }))
