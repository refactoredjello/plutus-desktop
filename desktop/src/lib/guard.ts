/**
 * The per-launch token for the API guard (plan section 5.9). The server sets it as an HttpOnly
 * SameSite=Strict cookie on the page and rejects /api requests without it, so other local
 * processes cannot use the loopback API.
 */

import { randomBytes } from 'node:crypto'

const TOKEN_BYTES = 32

export function newGuardToken(random: (size: number) => Buffer = randomBytes): string {
  return random(TOKEN_BYTES).toString('base64url')
}
