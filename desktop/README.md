# Plutus desktop

The Electron shell. It opens the SQLite database, runs the Plutus server in-process on
`127.0.0.1` with a random port, and shows the SPA in a window. There is no separate backend
process and nothing listens beyond loopback.

## Run

From the repository root, once: `npm ci`. Then in `desktop/`:

| Command | What it does |
|---|---|
| `npm run dev` | Builds `web`, `server`, and the shell, then opens the window. |
| `npm run smoke` | Same build, then opens the window against a throwaway data dir, waits for the SPA to render and reach `/api/health` through the cookie guard, prints a JSON result, and exits 0 (or 1 after 30 s). |
| `npm run dist` | Builds everything and packages an unsigned app into `release/` (macOS: `release/mac-arm64/Plutus.app` on Apple Silicon, `release/mac/Plutus.app` on Intel). |
| `npm run smoke:dist` | Runs the smoke check against the packaged app in `release/`. |
| `npm run check` | Lint, typecheck, and unit tests (`src/lib`). Needs no build. |

`PLUTUS_SMOKE_SCREENSHOT=/path/shot.png` with either smoke command also saves what the window
showed. The first `dev` or `smoke` downloads the Electron binary; the first `dist` downloads
the packaging copy of Electron.

## Where things live

- Data: the OS app data folder, `Plutus/plutus.sqlite` (macOS:
  `~/Library/Application Support/Plutus`). Development runs use `Plutus Dev` instead, so a
  branch's migrations never touch the installed app's database. Smoke runs use a temp dir.
- Secrets (SimpleFIN access URL, API keys) are encrypted with Electron `safeStorage` (the
  macOS Keychain) and stored as blobs in `app_settings`. If OS encryption is unavailable, the
  app refuses to save a secret rather than storing it in plain text.
- Settings come from the `app_settings` table. Environment variables only seed defaults on
  first run.
- Logs: JSON lines on stdout (visible when launched from a terminal). 5B adds a log file.

## How it is put together

- `src/main.ts`: Electron lifecycle (single-instance lock, window, shutdown, smoke mode).
  Verified by launching.
- `src/preload.cts`: the sandboxed window's preload; exposes only `window.plutusDesktop.platform`.
- `src/lib/`: the parts with logic, unit-tested: paths for development and packaged builds,
  the desktop server config and listener, the per-launch guard token, `SafeStorageSecretStore`,
  navigation rules, and the smoke poller.
- The shell runs the server's compiled output (`plutus-server/dist`), but typechecks and
  tests against `server/src` (tsconfig `paths`, Vitest alias). `tsconfig.build.json` only
  emits.
- Security: each launch makes a random token. The server sets it as an `HttpOnly`,
  `SameSite=Strict` cookie on the page and rejects `/api` requests without it, so other local
  processes can't use the API. Links outside the app's origin open in the system browser;
  other schemes are blocked.
- better-sqlite3 13 ships N-API prebuilds, which load in Electron's Node without rebuilding.
  `npmRebuild` is therefore off, and `asarUnpack` keeps the `.node` file outside `app.asar`.

## Signing (brief 5B)

`npm run dist` sets `CSC_IDENTITY_AUTO_DISCOVERY=false`, so it never picks up a keychain
identity on its own, and the build stays unsigned unless signing variables are provided.
The unsigned app runs on the machine that built it. Copied to another Mac, Gatekeeper
quarantines it: right-click, then Open, or run `xattr -dr com.apple.quarantine Plutus.app`.

Signing and notarizing a macOS build needs:

- An Apple Developer ID Application certificate, exported as `.p12`: `CSC_LINK` (a path or
  base64) and `CSC_KEY_PASSWORD`.
- Notarization credentials: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`,
  or an App Store Connect API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`).
- Hardened runtime and entitlements in `electron-builder.yml`, plus `notarize: true`.

Windows signing uses `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`. Brief 5B wires these up and
adds dmg, zip, nsis, and AppImage targets and an icon.
