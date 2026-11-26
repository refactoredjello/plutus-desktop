/**
 * The app follows the system appearance: `dark` on the root element while the OS is dark,
 * updated live. index.css paints the dark background from the same media query before this
 * runs, so a dark system never sees a light flash on load.
 */
export function followSystemTheme(
  root: HTMLElement = document.documentElement,
  query: MediaQueryList = window.matchMedia('(prefers-color-scheme: dark)'),
): () => void {
  const apply = (dark: boolean) => root.classList.toggle('dark', dark)
  const onChange = (e: MediaQueryListEvent) => apply(e.matches)
  apply(query.matches)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
