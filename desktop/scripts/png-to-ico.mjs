// Packs PNG files into a Windows .ico (PNG-compressed entries, Windows Vista and later).
//   node scripts/png-to-ico.mjs <out.ico> <a.png> [<b.png> ...]
// Used by scripts/icons.sh; no dependencies.

import { readFileSync, writeFileSync } from 'node:fs'

const [out, ...inputs] = process.argv.slice(2)
if (!out || inputs.length === 0) {
  console.error('usage: node scripts/png-to-ico.mjs <out.ico> <a.png> [<b.png> ...]')
  process.exit(2)
}

const images = inputs.map((file) => {
  const data = readFileSync(file)
  if (data.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`)
  // IHDR: width and height at bytes 16 and 20.
  return { data, width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
})

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(images.length, 4)

let offset = 6 + 16 * images.length
const entries = images.map(({ data, width, height }) => {
  const entry = Buffer.alloc(16)
  entry.writeUInt8(width >= 256 ? 0 : width, 0) // 0 means 256
  entry.writeUInt8(height >= 256 ? 0 : height, 1)
  entry.writeUInt8(0, 2) // no palette
  entry.writeUInt8(0, 3) // reserved
  entry.writeUInt16LE(1, 4) // colour planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(data.length, 8)
  entry.writeUInt32LE(offset, 12)
  offset += data.length
  return entry
})

writeFileSync(out, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]))
