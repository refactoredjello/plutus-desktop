# Plutus desktop

The Electron shell. It opens the SQLite database, runs the Plutus server in-process on
`127.0.0.1` with a random port, and shows the SPA in a window. There is no separate backend
process and nothing listens beyond loopback. macOS is the only target.

## Run

From the repository root, once: `npm ci`. Then in `desktop/`:

| Command | What it does |
|---|---|
| `npm run dev` | Builds `web`, `server`, and the shell, then opens the window. |
| `npm run smoke` | Same build, then opens the window against a throwaway data dir, waits for the SPA to render its first page and reach `/api` through the cookie guard, prints a JSON result, and exits 0 (or 1 after 30 s; killed after 120 s). |
| `npm run dist` | Builds everything and packages the app into `release/`: `Plutus-<version>-arm64.dmg` and `.zip`, `Plutus-<version>-x64.dmg` and `.zip`, and the unpacked apps in `release/mac-arm64/` and `release/mac/`. |
| `npm run smoke:dist` | Runs the smoke check against the packaged app for this Mac's architecture. |
| `npm run icons` | Regenerates `build/icon.icns` from `build/icon.svg` (macOS `sips` and `iconutil`). |
| `npm run check` | Lint, typecheck, and unit tests (`src/lib`, and `scripts/update.sh` on macOS against temp dirs). Needs no build. |
| `npm run update:app` | Installs the latest GitHub Release into `/Applications`, safely (see [Updating](#updating)). `make update` / `make rollback` at the root quit Plutus first and reopen it after. |
| `npm run version:bump -- patch\|minor\|major` | Bumps the app version and commits it (see [Releases](#releases)). |

Smoke options, with either smoke command:

- `PLUTUS_SMOKE_SCREENSHOT=/path/shot.png` saves what the window showed.
- `-- --data-dir <folder>` checks that folder instead of a throwaway one (for example after
  loading demo data). The JSON reports the first page, its account count, and whether
  SimpleFIN is connected.

Electron 44 downloads its binary the first time `electron` runs (not at `npm ci`); the first
`dist` downloads the packaging copy of Electron into the electron-builder cache.

## First launch

With SimpleFIN not connected (a new install), the window opens on Settings; otherwise on the
Overview. The shell asks `GET /api/settings/simplefin` before it opens the window.

## Where things live

| What | Where (macOS) |
|---|---|
| Data (database `plutus.sqlite`, Chromium caches) | `~/Library/Application Support/Plutus` |
| Log file | `~/Library/Application Support/Plutus/logs/plutus.log` (JSON lines; over 5 MB it moves to `plutus.log.1` at the next launch) |
| Backups | `~/Library/Application Support/Plutus/backups/`: a verified copy made just before each database update, `plutus-<UTC time>-before-<migration>.sqlite`; the newest 5 are kept. A rejected update's database is set aside there as `failed-<UTC time>.sqlite`. |
| Development runs | `~/Library/Application Support/Plutus Dev`, same layout, so a branch's migrations never touch the installed app's database |
| Smoke runs | a temp dir, printed as `dataDir` |
| Data copies made by `update:app` | `~/Library/Application Support/Plutus/backups/manual-<time>/` (also `before-rollback-` and `before-restore-`; its newest five are kept, other entries are left alone) |
| Apps replaced by `update:app` | `~/Library/Application Support/Plutus/previous-app/Plutus-<version>.zip` (the two most recently saved) |

Logs also go to stdout when the app is started from a terminal. They never contain the
SimpleFIN access URL or API keys.

**A second profile:** `--data-dir <folder>` puts the database, the log, and the
single-instance lock in that folder, so two profiles run side by side:

```bash
/Applications/Plutus.app/Contents/MacOS/Plutus --data-dir ~/plutus-test
npx electron . --data-dir /tmp/plutus-try      # development, in desktop/
"$(sh scripts/packaged-app.sh)" --data-dir /tmp/plutus-try   # the app in release/
```

**Restoring a backup by hand** (for example to go back to an older Plutus after an update
changed the database; the older app refuses data from a newer one):

1. Quit Plutus and make sure it is gone from Activity Monitor.
2. In the data folder, move `plutus.sqlite`, `plutus.sqlite-wal` and `plutus.sqlite-shm`
   (whichever exist) into a dated folder. Don't delete them; the `-wal` file can hold recent
   changes.
3. Copy the backup you want from `backups/` to `plutus.sqlite`.
4. Install the matching Plutus version and open it.

Anything changed since that backup is lost; transactions come back at the next SimpleFIN sync.
Secrets in the backup still decrypt on the same Mac. If Plutus restored a backup itself, its
dialog names the file.

If Settings says a secret cannot be decrypted, the Keychain item "Plutus Safe Storage" was
reset or access to it was denied: reconnect SimpleFIN and re-enter API keys in Settings. When
a new build asks to use that item, choose Always Allow.

Load demo data into a profile with the app closed:
`PLUTUS_DB_PATH=<folder>/plutus.sqlite npm run demo -- load` in `server/`.

- Secrets (SimpleFIN access URL, API keys) are encrypted with Electron `safeStorage` (a key in
  the macOS Keychain, item "Plutus Safe Storage") and stored as blobs in `app_settings`. If OS
  encryption is unavailable, the app refuses to save a secret rather than storing it in plain
  text.
- Settings come from the `app_settings` table. Environment variables only seed defaults on
  first run.

## Updating

The builds are signed ad hoc (no Apple Developer ID yet), so there is no auto-update: each
release is installed by hand or with the update script. Quit Plutus first in either case.

**With the script** (needs the GitHub CLI, logged in: `gh auth login`), in `desktop/`:

```bash
npm run update:app                    # the latest release
npm run update:app -- 0.2.0           # a given release
npm run update:app -- --rollback      # reinstall the app the last update replaced
npm run update:app -- --rollback --restore-data   # and put back the data from before it
```

It refuses to run while Plutus is open, or while any other process (a second Plutus, `sqlite3`,
a demo load) holds `plutus.sqlite` or its `-wal` file open; it names the process (via `lsof`)
and changes nothing until that is closed. This applies to updates, `--rollback`, and
`--restore-data`. It downloads the zip for this Mac's architecture and
checks its signature. Before replacing anything, it copies `plutus.sqlite` and its `-wal` and
`-shm` files to `backups/manual-<time>/` (keeping its newest five copies, never the one just
made, and nothing else in `backups/`) and zips the installed app to
`previous-app/Plutus-<version>.zip` (keeping the two most recently saved), both in
`~/Library/Application Support/Plutus`. Then it installs the app with `ditto`, verifies it, and
prints the old and new versions. A failed signature check changes nothing. Releases come from
the GitHub repository of the checkout's `origin` remote (not gh's default repository), or from
`GH_REPO=owner/repo` when set; a failed download prints gh's own error and changes nothing.
`make update` first runs `--check` (looks up the release for this Mac, changes nothing) and
quits Plutus only if that succeeds. `bash scripts/update.sh --help` lists the testing options
(`--target`, `--data-dir`, `PLUTUS_UPDATE_ZIP`).

`PLUTUS_SIGN_IDENTITY="<certificate name>"` re-signs the app with that code-signing identity
after its download signature is verified, then verifies it again (rollbacks re-sign the saved
app the same way). Use it with a self-signed certificate (see "Signing and notarization") so
updates stop asking about the Keychain:

```bash
PLUTUS_SIGN_IDENTITY="Plutus Local Signing" make update
```

**By hand:** quit Plutus; copy `plutus.sqlite` (and `plutus.sqlite-wal`, `plutus.sqlite-shm` if
present; they can hold recent changes) out of `~/Library/Application Support/Plutus`; download
`Plutus-<version>-arm64.zip` (or `-x64`) from the Releases page, unzip it, and replace
`/Applications/Plutus.app`; open it. Apps downloaded with a browser are quarantined: right-click,
then Open, once. Files fetched with `gh` are not.

**The Keychain prompt:** each new ad hoc build is a different app to the Keychain, so its first
launch asks to use "Plutus Safe Storage". Choose **Always Allow**. An app signed with your own
certificate (`PLUTUS_SIGN_IDENTITY`, above) keeps the same identity across updates: it asks once,
the first time, and not after later updates signed with the same certificate. Deny leaves the saved
SimpleFIN connection and API keys unreadable until they are entered again in Settings; the
financial data is not encrypted and is unaffected.

**Rollback:** `--rollback` reinstalls the newest saved app older than the installed one, after
copying the data to `backups/before-rollback-<time>/`. If the newer version changed the
database, the older app may not open it; then add `--restore-data`. It asks you to type
`restore`, moves the current data files to `backups/before-restore-<time>/`, and puts back the
copy from the last update (the newest `backups/manual-*`). Changes made since that update are
lost; synced transactions return with the next sync. For a release older than the saved apps,
run `npm run update:app -- <version>`. To use one of Plutus's own pre-update backups
(`backups/plutus-*-before-*.sqlite`) instead, see "Restoring a backup by hand" above.

## Releases

The app version is `version` in `desktop/package.json` (x.y.z). To release:

1. Cut a branch from `origin/main` (`git fetch origin && git switch -c release-0.1.1 origin/main`)
   and, in `desktop/`, run `npm run version:bump -- patch` (or `minor`, `major`). It updates
   `desktop/package.json` and the root `package-lock.json` and commits on the branch; it never
   tags.
2. Push the branch and open a pull request. The owner merges it into main.
3. Pull main and tag the merged commit (PRs are squash-merged, so it is not the branch commit),
   then push only the tag:
   `git switch main && git pull && git tag v0.1.1 && git push origin v0.1.1`.
4. `.github/workflows/release.yml` checks that the tag matches the package version
   (`npm run version:check-tag -- v0.1.1`) and is on main, runs `npm run check`, builds the ad
   hoc signed dmg and zip for arm64 and x64, verifies both signatures, runs `smoke:dist`, and
   publishes a GitHub Release with the four files and generated notes. Release files are kept
   until deleted (CI artifacts expire after 14 days).
5. Install it with `make update`.

A failed release run leaves the tag without a release: fix it through a pull request, then move
the tag to the merged commit (delete it locally and on GitHub, tag again, push only the tag) or
bump again.

## How it is put together

- `src/main.ts`: Electron lifecycle (single-instance lock, menu, window, shutdown,
  smoke mode). Verified by launching.
- `src/preload.cts`: the sandboxed window's preload; exposes only `window.plutusDesktop.platform`.
- `src/lib/`: the parts with logic, unit-tested: command-line flags, paths for development and
  packaged builds, the log file, the desktop server config and listener, the first page, the
  per-launch guard token, `SafeStorageSecretStore`, navigation rules,
  DevTools, signing, the smoke poller, the startup error dialog (`startup.ts`: a plain
  message when `openDb` refused data from a newer Plutus, did not update, or restored a backup),
  and release version checks (`version.ts`, used only by `scripts/version.mjs`).
- The shell imports the server through its package exports (`plutus-server/app`,
  `plutus-server/db`, ...). At run time they resolve to `server/dist`; the tsconfig
  (`customConditions`) and Vitest (`ssr.resolve.conditions`) add the `plutus-source`
  condition, which resolves them to `server/src`, so `npm run check` needs no server build.
- Security: each launch makes a random token. The server sets it as an `HttpOnly`,
  `SameSite=Strict` cookie on the page and rejects `/api` requests without it, so other local
  processes can't use the API. Links outside the app's origin open in the system browser;
  other schemes are blocked.
- better-sqlite3 13 ships N-API prebuilds, which load in Electron's Node without rebuilding.
  `npmRebuild` is therefore off, each build keeps only its architecture's prebuild, and
  `asarUnpack` keeps the `.node` file outside `app.asar`.
- `scripts/with-timeout.mjs` runs the smoke commands with a hard timeout and kills the whole
  process group, so no Electron helper outlives a run.

## Signing and notarization

`electron-builder.config.mjs` takes the macOS signing settings from `src/lib/signing.ts`:

- **No signing variables (the default):** the app is signed ad hoc (`identity: '-'`), without
  the hardened runtime, and not notarized. `codesign --verify --deep --strict` passes, Apple
  Silicon runs it, and safeStorage works. It runs on the Mac that built it. Copied to another
  Mac, Gatekeeper quarantines it: right-click, then Open, or
  `xattr -dr com.apple.quarantine Plutus.app`. Each new ad hoc build is a different app to
  the Keychain, so macOS may ask once to let it use "Plutus Safe Storage"; choose Always Allow.
- **With a certificate:** set `CSC_LINK` (path or base64 of the exported `.p12`) and
  `CSC_KEY_PASSWORD`, or `CSC_NAME` for a certificate already in the keychain. The app is
  signed with it and the hardened runtime, with electron-builder's default entitlements (JIT,
  and library validation off, so Electron's frameworks and the SQLite addon load even from a
  certificate with no Team ID, such as a self-signed one). A Developer ID certificate or a
  self-signed one both work; only a Developer ID build can be notarized.
- **Notarization** runs only for a certificate build with a full set of Apple credentials:
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`; or an App Store Connect API
  key: `APPLE_API_KEY` (path to the `.p8`), `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. A
  certificate without them (a self-signed one) is signed but not notarized; an ad hoc build is
  never notarized.

```bash
CSC_LINK=~/secure/developer-id.p12 CSC_KEY_PASSWORD=... \
APPLE_ID=you@example.com APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=ABCDE12345 \
  npm run dist
```

Signed and notarized builds are configured but not yet verified (no certificate here).

### A self-signed certificate for your own Mac

Ad hoc builds change identity every release, so the Keychain asks about "Plutus Safe Storage"
after every update. A one-time self-signed code-signing certificate gives the app one identity:

1. Open Keychain Access, then Keychain Access > Certificate Assistant > Create a Certificate.
2. Name it `Plutus Local Signing`, Identity Type **Self Signed Root**, Certificate Type
   **Code Signing**, and create it (in the login keychain).
3. Check it is there: `security find-identity -p codesigning` lists `Plutus Local Signing`
   (as not trusted, which is fine for signing).

Then install updates with `PLUTUS_SIGN_IDENTITY="Plutus Local Signing" make update`, or build
with it: `CSC_NAME="Plutus Local Signing" npm run dist` (signed, hardened, not notarized). The
first signing asks to use the certificate's key: choose Always Allow. The first launch of the
re-signed app asks about "Plutus Safe Storage" once more; later updates signed the same way do
not. The certificate is trusted only on this Mac; it does not help Gatekeeper on another one.
