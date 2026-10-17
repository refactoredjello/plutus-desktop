/**
 * Test harness. Ports api/tests/conftest.py: where Python migrated one Postgres database and
 * rolled each test back, every test here gets its own in-memory SQLite database, migrated and
 * seeded, so there is nothing to roll back.
 */

import { fileURLToPath } from 'node:url'
import { type AppDeps, createApp } from '../src/app.js'
import { type Config, loadConfig } from '../src/config.js'
import { type Db, openDb } from '../src/db/index.js'
import { silentLogger } from '../src/lib/log.js'
import { KeySecretStore } from '../src/secrets.js'

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))

/** A fresh in-memory database with the schema and the category seed. */
export function makeDb(): Db {
  return openDb(':memory:')
}

/** Test config: like conftest.py's environment, with no web build to serve. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({
      ENVIRONMENT: 'test',
      SCHEDULER_ENABLED: 'false',
      LLM_PROVIDER: 'fake',
      PLUTUS_DATA_DIR: '/nonexistent/plutus-test',
      PLUTUS_DB_PATH: ':memory:',
      PLUTUS_SECRET_KEY: 'test-secret-key',
      PLUTUS_WEB_DIST: '/nonexistent/plutus-test/web-dist',
    }),
    ...overrides,
  }
}

/** The `client` fixture: an app over a fresh database. Call `app.request('/api/...')`. */
export function makeApp(overrides: Partial<AppDeps> = {}) {
  const db = overrides.db ?? makeDb()
  const config = overrides.config ?? testConfig()
  const app = createApp({
    db,
    config,
    secrets: overrides.secrets ?? new KeySecretStore(config.secretKey),
    log: overrides.log ?? silentLogger(),
    ...(overrides.guardToken === undefined ? {} : { guardToken: overrides.guardToken }),
  })
  return { app, db, config }
}
