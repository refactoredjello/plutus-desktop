import { describe, expect, it } from 'vitest'
import { bumpPart, isVersion, releaseTagProblem, tagFor } from '../src/lib/version.js'

describe('bumpPart', () => {
  it('accepts patch, minor, and major', () => {
    expect(bumpPart('patch')).toBe('patch')
    expect(bumpPart('minor')).toBe('minor')
    expect(bumpPart('major')).toBe('major')
  })

  it('rejects anything else, including an explicit version, with the usage', () => {
    expect(() => bumpPart(undefined)).toThrow(/patch\|minor\|major/)
    expect(() => bumpPart('1.2.3')).toThrow(/patch\|minor\|major/)
    expect(() => bumpPart('prerelease')).toThrow(/patch\|minor\|major/)
  })
})

describe('isVersion', () => {
  it('accepts plain x.y.z versions', () => {
    expect(isVersion('0.1.0')).toBe(true)
    expect(isVersion('12.30.4')).toBe(true)
  })

  it('rejects prefixes, partial versions, and leading zeros', () => {
    expect(isVersion('v0.1.0')).toBe(false)
    expect(isVersion('0.1')).toBe(false)
    expect(isVersion('01.1.0')).toBe(false)
    expect(isVersion('0.1.0-beta')).toBe(false)
    expect(isVersion('')).toBe(false)
  })
})

describe('tagFor', () => {
  it('prefixes the version with v', () => {
    expect(tagFor('0.2.0')).toBe('v0.2.0')
  })
})

describe('releaseTagProblem', () => {
  it('passes when the tag is v plus the package version', () => {
    expect(releaseTagProblem('v0.1.0', '0.1.0')).toBeNull()
  })

  it('accepts the full ref GitHub Actions gives', () => {
    expect(releaseTagProblem('refs/tags/v0.1.0', '0.1.0')).toBeNull()
  })

  it('names both versions when the tag and package disagree', () => {
    const problem = releaseTagProblem('v0.2.0', '0.1.0')
    expect(problem).toContain('v0.2.0')
    expect(problem).toContain('0.1.0')
  })

  it('rejects tags that are not v<x.y.z>', () => {
    expect(releaseTagProblem('0.1.0', '0.1.0')).toMatch(/v<x\.y\.z>/)
    expect(releaseTagProblem('v0.1', '0.1')).toMatch(/v<x\.y\.z>/)
    expect(releaseTagProblem('', '0.1.0')).toMatch(/v<x\.y\.z>/)
  })
})
