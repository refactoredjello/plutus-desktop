/**
 * Write the OpenAPI spec to a file: `tsx scripts/export-openapi.ts <path>`.
 * Ports app/export_openapi.py, keeping its byte format so diffs stay readable.
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, openApiDocument } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { openDb } from '../src/db/index.js'
import { silentLogger } from '../src/lib/log.js'
import { KeySecretStore } from '../src/secrets.js'

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

/** `json.dumps(value, indent=2, sort_keys=True) + "\n"`, ensure_ascii included. */
export function stableJson(value: unknown): string {
  const text = JSON.stringify(sortKeys(value), null, 2)
  let ascii = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // Python escapes every UTF-16 unit outside printable ASCII: DEL and above, surrogates too.
    ascii += code > 0x7e ? `\\u${code.toString(16).padStart(4, '0')}` : text.charAt(i)
  }
  return `${ascii}\n`
}

export function renderOpenApi(): string {
  const config = loadConfig({ PLUTUS_DB_PATH: ':memory:', ENVIRONMENT: 'test' })
  const db = openDb(':memory:')
  try {
    const app = createApp({ db, config, secrets: new KeySecretStore(config.secretKey), log: silentLogger() })
    return stableJson(openApiDocument(app))
  } finally {
    db.$client.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? 'openapi.json')
  writeFileSync(out, renderOpenApi())
  console.log(`wrote ${out}`)
}
