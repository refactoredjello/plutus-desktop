import { useHealth } from './queries'

/** The app's version (the desktop release, or the server's headless), quietly at the page's foot. */
export function VersionLine() {
  const health = useHealth()
  if (!health.data) return null
  return <p className="text-xs text-muted-foreground">Plutus {health.data.version}</p>
}
