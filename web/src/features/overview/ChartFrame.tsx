import { cloneElement, type ReactElement } from 'react'
import { ResponsiveContainer } from 'recharts'

const FALLBACK_WIDTH = 640

/**
 * Sizes a Recharts chart to its container. Environments without ResizeObserver (jsdom)
 * get a fixed width so charts still render in tests without warnings.
 */
export function ChartFrame({
  height = 260,
  children,
}: {
  height?: number
  children: ReactElement<{ width?: number; height?: number }>
}) {
  if (typeof ResizeObserver === 'undefined') {
    return cloneElement(children, { width: FALLBACK_WIDTH, height })
  }
  return (
    <ResponsiveContainer width="100%" height={height} initialDimension={{ width: FALLBACK_WIDTH, height }}>
      {children}
    </ResponsiveContainer>
  )
}
