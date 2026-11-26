#!/bin/bash
# Installs a Plutus release from GitHub Releases into /Applications, safely. Run it in a
# terminal (in desktop/: npm run update:app [-- <version> | -- --rollback]).
#
#   update.sh                     install the latest release
#   update.sh 0.2.0               install release v0.2.0
#   update.sh --rollback          reinstall the previous app kept by an earlier update
#   update.sh --rollback --restore-data
#                                 also put back the data copy made before the last update
#                                 (asks you to type "restore")
#   update.sh --check [<version>] only look up that release (or the latest) for this Mac and
#                                 change nothing; make update runs it before quitting Plutus
#
# Releases come from GH_REPO=<owner/repo> if set, else from the GitHub repository of this
# checkout's origin remote (gh's own default repository is not used); every gh call is given it.
# Options for testing: --target <dir> instead of /Applications, --data-dir <dir> instead of
# ~/Library/Application Support/Plutus. Environment: PLUTUS_UPDATE_ZIP=<zip> installs that zip
# instead of downloading; PLUTUS_PROCESS_NAME overrides the process name checked (Plutus);
# PLUTUS_SIGN_IDENTITY=<certificate name> re-signs the app with that code-signing identity
# (desktop/README.md, "Signing and notarization"), so the Keychain keeps trusting it.
#
# Order of work, so nothing is replaced without a copy first: check Plutus is not running and
# nothing holds plutus.sqlite or its -wal file open,
# download and verify the new app, copy the data (plutus.sqlite, -wal, -shm) to
# backups/manual-<time>/ (its newest five copies are kept), zip the installed app to
# previous-app/Plutus-<version>.zip (the two most recently saved are kept), then swap the app in
# and verify its signature.

set -euo pipefail

TARGET=/Applications
DATA_DIR="$HOME/Library/Application Support/Plutus"
PROCESS_NAME="${PLUTUS_PROCESS_NAME:-Plutus}"
SIGN_IDENTITY="${PLUTUS_SIGN_IDENTITY:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_FILES="plutus.sqlite plutus.sqlite-wal plutus.sqlite-shm"
KEEP_APPS=2   # previous-app zips, by when they were saved
KEEP_COPIES=5 # this script's data copies in backups/, by the time in their names
CURRENT_COPY="" # the copy made in this run; never pruned

mode=install
check=0
restore_data=0
want=""
REPO="" # owner/repo the releases come from (resolve_repo)

usage() {
  sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
  echo "update: $*" >&2
  exit 1
}

bad_usage() {
  echo "update: $*" >&2
  echo "Run with --help for usage." >&2
  exit 2
}

say() {
  echo "==> $*"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      [ $# -ge 2 ] || bad_usage "--target needs a folder"
      TARGET="$2"
      shift
      ;;
    --data-dir)
      [ $# -ge 2 ] || bad_usage "--data-dir needs a folder"
      DATA_DIR="$2"
      shift
      ;;
    --rollback) mode=rollback ;;
    --check) check=1 ;;
    --restore-data) restore_data=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) bad_usage "unknown option $1" ;;
    *)
      [ -z "$want" ] || bad_usage "give at most one version"
      want="${1#v}"
      ;;
  esac
  shift
done

if [ "$restore_data" = 1 ] && [ "$mode" != rollback ]; then
  bad_usage "--restore-data only works with --rollback"
fi
if [ "$check" = 1 ] && [ "$mode" != install ]; then
  bad_usage "--check only works for an install"
fi
if [ -n "$want" ]; then
  [ "$mode" = install ] || bad_usage "--rollback takes no version"
  [[ "$want" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || bad_usage "versions look like 0.2.0, got $want"
fi

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac

APP="$TARGET/Plutus.app"
PREV="$DATA_DIR/previous-app"
BACKUPS="$DATA_DIR/backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/plutus-update.XXXXXX")"
STAGED="$TARGET/.Plutus.app.new-$$"
OLD="$TARGET/.Plutus.app.old-$$"

cleanup() {
  # If the swap was interrupted after the old app moved aside, put it back.
  if [ -d "$OLD" ] && [ ! -d "$APP" ]; then
    mv "$OLD" "$APP" && echo "update: put the previous app back in $TARGET" >&2
  fi
  rm -rf "$STAGED" "$WORK"
}
trap cleanup EXIT

# --- helpers -----------------------------------------------------------------------------

app_version() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null ||
    echo unknown
}

