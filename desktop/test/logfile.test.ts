import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileLogDestination } from '../src/lib/logfile.js'

describe('fileLogDestination', () => {
  let dir: string
  let echoed: string[]
  const echo = { write: (line: string) => echoed.push(line) }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plutus-logfile-'))
    echoed = []
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('creates the log folder and appends each line to the file and to stdout', () => {
    const file = join(dir, 'logs', 'plutus.log')
    const log = fileLogDestination(file, { echo })
    log.write('{"msg":"one"}\n')
    log.write('{"msg":"two"}\n')
    log.close()
    expect(readFileSync(file, 'utf8')).toBe('{"msg":"one"}\n{"msg":"two"}\n')
    expect(echoed).toEqual(['{"msg":"one"}\n', '{"msg":"two"}\n'])
  })

  it('keeps the previous launches below the size limit', () => {
    const file = join(dir, 'plutus.log')
    writeFileSync(file, 'earlier\n')
    const log = fileLogDestination(file, { echo, maxBytes: 1024 })
    log.write('later\n')
    log.close()
    expect(readFileSync(file, 'utf8')).toBe('earlier\nlater\n')
    expect(existsSync(`${file}.1`)).toBe(false)
  })

  it('moves a file over the limit to plutus.log.1 at launch, replacing an older one', () => {
    mkdirSync(join(dir, 'logs'))
    const file = join(dir, 'logs', 'plutus.log')
    writeFileSync(`${file}.1`, 'oldest\n')
    writeFileSync(file, 'x'.repeat(2048))
    const log = fileLogDestination(file, { echo, maxBytes: 1024 })
    log.write('fresh\n')
    log.close()
    expect(readFileSync(file, 'utf8')).toBe('fresh\n')
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('x'.repeat(2048))
  })
})
