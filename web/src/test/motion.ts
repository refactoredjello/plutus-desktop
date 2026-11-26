import { screen, within } from '@testing-library/react'

let reduced = false

/** Pretend the OS asks for reduced motion (reset after every test). */
export function setReducedMotion(on: boolean) {
  reduced = on
}

/** jsdom has no matchMedia; this one answers only the reduced-motion query. */
export function installMatchMedia() {
  window.matchMedia = (query: string) =>
    ({
      matches: reduced && query.includes('prefers-reduced-motion: reduce'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

/** Queries scoped to the toast region the Layout mounts. */
export const toasts = () => within(screen.getByRole('region', { name: /Notifications/ }))
