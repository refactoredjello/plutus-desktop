import { useEffect, useState, useSyncExternalStore } from 'react'

/**
 * Every animation's timing, in ms. Short and quiet on purpose. index.css mirrors these as
 * --motion-* custom properties for the CSS-only animations; keep the two in step.
 */
export const MOTION = {
  /** Route cross-fade. */
  route: 100,
  /** A list row fading and collapsing on its way out. */
  exit: 150,
  /** Numbers and bars settling in on first load. */
  enter: 200,
  /** Chart entrance. */
  chart: 300,
} as const

export const CHART_EASING = 'ease-out' as const

const REDUCED = '(prefers-reduced-motion: reduce)'

export const prefersReducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia(REDUCED).matches

function subscribe(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(REDUCED)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/** True while the OS asks for reduced motion; follows changes live. */
export const usePrefersReducedMotion = () => useSyncExternalStore(subscribe, prefersReducedMotion, () => false)

/**
 * True for the first `ms` after `ready` first turns true, then false for good: an entrance
 * that never replays on refetch or hover. Always false with reduced motion.
 */
export function useAnimateOnce(ready: boolean, ms: number = MOTION.chart): boolean {
  const reduced = usePrefersReducedMotion()
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!ready || done) return
    const timer = setTimeout(() => setDone(true), ms)
    return () => clearTimeout(timer)
  }, [ready, done, ms])
  return ready && !done && !reduced
}

/** Recharts series props for an entrance driven by `useAnimateOnce`. */
export const chartAnimation = (active: boolean) =>
  ({ isAnimationActive: active, animationDuration: MOTION.chart, animationEasing: CHART_EASING }) as const
