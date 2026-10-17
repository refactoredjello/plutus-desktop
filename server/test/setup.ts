/**
 * Test harness. Ports api/tests/conftest.py: where Python migrated one Postgres database and
 * rolled each test back, every test here gets its own in-memory SQLite database, migrated and
 * seeded, so there is nothing to roll back.
 */

import { fileURLToPath } from 'node:url'
import { type Db, openDb } from '../src/db/index.js'

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))

/** A fresh in-memory database with the schema and the category seed. */
export function makeDb(): Db {
  return openDb(':memory:')
}
