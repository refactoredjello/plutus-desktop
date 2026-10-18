import { DatabaseOpenError } from 'plutus-server/db'
import { describe, expect, it } from 'vitest'
import { startupDialog } from '../src/lib/startup.js'

const LOG = '/data/logs/plutus.log'

describe('startupDialog', () => {
  it('says the backup was restored and where it is', () => {
    const backup = '/data/backups/plutus-2026-10-18T12-00-00-000Z-before-0001_x.sqlite'
    const d = startupDialog(new DatabaseOpenError('restored', 'technical detail', { backupPath: backup }), LOG)
    expect(d.title).toMatch(/could not update your data/i)
    expect(d.message).toMatch(/restored/)
    expect(d.message).toContain(backup)
    expect(d.message).toContain(LOG)
  })

  it('passes through the newer-version message, which names both versions', () => {
    const d = startupDialog(
      new DatabaseOpenError('too_new', 'This data was last opened by a newer version of Plutus (0.2.0).'),
      LOG,
    )
    expect(d.title).toMatch(/newer version of Plutus/)
    expect(d.message).toContain('0.2.0')
  })

  it('says nothing changed when the backup or the migration failed', () => {
    for (const kind of ['backup_failed', 'migration_failed'] as const) {
      const d = startupDialog(new DatabaseOpenError(kind, 'Detail. Your data has not been changed.'), LOG)
      expect(d.message).toMatch(/not been changed/)
      expect(d.message).toContain(LOG)
    }
  })

  it('keeps the generic dialog for anything else', () => {
    expect(startupDialog(new Error('port in use'), LOG)).toEqual({
      title: 'Plutus could not start',
      message: `port in use\n\nDetails are in ${LOG}.`,
    })
    expect(startupDialog('boom', null)).toEqual({ title: 'Plutus could not start', message: 'boom' })
  })
})
