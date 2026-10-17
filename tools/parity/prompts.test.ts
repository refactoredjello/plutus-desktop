import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROMPT_NAMES,
  SAMPLES,
  collectTsPrompts,
  comparePrompts,
  exportCandidates,
  firstDifference,
  loadTsPrompts,
  pythonSamples,
} from './prompts.ts'

const python = {
  classify_system_prompt: 'You classify.\nTaxonomy.',
  savings_system_prompt: 'You help.',
  classify_user_message: 'Classify these merchants:\n[]',
  savings_user_message: 'Suggest savings for this situation:\n{}',
}

describe('exportCandidates', () => {
  it('accepts camelCase, snake_case, and constant names', () => {
    expect(exportCandidates('classify_system_prompt')).toEqual([
      'classifySystemPrompt',
      'classify_system_prompt',
      'CLASSIFY_SYSTEM_PROMPT',
    ])
  })
})

describe('collectTsPrompts', () => {
  it('reports every prompt missing when the module does not exist', () => {
    const ts = collectTsPrompts(null)
    expect(Object.keys(ts)).toEqual([...PROMPT_NAMES])
    for (const v of Object.values(ts)) expect(v).toEqual({ error: expect.stringContaining('missing') })
  })

  it('calls functions with the samples and accepts string constants', () => {
    const seen: unknown[] = []
    const ts = collectTsPrompts({
      classifySystemPrompt: () => 'A',
      SAVINGS_SYSTEM_PROMPT: 'B',
      classify_user_message: (items: unknown) => {
        seen.push(items)
        return 'C'
      },
    })
    expect(ts.classify_system_prompt).toBe('A')
    expect(ts.savings_system_prompt).toBe('B')
    expect(ts.classify_user_message).toBe('C')
    expect(seen).toEqual([SAMPLES.merchants])
    expect(ts.savings_user_message).toEqual({ error: expect.stringContaining('missing export') })
  })

  it('reports a throwing or non-string export', () => {
    const ts = collectTsPrompts({
      classifySystemPrompt: () => {
        throw new Error('boom')
      },
      savingsSystemPrompt: () => 42,
    })
    expect(ts.classify_system_prompt).toEqual({ error: 'call failed: boom' })
    expect(ts.savings_system_prompt).toEqual({ error: expect.stringContaining('not a string') })
  })
})

describe('firstDifference', () => {
  it('locates the first differing character with line and context', () => {
    const d = firstDifference('line one\nline two', 'line one\nline 2wo')
    expect(d).toEqual({ index: 14, line: 2, expected: expect.stringContaining('two'), actual: expect.stringContaining('2wo') })
  })

  it('handles one string being a prefix of the other', () => {
    expect(firstDifference('abc', 'abcd')?.index).toBe(3)
    expect(firstDifference('abc', 'abc')).toBeNull()
  })
})

describe('comparePrompts', () => {
  it('passes identical prompts and fails missing or differing ones', () => {
    const results = comparePrompts(python, {
      classify_system_prompt: 'You classify.\nTaxonomy.',
      savings_system_prompt: 'You help!',
      classify_user_message: { error: 'missing export: classifyUserMessage' },
      savings_user_message: 'Suggest savings for this situation:\n{}',
    })
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ['classify_system_prompt', true],
      ['savings_system_prompt', false],
      ['classify_user_message', false],
      ['savings_user_message', true],
    ])
    expect(results[1]?.detail).toContain('differs at character 8 (line 1)')
    expect(results[2]?.detail).toBe('missing export: classifyUserMessage')
  })

  it('fails a prompt the Python dump lacks', () => {
    const results = comparePrompts({ ...python, savings_user_message: undefined }, collectTsPrompts(null))
    expect(results.find((r) => r.name === 'savings_user_message')?.detail).toContain('Python')
  })
})

describe('samples', () => {
  it('give Python the same savings context with money as two-decimal strings', () => {
    const p = pythonSamples()
    expect(p.merchants).toEqual(SAMPLES.merchants)
    expect(p.savings.goal_target).toBe('6000.00')
    expect(p.savings.monthly_gap).toBe('-12.50')
    expect(p.savings.categories[0]?.monthly_totals).toEqual(['120.40', '98.05', '0.00'])
    expect(p.savings.recurring[0]?.amount).toBe('15.49')
    expect(SAMPLES.savings.goal_target).toBe(600000)
  })

  it('exercise non-ASCII text, which json.dumps escapes by default', () => {
    expect([...JSON.stringify(SAMPLES)].some((ch) => ch.charCodeAt(0) > 127)).toBe(true)
  })
})

describe('loadTsPrompts', () => {
  it('returns null when the file does not exist', async () => {
    expect(await loadTsPrompts(join(tmpdir(), 'no-such-dir', 'prompts.ts'))).toBeNull()
  })

  it('imports an existing module', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parity-prompts-'))
    const file = join(dir, 'prompts.mjs')
    writeFileSync(file, 'export const classifySystemPrompt = () => "hi"\n')
    const mod = await loadTsPrompts(file)
    expect(collectTsPrompts(mod).classify_system_prompt).toBe('hi')
  })

  it('turns an import failure into an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parity-prompts-'))
    const file = join(dir, 'prompts.mjs')
    writeFileSync(file, 'throw new Error("cannot load")\n')
    await expect(loadTsPrompts(file)).rejects.toThrow('cannot load')
  })
})
