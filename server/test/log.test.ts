import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLogger } from '../src/lib/log.js'

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk))
      done()
    },
  })
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  }
}

describe('createLogger (app/logging.py)', () => {
  it('writes structured lines with a level name and an ISO UTC timestamp', () => {
    const out = capture()
    createLogger({ level: 'info' }, out.stream).info({ added: 3 }, 'sync finished')
    const [line] = out.lines()
    expect(line).toMatchObject({ level: 'info', msg: 'sync finished', added: 3 })
    expect(String(line?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('filters below the configured level, case-insensitively', () => {
    const out = capture()
    const log = createLogger({ level: 'WARNING' }, out.stream)
    log.info('hidden')
    log.warn('shown')
    expect(out.lines().map((l) => l.msg)).toEqual(['shown'])
  })

  it('binds context such as the request id on child loggers', () => {
    const out = capture()
    createLogger({ level: 'info' }, out.stream).child({ request_id: 'abc123' }).info('hello')
    expect(out.lines()[0]).toMatchObject({ request_id: 'abc123', msg: 'hello' })
  })
})
