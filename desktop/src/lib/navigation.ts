/**
 * What the window does with a link or navigation: stay in the app for the loopback origin,
 * hand web and mail links to the system browser, and refuse everything else.
 */

export type NavigationAction = 'app' | 'external' | 'block'

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function classifyNavigation(url: string, appOrigin: string): NavigationAction {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'block'
  }
  if (parsed.origin === appOrigin) return 'app'
  if (EXTERNAL_PROTOCOLS.has(parsed.protocol)) return 'external'
  return 'block'
}