is_version() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# A sortable key for x.y.z (only call with is_version values).
version_key() {
  local a b c
  IFS=. read -r a b c <<<"$1"
  printf '%06d%06d%06d' "$((10#$a))" "$((10#$b))" "$((10#$c))"
}

# Prints a folder path under $BACKUPS that does not exist yet.
fresh_dir() {
  local base="$BACKUPS/$1-$STAMP" dir n=2
  dir="$base"
  while [ -e "$dir" ]; do
    dir="$base-$n"
    n=$((n + 1))
  done
  echo "$dir"
}

require_quit() {
  if pgrep -x "$PROCESS_NAME" >/dev/null 2>&1; then
    die "Plutus is running. Quit Plutus (Cmd-Q, or Plutus > Quit Plutus), then run this again."
  fi
  # Any other process with the database open (a second copy of Plutus, sqlite3, a demo load)
  # could write to it while it is copied, restored, or opened by the new app.
  [ -f "$DATA_DIR/plutus.sqlite" ] || return 0
  command -v lsof >/dev/null 2>&1 || return 0
  local f holders="" pid="" line
  for f in plutus.sqlite plutus.sqlite-wal; do
    [ -e "$DATA_DIR/$f" ] || continue
    # lsof -F pc prints "p<pid>" then "c<command>" for each process holding the file.
    while read -r line; do
      case "$line" in
        p*) pid="${line#p}" ;;
        c*) holders="$holders
  $f is open in ${line#c} (pid $pid)" ;;
      esac
    done < <(lsof -F pc "$DATA_DIR/$f" 2>/dev/null || true)
  done
  if [ -n "$holders" ]; then
    die "your data is in use:$holders
Close it (quit that program), then run this again. Nothing was changed."
  fi
}

