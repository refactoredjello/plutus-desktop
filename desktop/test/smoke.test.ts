import { describe, expect, it } from 'vitest'
import { pollUntil } from '../src/lib/smoke.js'

describe('pollUntil', () => {
  it('resolves with the first truthy result', async () => {
    let calls = 0
    const value = await pollUntil(
      async () => {
        calls += 1
        return calls >= 3 ? { calls } : null
      },
      { timeoutMs: 1000, intervalMs: 1 },
    )
    expect(value).toEqual({ calls: 3 })
  })

  it('keeps polling through probe errors', async () => {
    let calls = 0
    const value = await pollUntil(
      async () => {
        calls += 1
        if (calls < 3) throw new Error('page not ready')
        return 'ready'
      },
      { timeoutMs: 1000, intervalMs: 1 },
    )
    expect(value).toBe('ready')
  })

  it('rejects after the timeout with the last error', async () => {
    await expect(
      pollUntil(
        async () => {
          throw new Error('still loading')
        },
        { timeoutMs: 30, intervalMs: 5 },
      ),
    ).rejects.toThrow(/timed out after 30 ms.*still loading/)
  })

  it('rejects after the timeout when the probe never succeeds', async () => {
    await expect(pollUntil(async () => null, { timeoutMs: 20, intervalMs: 5 })).rejects.toThrow(
      /timed out after 20 ms/,
    )
  })
})
