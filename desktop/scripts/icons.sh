#!/bin/sh
# Regenerates the app icons from build/icon.svg (macOS: sips and iconutil ship with the OS).
#   npm run icons      (in desktop/)
# Writes build/icon.png (1024 px, Linux and the source for the others), build/icon.icns
# (macOS), and build/icon.ico (Windows). Commit all four files.
set -eu

cd "$(dirname "$0")/.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

sips -s format png build/icon.svg --out build/icon.png >/dev/null

iconset="$work/icon.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
  double=$((size * 2))
  sips -z "$size" "$size" build/icon.png --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$double" "$double" build/icon.png --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o build/icon.icns

for size in 16 24 32 48 64 128 256; do
  sips -z "$size" "$size" build/icon.png --out "$work/ico_$size.png" >/dev/null
done
node scripts/png-to-ico.mjs build/icon.ico \
  "$work/ico_16.png" "$work/ico_24.png" "$work/ico_32.png" "$work/ico_48.png" \
  "$work/ico_64.png" "$work/ico_128.png" "$work/ico_256.png"

echo "wrote build/icon.png, build/icon.icns, build/icon.ico"