# owner/repo from a GitHub remote URL (https://, git@github.com:, or ssh://git@github.com/).
repo_from_url() {
  local path
  case "$1" in
    https://github.com/*) path="${1#https://github.com/}" ;;
    git@github.com:*) path="${1#git@github.com:}" ;;
    ssh://git@github.com/*) path="${1#ssh://git@github.com/}" ;;
    *) return 1 ;;
  esac
  path="${path%/}"
  path="${path%.git}"
  [[ "$path" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
  echo "$path"
}

# Sets REPO: GH_REPO, else origin's GitHub repository; never gh's per-checkout default, which a
# checkout with more than one remote may not have. Also checks gh is installed.
resolve_repo() {
  if [ -n "${GH_REPO:-}" ]; then
    REPO="$GH_REPO"
  else
    local url=""
    url="$(git -C "$SCRIPT_DIR" remote get-url origin 2>/dev/null)" || url=""
    if ! REPO="$(repo_from_url "$url")"; then
      die "can't tell which GitHub repository to download releases from: ${url:+the origin remote $url is not on GitHub}${url:-this checkout has no origin remote}.
Run it again with GH_REPO=<owner/repo>. Nothing was changed."
    fi
  fi
  command -v gh >/dev/null 2>&1 ||
    die "gh (GitHub CLI) is not installed: brew install gh, then gh auth login"
}

# Dies with gh's own error (in the given file) for a failed gh call about $1.
gh_failed() {
  local msg
  msg="could not $1 from $REPO; gh said:
$(sed 's/^/  /' "$2")"
  if grep -qiE 'gh auth login|HTTP 401|bad credentials|not logged in' "$2"; then
    msg="$msg
gh is not logged in to GitHub: run gh auth login (gh auth status shows the state)."
  fi
  die "$msg
GH_REPO=<owner/repo> picks the repository. Nothing was changed."
}

# What to call the release asked for, in messages.
release_label() {
  if [ -n "$want" ]; then echo "release v$want"; else echo "the latest release"; fi
}

# Looks up the release (latest or v$want) and checks it has a zip for this Mac.
check_release() {
  local out="$WORK/release.txt" err="$WORK/gh-error.txt" tag name line
  gh release view ${want:+"v$want"} --repo "$REPO" --json tagName,assets \
    --jq '.tagName, .assets[].name' >"$out" 2>"$err" ||
    gh_failed "look up $(release_label)" "$err"
  tag="$(head -n 1 "$out")"
  name="Plutus-${want:-[0-9]*.[0-9]*.[0-9]*}-$ARCH.zip"
  while read -r line; do
    # shellcheck disable=SC2053 # $name is a glob on purpose
    if [[ "$line" == $name ]]; then
      say "Found release $tag for $ARCH in $REPO"
      return 0
    fi
  done < <(tail -n +2 "$out")
  die "release $tag in $REPO has no Plutus-${want:-*}-$ARCH.zip. Nothing was changed."
}

require_target() {
  [ -d "$TARGET" ] || die "$TARGET does not exist"
  [ -w "$TARGET" ] || die "can't write to $TARGET"
}

# Downloads the release zip for this Mac; prints its path.
fetch_zip() {
  if [ -n "${PLUTUS_UPDATE_ZIP:-}" ]; then
    [ -f "$PLUTUS_UPDATE_ZIP" ] || die "PLUTUS_UPDATE_ZIP: no file at $PLUTUS_UPDATE_ZIP"
    echo "$PLUTUS_UPDATE_ZIP"
    return
  fi
  local dir="$WORK/download" err="$WORK/gh-error.txt"
  mkdir -p "$dir"
  gh release download ${want:+"v$want"} --repo "$REPO" --pattern "Plutus-${want:-*}-$ARCH.zip" \
    --dir "$dir" 2>"$err" >&2 ||
    gh_failed "download $(release_label)" "$err"
  local zip
  zip="$(find "$dir" -maxdepth 1 -name "Plutus-*-$ARCH.zip" | head -n 1)"
  [ -n "$zip" ] || die "the release has no Plutus-*-$ARCH.zip"
  echo "$zip"
}

# Unzips an app zip into the work folder, clears quarantine on it, verifies the signature, and
# with PLUTUS_SIGN_IDENTITY re-signs it with that identity and verifies again; prints the app's
# path. The download is verified as it came, so re-signing never hides a damaged app. Nothing
# outside the work folder changes.
unpack_app() {
  local zip="$1" into
  into="$(mktemp -d "$WORK/app.XXXXXX")"
  ditto -x -k "$zip" "$into" || die "could not unzip $zip"
  [ -d "$into/Plutus.app" ] || die "$zip has no Plutus.app at its top level"
  xattr -dr com.apple.quarantine "$into/Plutus.app" 2>/dev/null || true
  codesign --verify --deep --strict "$into/Plutus.app" >&2 ||
    die "the signature of Plutus.app in $zip does not verify; nothing was changed"
  if [ -n "$SIGN_IDENTITY" ]; then
    codesign --force --deep --sign "$SIGN_IDENTITY" "$into/Plutus.app" >&2 ||
      die "could not sign Plutus.app with \"$SIGN_IDENTITY\" (is it in your keychain? security find-identity -p codesigning); nothing was changed"
    codesign --verify --deep --strict "$into/Plutus.app" >&2 ||
      die "Plutus.app signed with \"$SIGN_IDENTITY\" does not verify; nothing was changed"
  fi
  echo "$into/Plutus.app"
}

# Copies plutus.sqlite and its -wal and -shm files (never the backups folder) to a new folder.
copy_data() {
  if [ ! -f "$DATA_DIR/plutus.sqlite" ]; then
    say "No data at $DATA_DIR/plutus.sqlite yet; nothing to copy"
    return
  fi
  local dest f
  dest="$(fresh_dir "$1")"
  mkdir -p "$dest"
  for f in $DATA_FILES; do
    if [ -e "$DATA_DIR/$f" ]; then
      ditto "$DATA_DIR/$f" "$dest/$f"
      cmp -s "$DATA_DIR/$f" "$dest/$f" || die "the copy of $f in $dest differs from the original"
    fi
  done
  CURRENT_COPY="$(basename "$dest")"
  say "Copied your data to $dest"
}

# Zips the installed app to previous-app/Plutus-<version>.zip.
keep_installed_app() {
  [ -d "$APP" ] || return 0
  local version zip
  version="$(app_version "$APP")"
  is_version "$version" || version="unknown-$STAMP"
  mkdir -p "$PREV"
  zip="$PREV/Plutus-$version.zip"
  ditto -c -k --keepParent "$APP" "$zip.partial"
  mv -f "$zip.partial" "$zip"
  say "Kept the installed app as $zip"
}

# Replaces $APP with the given app; puts the old one back if the result does not verify.
swap_in() {
  rm -rf "$STAGED"
  ditto "$1" "$STAGED"
  if [ -d "$APP" ]; then
    mv "$APP" "$OLD"
  fi
  mv "$STAGED" "$APP"
  if ! codesign --verify --deep --strict "$APP" >&2; then
    rm -rf "$APP"
    if [ -d "$OLD" ]; then mv "$OLD" "$APP"; fi
    die "the installed app's signature does not verify; the previous app is back in place"
  fi
  rm -rf "$OLD"
}

# previous-app/Plutus-<x.y.z>.zip files, highest version first, as "<key> <path>" lines.
saved_apps() {
  [ -d "$PREV" ] || return 0
  local path name version
  for path in "$PREV"/Plutus-*.zip; do
    [ -f "$path" ] || continue
    name="$(basename "$path")"
    version="${name#Plutus-}"
    version="${version%.zip}"
    is_version "$version" || continue
    echo "$(version_key "$version") $path"
  done | sort -r
}

# Keeps the most recently saved previous-app zips (ls -t: newest file time first).
prune_saved_apps() {
  [ -d "$PREV" ] || return 0
  local name
  ls -t "$PREV" | awk '/^Plutus-.*\.zip$/' | tail -n +$((KEEP_APPS + 1)) | while read -r name; do
    rm -f "$PREV/$name"
    say "Removed the older saved app $name"
  done
}

# Keeps this script's newest data copies (manual-, before-rollback-, before-restore-<time>[-n])
# by the time in their names, always including this run's. Nothing else in backups/ is touched.
prune_data_copies() {
  [ -d "$BACKUPS" ] || return 0
  local keep=$KEEP_COPIES path name stamp key
  if [ -n "$CURRENT_COPY" ]; then keep=$((keep - 1)); fi
  find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d \
    \( -name 'manual-*' -o -name 'before-rollback-*' -o -name 'before-restore-*' \) |
    while read -r path; do
      name="$(basename "$path")"
      if [ "$name" = "$CURRENT_COPY" ]; then continue; fi
      stamp="${name#manual-}"
      stamp="${stamp#before-rollback-}"
      stamp="${stamp#before-restore-}"
      if [[ "$stamp" =~ ^([0-9]{8}T[0-9]{6}Z)(-([0-9]+))?$ ]]; then
        printf '%s%06d %s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[3]:-1}" "$path"
      fi
    done | sort -r | tail -n +$((keep + 1)) | while read -r key path; do
    rm -rf "$path"
    say "Removed the older data copy $(basename "$path")"
  done
}

# Moves the live data files aside, then copies the chosen backup's files in.
restore_data_from() {
  local from="$1" aside f
  aside="$(fresh_dir before-restore)"
  mkdir -p "$aside"
  for f in $DATA_FILES; do
    if [ -e "$DATA_DIR/$f" ]; then mv "$DATA_DIR/$f" "$aside/$f"; fi
  done
  CURRENT_COPY="$(basename "$aside")"
  say "Moved your current data to $aside"
  for f in $DATA_FILES; do
    if [ -e "$from/$f" ]; then ditto "$from/$f" "$DATA_DIR/$f"; fi
  done
  say "Restored the data copy from $from"
}

finish() {
  local old="$1" new="$2" next="$3"
  echo
  echo "Plutus $old -> $new, installed in $TARGET."
  echo
  if [ -n "$SIGN_IDENTITY" ] && [ "$SIGN_IDENTITY" != - ]; then
    echo "Signed with \"$SIGN_IDENTITY\". Once the Keychain trusts an app signed with it, opening"
    echo "Plutus no longer asks to use \"Plutus Safe Storage\"."
  else
    echo "Open Plutus. A new build asks once to use \"Plutus Safe Storage\" in your Keychain:"
    echo "choose Always Allow (Deny makes the saved SimpleFIN and API keys unreadable)."
  fi
  echo "Data copies:   $BACKUPS"
  echo "Previous apps: $PREV"
  echo "$next"
}

# --- main ----------------------------------------------------------------------------------

# Find the repository first: a failure here changes nothing, and --check (run by make update
# while Plutus is still open) needs only this and the lookup.
if [ "$mode" = install ] && [ -z "${PLUTUS_UPDATE_ZIP:-}" ]; then resolve_repo; fi
if [ "$check" = 1 ]; then
  if [ -n "${PLUTUS_UPDATE_ZIP:-}" ]; then
    [ -f "$PLUTUS_UPDATE_ZIP" ] || die "PLUTUS_UPDATE_ZIP: no file at $PLUTUS_UPDATE_ZIP"
    say "Will install $PLUTUS_UPDATE_ZIP"
  else
    check_release
  fi
  exit 0
fi

require_quit
require_target

old="none"
if [ -d "$APP" ]; then old="$(app_version "$APP")"; fi

if [ "$mode" = install ]; then
  if [ -n "${PLUTUS_UPDATE_ZIP:-}" ]; then
    say "Using $PLUTUS_UPDATE_ZIP"
  else
    say "Downloading the ${want:+v}${want:-latest} release for $ARCH from $REPO"
  fi
  zip="$(fetch_zip)"
  new_app="$(unpack_app "$zip")"
  new="$(app_version "$new_app")"
  say "Unpacked Plutus $new; signature verified"
  if [ "$new" = "$old" ]; then
    say "Plutus $new is already installed; reinstalling it"
  elif is_version "$new" && is_version "$old" && [[ "$(version_key "$new")" < "$(version_key "$old")" ]]; then
    say "Plutus $new is older than the installed $old. If $old upgraded your data, the older"
    say "app may not open it; --rollback --restore-data puts back the copy from before."
  fi

  require_quit
  copy_data manual
  keep_installed_app
  swap_in "$new_app"
  prune_saved_apps
  prune_data_copies
  finish "$old" "$new" "To undo: npm run update:app -- --rollback (in desktop/)"
  exit 0
fi

# Rollback: the highest saved version below the installed one.
from_zip=""
while read -r key path; do
  [ -n "$key" ] || continue
  if ! is_version "$old" || [[ "$key" < "$(version_key "$old")" ]]; then
    from_zip="$path"
    break
  fi
done < <(saved_apps)
[ -n "$from_zip" ] ||
  die "no older app is saved in $PREV. Install an older release instead: npm run update:app -- <version>"

back_app="$(unpack_app "$from_zip")"
back="$(app_version "$back_app")"
say "Rolling back from Plutus $old to $back ($from_zip; signature verified)"

data_from=""
if [ "$restore_data" = 1 ]; then
  [ -d "$BACKUPS" ] && data_from="$(find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d -name 'manual-*' | sort | tail -n 1)"
  [ -n "$data_from" ] && [ -f "$data_from/plutus.sqlite" ] ||
    die "no data copy from an update (backups/manual-*) in $BACKUPS; nothing was changed"
  echo
  echo "This replaces your current data with the copy in"
  echo "  $data_from"
  echo "made before an update. Changes since then are lost (synced transactions come back on"
  echo "the next sync; edits, rules, and categories do not). Your current data is moved to"
  echo "$BACKUPS/before-restore-<time>/, not deleted."
  printf 'Type restore to continue: '
  answer=""
  read -r answer || true
  [ "$answer" = restore ] || die "not confirmed; nothing was changed"
fi

require_quit
if [ -n "$data_from" ]; then
  keep_installed_app
  swap_in "$back_app"
  restore_data_from "$data_from"
else
  copy_data before-rollback
  keep_installed_app
  swap_in "$back_app"
fi
prune_saved_apps
prune_data_copies
finish "$old" "$back" "To go forward again: npm run update:app (in desktop/)"
