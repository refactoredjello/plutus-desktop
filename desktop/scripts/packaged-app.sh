#!/bin/sh
# Prints the path of the packaged app's executable for this machine's architecture
# (electron-builder writes release/mac-arm64 and release/mac for x64).
set -eu
cd "$(dirname "$0")/.."
case "$(uname -m)" in
  arm64) dir=release/mac-arm64 ;;
  *) dir=release/mac ;;
esac
exe="$dir/Plutus.app/Contents/MacOS/Plutus"
if [ ! -x "$exe" ]; then
  echo "no packaged app at $exe: run npm run dist first" >&2
  exit 1
fi
echo "$PWD/$exe"
