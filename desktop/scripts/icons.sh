#!/bin/sh
# Regenerates the macOS app icon from build/icon.svg (sips and iconutil ship with macOS).
#   npm run icons      (in desktop/)
# Writes build/icon.icns. Commit it with the SVG.
set -eu

cd "$(dirname "$0")/.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

sips -s format png build/icon.svg --out "$work/icon.png" >/dev/null

iconset="$work/icon.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
  double=$((size * 2))
  sips -z "$size" "$size" "$work/icon.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$double" "$double" "$work/icon.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o build/icon.icns

echo "wrote build/icon.icns"
