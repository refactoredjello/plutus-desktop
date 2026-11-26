/**
 * openDb refuses to back up and migrate when the disk is too full for the copy.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'

const space = vi.hoisted(() => ({ freeBytes: Number.MAX_SAFE_INTEGER }))

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    statfsSync: (path: string) => ({ ...fs.statfsSync(path), bsize: 1, bavail: space.freeBytes }),
  }
})

const { DatabaseOpenError, MIGRATIONS_FOLDER, openDb } = await import('../src/db/index.js')

const dir = mkdtempSync(join(tmpdir(), 'plutus-db-space-'))

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('does not migrate when there is not enough free space for the backup', () => {
  const dbPath = join(dir, 'plutus.sqlite')
  openDb(dbPath).$client.close()

  const folder = join(dir, 'migrations')
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true })
  const journalPath = join(folder, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Record<string, unknown>[] }
  const when = (journal.entries.at(-1)?.when as number) + 60_000
  const bundled = journal.entries.length
  journal.entries.push({ idx: bundled, version: '6', when, tag: '9001_marker', breakpoints: true })
  writeFileSync(journalPath, JSON.stringify(journal))
  writeFileSync(join(folder, '9001_marker.sql'), 'CREATE TABLE `marker` (`id` integer PRIMARY KEY);')

  space.freeBytes = 1024
  let error: unknown
  try {
    openDb(dbPath, { migrationsFolder: folder })
  } catch (err) {
    error = err
  }
  expect(error).toBeInstanceOf(DatabaseOpenError)
  expect((error as InstanceType<typeof DatabaseOpenError>).kind).toBe('backup_failed')
  expect((error as Error).message).toMatch(/free disk space/)
  expect((error as Error).message).toMatch(/not been changed/)

  const c = new Database(dbPath, { readonly: true })
  expect(c.prepare('SELECT count(*) FROM __drizzle_migrations').pluck().get()).toBe(bundled)
  c.close()
})
