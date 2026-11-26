import { screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { MOTION } from '@/lib/motion'
import { setReducedMotion } from '@/test/motion'
import { renderAt } from '@/test/render'

/** Every isAnimationActive a Bar or Line on the Overview rendered with. */
const seen: { name: string; active: unknown; duration: unknown }[] = []

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  const spy = <P extends { isAnimationActive?: unknown; animationDuration?: unknown }>(name: string, Real: (p: P) => unknown) =>
    function Spied(props: P) {
      seen.push({ name, active: props.isAnimationActive, duration: props.animationDuration })
      return (Real as (p: P) => React.ReactNode)(props)
    }
  return {
    ...actual,
    Bar: spy<ComponentProps<typeof actual.Bar>>('Bar', actual.Bar as never),
    Line: spy<ComponentProps<typeof actual.Line>>('Line', actual.Line as never),
  }
})

async function renderCharts() {
  seen.length = 0
  renderAt('/')
  await screen.findByText('Income vs. expenses')
  await waitFor(() => expect(seen.some((s) => s.name === 'Bar')).toBe(true))
  await waitFor(() => expect(seen.some((s) => s.name === 'Line')).toBe(true))
}

describe('Overview chart motion', () => {
  it('animates the charts on first render, then stops animating', async () => {
    await renderCharts()
    expect(seen.find((s) => s.active === true)).toMatchObject({ duration: MOTION.chart })
    // After the entrance, refetches and hovers render without animation.
    await waitFor(() => expect(seen.at(-1)!.active).toBe(false), { timeout: MOTION.chart * 4 })
  })

  it('never animates the charts with reduced motion', async () => {
    setReducedMotion(true)
    await renderCharts()
    expect(seen.every((s) => s.active === false)).toBe(true)
  })
})
