import { useSyncExternalStore } from 'react'

/**
 * Appearance: the root element gets `dark` from the chosen theme. The choice lives on
 * <html data-theme> ("light" or "dark"; absent means follow the system), written by the
 * server into the page it serves and changed in Settings. index.css paints the background
 * from the same attribute and media query before the bundle runs, so the first paint is
 * already in the right theme.
 */
export type ThemePreference = 'system' | 'light' | 'dark'

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)')

function apply(root: HTMLElement, query: MediaQueryList | { matches: boolean }) {
  const chosen = root.dataset.theme
  root.classList.toggle('dark', chosen === 'dark' || (chosen !== 'light' && query.matches))
}

/** Apply the theme now and whenever the system appearance changes. Returns a stop function. */
export function followSystemTheme(root: HTMLElement = document.documentElement, query: MediaQueryList = systemDark()): () => void {
  const onChange = (e: MediaQueryListEvent) => apply(root, e)
  apply(root, query)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/** The theme chosen on this page: the root's data-theme, or system. */
export function themePreference(root: HTMLElement = document.documentElement): ThemePreference {
  const chosen = root.dataset.theme
  return chosen === 'light' || chosen === 'dark' ? chosen : 'system'
}

/** Switch to a theme at once (saving it is the caller's job). */
export function setThemePreference(
  theme: ThemePreference,
  root: HTMLElement = document.documentElement,
  query: MediaQueryList = systemDark(),
): void {
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme
  apply(root, query)
}

/** Whether the page is dark now, for components that need the theme as a value (React). */
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribeDark, () => document.documentElement.classList.contains('dark'))
}

function subscribeDark(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}
