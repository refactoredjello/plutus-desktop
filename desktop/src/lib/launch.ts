/**
 * The first page the window opens: Settings while SimpleFIN is not connected (a new install),
 * else the Overview. Asked of the running server, through the cookie guard like the page.
 */

import { GUARD_COOKIE } from 'plutus-server/app'

type Fetch = (url: string, init: RequestInit) => Promise<Response>

export async function initialPath(origin: string, guardToken: string, fetchImpl: Fetch = fetch): Promise<string> {
  try {
    const res = await fetchImpl(`${origin}/api/settings/simplefin`, {
      headers: { cookie: `${GUARD_COOKIE}=${guardToken}` },
    })
    if (!res.ok) return '/'
    const body = (await res.json()) as { connected?: unknown }
    return body.connected === false ? '/settings' : '/'
  } catch {
    return '/'
  }
}
